import * as vscode from 'vscode';
import { stripAnsi, detect, programNames, DEFAULT_DENY_LIST, Detection } from './detector';

const TAIL_CHARS = 4000;
const QUIET_MS = 200;
const KEY_GAP_MS = 50;
const REPEAT_WINDOW_MS = 10000;
const AGENTS = ['claude', 'codex', 'gemini', 'amazonq', 'aider', 'generic'];

let enabled = true;
let accepted = 0;
let noShellIntegrationWarned = false;
let statusBar: vscode.StatusBarItem;
let log: vscode.OutputChannel;
let copilotTimer: NodeJS.Timeout | undefined;

const cfg = () => vscode.workspace.getConfiguration('claudeAutoAccept');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (msg: string) => log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

// Compile-check user regexes so one typo is logged and skipped instead of breaking detection.
const warnedPatterns = new Set<string>();
function validRegexes(list: string[], setting: string): RegExp[] {
  return list.flatMap((p) => {
    try {
      return [new RegExp(p, 'i')];
    } catch (e) {
      if (!warnedPatterns.has(p)) {
        warnedPatterns.add(p);
        say(`Skipping invalid regex in claudeAutoAccept.${setting}: ${JSON.stringify(p)} (${(e as Error).message})`);
      }
      return [];
    }
  });
}

// Safety-relevant settings come from USER settings only: a cloned repo's .vscode/settings.json must not be able to
// empty the deny-list or widen what gets auto-answered. (package.json also marks them "scope": "machine".)
const warnedWorkspace = new Set<string>();
function userSetting<T>(key: string, fallback: T): T {
  const i = cfg().inspect<T>(key);
  if ((i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined) && !warnedWorkspace.has(key)) {
    warnedWorkspace.add(key);
    say(`Ignoring workspace value of claudeAutoAccept.${key}: for safety it is only read from user settings`);
  }
  return i?.globalValue ?? fallback;
}

type Opts = { denyList: RegExp[]; agents: Record<string, boolean>; extraPatterns: RegExp[] };
let cachedOpts: Opts | undefined; // cleared on configuration change
function detectOptions(): Opts {
  if (cachedOpts) return cachedOpts;
  const c = cfg();
  const agentCfg = c.get<Record<string, boolean>>('agents', {});
  const agents = Object.fromEntries(AGENTS.map((a) => [a, agentCfg[a] !== false]));
  // Use the detector's list unless the user set one, so package.json's copy of the default can never shadow it.
  return (cachedOpts = {
    denyList: validRegexes(userSetting('denyList', DEFAULT_DENY_LIST), 'denyList'),
    agents,
    extraPatterns: validRegexes(userSetting<string[]>('promptPatterns', []), 'promptPatterns'),
  });
}

function updateStatusBar(): void {
  statusBar.text = `${enabled ? '$(check)' : '$(circle-slash)'} Auto-Accept${enabled ? ` ${accepted}` : ''}`;
  statusBar.backgroundColor = enabled ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  const lines = [
    enabled ? `AI Auto-Accept is ON (${accepted} accepted this session). Click to turn off.` : 'AI Auto-Accept is OFF. Click to turn on.',
  ];
  if (cfg().get<boolean>('dryRun', false)) lines.push('Dry run: prompts are logged, no keys are sent.');
  if (noShellIntegrationWarned) lines.push('Warning: a terminal has no shell integration, so it cannot be watched. See the log.');
  statusBar.tooltip = lines.join('\n');
}

function setEnabled(next: boolean): void {
  enabled = next;
  // Write where the effective value comes from, or a workspace value would override the toggle and snap it back.
  const i = cfg().inspect<boolean>('enabled');
  const T = vscode.ConfigurationTarget;
  const target = i?.workspaceFolderValue !== undefined ? T.WorkspaceFolder : i?.workspaceValue !== undefined ? T.Workspace : T.Global;
  cfg().update('enabled', next, target).then(undefined, (err) => say(`Could not save enabled=${next}: ${(err as Error).message}`));
  say(`Auto-accept ${next ? 'enabled' : 'disabled'}`);
  updateStatusBar();
  syncCopilotPolling();
}

function syncCopilotPolling(): void {
  const want = enabled && cfg().get<boolean>('copilotChat', false);
  if (want && !copilotTimer) {
    copilotTimer = setInterval(() => {
      // No-op when no tool confirmation is pending; errors (e.g. command missing) are ignored.
      vscode.commands.executeCommand('workbench.action.chat.acceptTool').then(undefined, () => undefined);
    }, 1500);
    say('Copilot chat tool auto-accept polling started');
  } else if (!want && copilotTimer) {
    clearInterval(copilotTimer);
    copilotTimer = undefined;
    say('Copilot chat tool auto-accept polling stopped');
  }
}

