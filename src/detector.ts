// Pure prompt detection for AI CLI permission prompts. No 'vscode' import so it can be unit tested.

export interface Detection { agent: string; keys: string[]; prompt: string; blocked?: string }

export const DEFAULT_DENY_LIST: string[] = [
  "\\brm\\s+(\\S+\\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--no-preserve-root)\\b",
  "\\bgit\\s+push\\b.*(--force|\\s-f\\b|\\s\\+\\S)",
  "\\bgit\\s+reset\\s+--hard",
  "\\bgit\\s+clean\\s+-[a-zA-Z]*f",
  "\\bfind\\b.*\\s-delete\\b",
  "\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?((ba|z|da|fi)?sh|python\\d*|node|perl|ruby)\\b",
  "\\bdd\\s+.*\\bof=",
  "\\bmkfs\\b",
  "\\bchmod\\s+(-\\S+\\s+)*777",
  "\\bdrop\\s+(table|database|schema)\\b",
  ">\\s*/dev/(sd|nvme|disk)",
  ":\\(\\)\\s*\\{.*\\};\\s*:",
];

// CSI final bytes that move the cursor to another line (treated as a line break) or along the line (a space).
const LINE_MOVES = 'ABEFHfJd';
const COL_MOVES = 'CGI`';

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, shell-integration marks)
    .replace(/\x1b[P^_X][^\x1b]*\x1b\\/g, '') // DCS/PM/APC/SOS
    .replace(/\x1b\[([0-?]*)[ -\/]*([@-~])/g, (_m, _p, f: string) => (LINE_MOVES.includes(f) ? '\n' : COL_MOVES.includes(f) ? ' ' : ''))
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '') // charset selection
    .replace(/\x1b[@-_]?/g, '') // any other 2-byte escape
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

const MENU_QUESTIONS: [string, RegExp][] = [
  ['codex', /^(Allow command\?|Would you like to (run the following command|make the following edits|apply these changes)\?)$/i],
  ['gemini', /^(Allow execution\b.*|Apply this change)\?$/i],
  ['claude', /^(Do you want to .+|Do you trust the files in this folder)\?$/i],
];

const LINE_PROMPTS: [string, RegExp][] = [
  ['amazonq', /Allow this action\?.*\[y\/n\/t\]:?$/i],
  ['aider', /\(Y\)es\/\(N\)o.*\[(Yes|No)\]:?$/i],
  ['generic', /(\[(y\/n|yes\/no)\]|\((y\/n|yes\/no)\))\s*[:?]?$/i],
];

const OPTION = /^([❯›●▶>]\s*)?(\d+)\.\s+(.*)$/;
const BORDER = /^\s*[╭┌]?[─━]{3,}[╮┐]?\s*$/;
const LOOKBACK = 40;

export function detect(
  screen: string,
  opts: { denyList?: RegExp[]; agents?: Record<string, boolean>; extraPatterns?: RegExp[] } = {},
): Detection | null {
  const raw = screen.split(/\r?\n|\r/).slice(-LOOKBACK);
  const lines = raw.map((l) => l.replace(/[│┃║╭╮╰╯┌┐└┘─━]/g, ' ').trim());
  const deny = opts.denyList ?? DEFAULT_DENY_LIST.map((s) => new RegExp(s, 'i'));

  const finish = (agent: string, keys: string[], prompt: string, from: number): Detection | null => {
    if (opts.agents?.[agent] === false) return null;
    // Agents word-wrap long commands inside their box, so also test the block as one logical line:
    // ' ' rejoins soft wraps at spaces; gluing each adjacent pair rejoins hard wraps mid-token (e.g. "rm -r" / "f /").
    const part = lines.slice(from);
    const joins = [part.join('\n'), part.join(' '), ...part.slice(1).map((l, i) => part[i] + l)];
    const hit = deny.find((re) => joins.some((b) => re.test(b)));
    return hit ? { agent, keys: [], prompt, blocked: hit.source } : { agent, keys, prompt };
  };

  // Last meaningful line, ignoring trailing blanks and bare input carets like "> ".
  let last = lines.length - 1;
  while (last >= 0 && /^[>❯›]?$/.test(lines[last])) last--;
  if (last < 0) return null;

  // Line prompts: must be the final meaningful line.
  const tail = lines[last];
  const extra: [string, RegExp][] = (opts.extraPatterns ?? []).map((re) => ['generic', re]);
  for (const [agent, re] of [...LINE_PROMPTS, ...extra]) {
    if (!re.test(tail)) continue;
    // "[y/N]" means the tool's own default is No: it expects a human to opt in, so never answer it.
    if (/\by\/N\b/.test(tail)) return opts.agents?.[agent] === false ? null : { agent, keys: [], prompt: tail, blocked: 'default answer is No' };
    return finish(agent, ['y', '\r'], tail, Math.max(0, last - 10));
  }

  // Select menus: the last known question, followed by options starting at "1. Yes/Allow",
  // with at most 3 non-option lines after the options (so stale, already-answered prompts are ignored).
  for (let q = last; q >= 0; q--) {
    const m = MENU_QUESTIONS.find(([, re]) => re.test(lines[q]));
    if (!m) continue;
    const opts2 = lines.slice(q + 1, last + 1).map((l, i) => ({ i: q + 1 + i, m: OPTION.exec(l) })).filter((o) => o.m);
    const first = opts2.find((o) => o.m![2] === '1');
    if (!first || !/^(Yes|Allow)/i.test(first.m![3])) return null;
    const trailing = lines.slice(opts2[opts2.length - 1].i + 1, last + 1).filter(Boolean).length;
    if (trailing > 3) return null;
    const agent = m[0];
    // Codex prints the command after the question; Claude/Gemini put it above, inside a box.
    // Fail closed if that box's top border is out of view: the unseen part may hold a dangerous command.
    let start = agent === 'codex' ? q : -1;
    for (let j = q - 1; start < 0 && j >= 0; j--) if (BORDER.test(raw[j])) start = j;
    if (start < 0) {
      if (opts.agents?.[agent] === false) return null;
      return { agent, keys: [], prompt: lines[q], blocked: 'command box not fully visible' };
    }
    const cursor = opts2.find((o) => o.m![1])?.m![2];
    const keys = agent === 'codex' ? ['y'] : cursor === '1' ? ['\r'] : ['1'];
    return finish(agent, keys, lines[q], start);
  }
  return null;
}

// Program names of a shell command line: the first word after any VAR=value prefixes, plus the next word
// while the previous one is a launcher like npx or node. Paths are reduced to basenames, npm versions dropped.
const LAUNCHERS = /^(npx|bunx|pnpx|pnpm|yarn|dlx|exec|node|bun|deno|python3?|uvx|pipx|run|env|sudo)$/;
export function programNames(commandLine: string): string[] {
  const words = (commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
  const names: string[] = [];
  for (const w of words) {
    if (/^\w+=/.test(w) || w.startsWith('-')) continue; // env assignment or launcher flag
    const base = w.split('/').pop()!.replace(/@[^@]*$/, '') || w; // "@openai/codex@latest" -> "codex"
    names.push(base);
    if (!LAUNCHERS.test(base)) break;
  }
  return names;
}
