import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  const hooks = hookState();
  if (hooks.copilot) lines.push('VS Code chat / Copilot: every tool call is auto-approved except deny-listed ones.');
  if (hooks.claude) lines.push('Claude Code panel: every tool call is auto-approved except deny-listed ones.');
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
  syncHooks();
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

// Chat panels (VS Code chat / Copilot, Claude Code panel) are not terminals, so they are covered through their own
// approval settings and hooks. Polling 'workbench.action.chat.acceptTool' does not work: it only
// sees the last-focused chat and moves keyboard focus into the chat input on every call.
type ChatLevel = 'recommended' | 'everything' | 'undo';
const BACKUP_KEY = 'chatSettingsBackup';
let extContext: vscode.ExtensionContext;

function chatSettings(level: 'recommended' | 'everything'): [string, unknown][] {
  const g = <T>(key: string) => vscode.workspace.getConfiguration().inspect<T>(key)?.globalValue;
  // VS Code's own terminal rules: "/regex/i": true approves, a false rule always wins. Our deny-list becomes false
  // rules matched against the whole command line, so `rm -rf`, `git push --force`... still ask in chat.
  const deny = Object.fromEntries(userSetting('denyList', DEFAULT_DENY_LIST).map((src) => [`/${src}/i`, { approve: false, matchCommandLine: true }]));
  const out: [string, unknown][] = [
    ['chat.tools.terminal.enableAutoApprove', true],
    ['chat.tools.terminal.autoApprove', { ...g<object>('chat.tools.terminal.autoApprove'), '/.*/': true, ...deny }],
    ['claudeAutoAccept.claudePanel', true],
  ];
  // Avoid the "Continue to iterate?" stop after 50 requests.
  if (level === 'recommended') out.push(['chat.agent.maxRequests', Math.max(g<number>('chat.agent.maxRequests') ?? 0, 200)]);
  if (level === 'recommended') return out;
  out.push(
    // Every chat, including ones already open, approves every tool. VS Code asks the user once to confirm this.
    ['chat.tools.global.autoApprove', true],
    // New chat sessions start in "Bypass Approvals" too.
    ['chat.permissions.default', 'autoApprove'],
    ['chat.defaultConfiguration', { ...g<object>('chat.defaultConfiguration'), approvals: 'allowAll' }],
    ['chat.agent.maxRequests', Math.max(g<number>('chat.agent.maxRequests') ?? 0, 1000)],
  );
  return out;
}

async function writeSetting(key: string, value: unknown): Promise<string> {
  try {
    await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
    return `${key}: ${value === undefined ? 'restored' : 'set'}`;
  } catch (err) {
    return `${key}: NOT set (${(err as Error).message})`;
  }
}

// claudePanel / copilotPanel: a PreToolUse hook approves every tool call except deny-listed ones. Claude Code (panel
// and CLI) reads it from ~/.claude/settings.json, VS Code chat from ~/.copilot/hooks. The hook script and its
// state.json live in the extension's global storage, a path that survives extension updates.
const HOOK_MARK = 'ai-auto-accept-claude-hook';
const claudeSettingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const copilotHookFile = () => path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'hooks', 'ai-auto-accept.json');
const hookDir = () => extContext.globalStorageUri.fsPath;
const hookScript = () => path.join(hookDir(), `${HOOK_MARK}.js`);
// 0.1.3's Set Up Chat Auto-Approve recorded its Claude Code hook as 'chatLevel' instead of setting claudePanel.
const claudeOptIn = () => userSetting('claudePanel', false) || !!extContext.globalState.get('chatLevel');
const copilotOptIn = () => userSetting('copilotPanel', false);

// Read by the hooks before every tool call, so the on/off switch reaches open sessions at once.
function hookState() {
  const agents = cfg().get<Record<string, boolean>>('agents', {});
  const on = enabled && !cfg().get<boolean>('dryRun', false);
  return { claude: on && agents.claude !== false && claudeOptIn(), copilot: on && copilotOptIn(), deny: userSetting('denyList', DEFAULT_DENY_LIST) };
}

function hookCommand(target = ''): string {
  // Run with VS Code's own Node runtime so users don't need Node installed. ponytail: on Windows this needs `node` on PATH.
  const command = process.platform === 'win32' ? `node "${hookScript()}"` : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${hookScript()}"`;
  return target ? `${command} ${target}` : command;
}

// Installs each panel's hook while it is opted in (which also refreshes the command after VS Code moves), removes it
// once it is not, and tells the hooks what to do. Runs on start, on every setting change and on the on/off switch.
function syncHooks(): void {
  const claude = claudeOptIn();
  const copilot = copilotOptIn();
  try {
    fs.mkdirSync(hookDir(), { recursive: true });
    const src = path.join(__dirname, 'claude-hook.js');
    // Keep the installed script in step with this extension version.
    if ((claude || copilot) && !(fs.existsSync(hookScript()) && fs.readFileSync(hookScript()).equals(fs.readFileSync(src)))) fs.copyFileSync(src, hookScript());
    fs.writeFileSync(path.join(hookDir(), 'state.json'), JSON.stringify(hookState()));
  } catch (err) {
    say(`Could not update the hook script: ${(err as Error).message}`);
  }
  for (const r of [editClaudeSettings(claude), editCopilotHook(copilot)]) if (r) say(r);
  updateStatusBar();
}