// The question plus its command block (from the box border above it; for Codex, which has no box, the few lines
// above the question). Used as the prompt's identity for stuck detection and for the host's own deny-list check.
function promptBlock(screen: string, d: Detection): string[] {
  const lines = screen.split('\n').map((l) => l.trim()).filter(Boolean);
  let q = lines.length - 1;
  while (q > 0 && !lines[q].includes(d.prompt)) q--;
  let start = d.agent === 'codex' ? Math.max(0, q - 10) : q;
  if (d.agent !== 'codex') for (let j = q - 1; j >= Math.max(0, q - 60); j--) if (/^[╭┌]?[─━]{3,}/.test(lines[j])) { start = j; break; }
  return lines.slice(start);
}

// Second deny-list pass over the block with box padding removed and wrapped lines rejoined, so a command that
// the agent word-wraps (`git push origin long-branch` / `--force`) or hard-wraps mid-token (`rm -r` / `f /`) is
// still caught. Joining with '' can over-match; that only means we leave a prompt for the user.
function deniedWrapped(block: string[], deny: RegExp[]): RegExp | undefined {
  const body = block.map((l) => l.replace(/[│┃║╭╮╰╯┌┐└┘─━]/g, ' ').trim()).filter(Boolean);
  const texts = [body.join(' '), body.join('')];
  return deny.find((re) => texts.some((t) => re.test(t)));
}

function summary(prompt: string): string {
  const s = prompt.replace(/\s+/g, ' ').trim();
  return JSON.stringify(s.length > 120 ? s.slice(0, 117) + '...' : s);
}

// Only commands that launch an AI agent are watched, so a `[Y/n]` from apt, prisma or npm is never answered.
// The regex is matched against program names only (see programNames), not paths or arguments.
const DEFAULT_AGENT_COMMANDS = '^(claude(-code)?|codex|gemini(-cli)?|q|qchat|aider|copilot|opencode)$';
function isAgentCommand(commandLine: string): boolean {
  const [re] = validRegexes([userSetting('agentCommands', DEFAULT_AGENT_COMMANDS)], 'agentCommands');
  return !!re && programNames(commandLine).some((n) => re.test(n));
}

async function watchExecution(e: vscode.TerminalShellExecutionStartEvent): Promise<void> {
  const stream = e.execution.read(); // must be called immediately or early output is lost
  const commandLine = e.execution.commandLine.value;
  if (!isAgentCommand(commandLine)) return;
  say(`Watching ${JSON.stringify(commandLine)} in terminal "${e.terminal.name}"`);
  const terminal = e.terminal;
  let raw = '';
  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  let ended = false;
  let lastPrompt = '';
  let answers = 0;
  let lastAnswerAt = 0;
  let lastBlocked = '';

  const evaluate = async () => {
    if (!enabled) return;
    if (busy) {
      timer = setTimeout(evaluate, QUIET_MS);
      return;
    }
    const screen = stripAnsi(raw).slice(-TAIL_CHARS);
    const opts = detectOptions();
    let d: Detection | null;
    try {
      d = detect(screen, opts);
    } catch (err) {
      say(`Detector error: ${(err as Error).message}`);
      return;
    }
    if (!d) return;
    const block = d.blocked ? [] : promptBlock(screen, d);
    if (!d.blocked) {
      const hit = deniedWrapped(block, opts.denyList);
      if (hit) d = { ...d, keys: [], blocked: `${hit.source} (across wrapped lines)` };
    }
    if (d.blocked) {
      if (d.prompt !== lastBlocked) {
        lastBlocked = d.prompt;
        say(`BLOCKED [${d.agent}] ${summary(d.prompt)} reason: ${d.blocked} (answer it yourself)`);
      }
      return;
    }
    if (!d.keys.length) return;
    const key = block.join('\n');
    const max = cfg().get<number>('maxRepeat', 3);
    // Same prompt again with no non-prompt output in between = our keys did nothing (any other output resets the
    // count above). Once given up, stay silent until different output appears.
    // A different prompt, or the same one after 10s without seeing it (e.g. `npm test` asked again later), starts a
    // fresh count. Other output in between does not reset it: a prompt that flickers during redraws still hits the cap.
    if (key !== lastPrompt || Date.now() - lastAnswerAt > REPEAT_WINDOW_MS) answers = 0;
    else if (answers >= max) {
      if (answers === max) say(`GIVING UP [${d.agent}] ${summary(d.prompt)}: prompt reappeared after ${max} answers; waiting for different output`);
      answers = max + 1;
      lastAnswerAt = Date.now(); // keep the window open while it keeps redrawing, so we stay given up
      return;
    }
    const dry = cfg().get<boolean>('dryRun', false);
    say(`${dry ? 'DRY RUN would send' : 'ACCEPT'} [${d.agent}] ${summary(d.prompt)} keys: ${JSON.stringify(d.keys.join(''))}`);
    lastPrompt = key;
    lastAnswerAt = Date.now();
    answers++;
    raw = '';
    if (dry) return;
    busy = true;
    try {
      for (let i = 0; i < d.keys.length; i++) {
        if (i) await sleep(KEY_GAP_MS);
        if (ended || terminal.exitStatus) return; // agent exited mid-send: don't type into the shell
        terminal.sendText(d.keys[i], false);
      }
      accepted++;
      updateStatusBar();
    } finally {
      busy = false;
    }
  };

  try {
    for await (const chunk of stream) {
      raw += chunk; // keep raw so ANSI split across chunks strips cleanly
      if (raw.length > TAIL_CHARS * 2) {
        // Cut at a line break so we never keep half an escape sequence (stray "[31m" text).
        const nl = raw.indexOf('\n', raw.length - TAIL_CHARS * 2);
        raw = nl < 0 ? raw.slice(-TAIL_CHARS * 2) : raw.slice(nl + 1);
      }
      clearTimeout(timer);
      timer = setTimeout(evaluate, QUIET_MS);
    }
  } finally {
    ended = true;
    clearTimeout(timer);
  }
}