// Both return undefined when there is nothing to change, and only remove this profile's hook (its command names our
// storage folder): another VS Code profile or editor may have installed its own.
function editCopilotHook(install: boolean): string | undefined {
  const file = copilotHookFile();
  // Copilot CLI reads the same folder (hence "version": 1) and denies every tool call when a hook exits non-zero, so a
  // missing script or runtime must still exit 0.
  const command = hookCommand('copilot') + (process.platform === 'win32' ? '; exit 0' : ' || true');
  const content = JSON.stringify({ version: 1, hooks: { PreToolUse: [{ type: 'command', command }] } }, null, 2) + '\n';
  try {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (install ? current === content : !current.includes(JSON.stringify(hookScript()).slice(1, -1))) return undefined;
    if (install) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    } else fs.rmSync(file);
    return `${file}: VS Code chat / Copilot hook ${install ? 'installed' : 'removed'}`;
  } catch (err) {
    return `${file}: NOT changed (${(err as Error).message})`;
  }
}

type HookEntry = { matcher?: string; hooks?: { command?: string }[] };
function editClaudeSettings(install: boolean): string | undefined {
  const file = claudeSettingsFile();
  let settings: { hooks?: Record<string, HookEntry[]> } = {};
  try {
    if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Never overwrite a settings file we could not parse.
    return `${file}: NOT changed (${(err as Error).message})`;
  }
  const before = JSON.stringify(settings);
  const ours = (e: HookEntry) => !!e.hooks?.some((h) => h.command?.includes(hookScript()));
  const current = settings.hooks?.PreToolUse ?? [];
  const list = current.filter((e) => !ours(e));
  if (!install && list.length === current.length) return undefined;
  if (install) list.push({ matcher: '*', hooks: [{ type: 'command', command: hookCommand() } as { command: string }] });
  settings.hooks = { ...settings.hooks, PreToolUse: list };
  if (!list.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (JSON.stringify(settings) === before) return undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return `${file}: Claude Code hook ${install ? 'installed' : 'removed'}`;
  } catch (err) {
    return `${file}: NOT changed (${(err as Error).message})`;
  }
}

async function configureNativeAutoApprove(arg?: ChatLevel): Promise<void> {
  let level = arg;
  if (!level) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Recommended', level: 'recommended' as const, detail: 'VS Code chat runs terminal commands and Claude Code approves its tools without asking, except anything matching the deny-list (rm -rf, git push --force, ...). Also stops the "Continue to iterate?" pause.' },
        { label: 'Everything (Bypass Approvals)', level: 'everything' as const, detail: 'VS Code chat / Copilot approves every tool call in every chat, including open ones (no deny-list there; VS Code asks you once to confirm). Claude Code still asks for deny-listed commands.' },
        { label: 'Undo', level: 'undo' as const, detail: 'Restore the chat settings you had before using this command.' },
      ],
      { title: 'AI Auto-Accept: chat panel auto-approve', placeHolder: 'Choose what chat panels may approve on their own (changes your user settings)' },
    );
    if (!pick) return;
    level = pick.level;
  }
  const backup = extContext.globalState.get<Record<string, unknown>>(BACKUP_KEY);
  let results: string[];
  if (level === 'undo') {
    if (!backup) return void vscode.window.showInformationMessage('AI Auto-Accept: nothing to undo.');
    results = await Promise.all(Object.entries(backup).map(([k, v]) => writeSetting(k, v ?? undefined)));
    await extContext.globalState.update(BACKUP_KEY, undefined);
    await extContext.globalState.update('chatLevel', undefined);
  } else {
    const settings = chatSettings(level);
    // Remember the values from before our FIRST change, so Undo returns to the user's original state.
    const saved = { ...backup };
    for (const [k] of settings) if (!(k in saved)) saved[k] = vscode.workspace.getConfiguration().inspect(k)?.globalValue ?? null;
    await extContext.globalState.update(BACKUP_KEY, saved);
    results = [];
    for (const [k, v] of settings) results.push(await writeSetting(k, v));
  }
  results.forEach((r) => say(`Chat auto-approve (${level}): ${r}`));
  syncHooks(); // apply claudePanel (and Undo's cleared 0.1.3 chatLevel) before returning
  const failed = results.filter((r) => r.includes('NOT set'));
  const msg = level === 'undo' ? 'Chat settings restored and the Claude Code hook removed.' : level === 'everything' ? 'Everything is auto-approved in all chats. VS Code will ask once to confirm global auto-approve: choose Enable.' : 'Chat auto-approve is set up. Start a NEW VS Code chat session: open ones keep their approval mode.';
  (failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(`AI Auto-Accept: ${msg}${failed.length ? ` Not applied: ${failed.join('; ')}` : ''}`);
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  log = vscode.window.createOutputChannel('AI Auto-Accept');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'ai-auto-accept.toggle';
  enabled = cfg().get<boolean>('enabled', true);
  syncHooks();
  statusBar.show();
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
    vscode.commands.registerCommand('ai-auto-accept.configureNativeAutoApprove', configureNativeAutoApprove),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      watchExecution(e).catch((err) => say(`Stopped reading terminal "${e.terminal.name}": ${(err as Error).message}`));
    }),
    vscode.window.onDidOpenTerminal(checkShellIntegration),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeAutoAccept')) return;
      cachedOpts = undefined;
      enabled = cfg().get<boolean>('enabled', true);
      syncHooks();
    }),
  );
}

export function deactivate(): void {}