function checkShellIntegration(terminal: vscode.Terminal): void {
  setTimeout(() => {
    if (noShellIntegrationWarned || terminal.shellIntegration || terminal.exitStatus) return;
    noShellIntegrationWarned = true;
    say(`Terminal "${terminal.name}" has no shell integration after 10s, so its output cannot be read and prompts in it will not be auto-accepted. ` +
      'Enable "terminal.integrated.shellIntegration.enabled" and use bash, zsh, fish or pwsh.');
    updateStatusBar();
  }, 10000);
}

async function configureNativeAutoApprove(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Turn on native auto-approve for chat panels?',
    {
      modal: true,
      detail:
        'This updates your USER settings:\n\n' +
        '• chat.tools.global.autoApprove = true: GitHub Copilot agent mode runs tools (including terminal commands) without asking.\n' +
        '• claudeCode.initialPermissionMode = "acceptEdits": the Claude Code panel accepts file edits without asking (commands still prompt).\n\n' +
        'These panels are webviews that terminal watching cannot see. The deny-list does NOT apply to them. You can revert both settings in Settings at any time.',
    },
    'Apply',
  );
  if (choice !== 'Apply') return;
  // Each setting is applied on its own: one missing extension (unregistered setting) must not hide the other's result.
  const results = await Promise.all(
    ([['chat.tools.global', 'autoApprove', true], ['claudeCode', 'initialPermissionMode', 'acceptEdits']] as const).map(
      async ([section, key, value]) => {
        try {
          await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
          return `${section}.${key} = ${JSON.stringify(value)}: set`;
        } catch (err) {
          return `${section}.${key}: NOT set (${(err as Error).message}; is that extension installed?)`;
        }
      },
    ),
  );
  results.forEach((r) => say(`Native auto-approve: ${r}`));
  const failed = results.some((r) => r.includes('NOT set'));
  (failed ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(`AI Auto-Accept: ${results.join('; ')}`);
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('AI Auto-Accept');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'ai-auto-accept.toggle';
  enabled = cfg().get<boolean>('enabled', true);
  updateStatusBar();
  statusBar.show();
  syncCopilotPolling();
  say(`Activated; auto-accept is ${enabled ? 'ON' : 'OFF'}${cfg().get<boolean>('dryRun', false) ? ' (dry run)' : ''}`);

  const reg = (id: string, fn: () => unknown) => vscode.commands.registerCommand(id, fn);
  for (const prefix of ['ai-auto-accept', 'claude-auto-accept']) {
    context.subscriptions.push(
      reg(`${prefix}.enable`, () => setEnabled(true)),
      reg(`${prefix}.disable`, () => setEnabled(false)),
      reg(`${prefix}.toggle`, () => setEnabled(!enabled)),
    );
  }

  vscode.window.terminals.forEach(checkShellIntegration);
  context.subscriptions.push(
    log,
    statusBar,
    reg('ai-auto-accept.showLog', () => log.show()),
    reg('ai-auto-accept.configureNativeAutoApprove', configureNativeAutoApprove),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      watchExecution(e).catch((err) => say(`Stopped reading terminal "${e.terminal.name}": ${(err as Error).message}`));
    }),
    vscode.window.onDidOpenTerminal(checkShellIntegration),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeAutoAccept')) return;
      cachedOpts = undefined;
      enabled = cfg().get<boolean>('enabled', true);
      updateStatusBar();
      syncCopilotPolling();
    }),
    { dispose: () => copilotTimer && clearInterval(copilotTimer) },
  );
}

export function deactivate(): void {}
