import * as vscode from 'vscode';

const DEFAULT_PATTERNS = [
  'allow.*(claude|copilot|amazon q|amazonq|ai).*?(run|execute|command)',
  'approve.*(command|this action|this request)',
  'allow .* to run',
  'allow this command',
  'continue\?',
  'would you like to continue',
  'proceed\?',
  'confirm\?',
  'accept\?',
  'continue.*\[y/n\]|\[y/n\].*continue',
  '.*(yes/no|y/n).*',
  'do you want to continue',
  'are you sure',
  'would you like to proceed',
  'would you like to accept',
  'do you want to proceed',
  '.*(claude|copilot|amazon q|amazonq|ai assistant|coding assistant).*?(continue|proceed|execute|run|allow)'
];

let enabled = true;
let statusBarItem: vscode.StatusBarItem | undefined;

function readPatterns(): RegExp[] {
  const config = vscode.workspace.getConfiguration('claudeAutoAccept');
  const values = config.get<string[]>('promptPatterns', DEFAULT_PATTERNS);
  return values.map((pattern) => new RegExp(pattern, 'i'));
}

function isPromptCandidate(raw: string): boolean {
  const text = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!text) {
    return false;
  }

  const patterns = readPatterns();
  if (patterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  const normalized = text.toLowerCase();
  const hasQuestionMark = /\?/.test(text);
  const hasYesNoChoice = /(\[(?:y\/n|yes\/no)\]|\(y\/n\)|\(yes\/no\)|y\/n|yes\/no|yes or no)/i.test(text);
  const hasConfirmationWords = /(allow|approve|accept|continue|proceed|confirm|execute|run|install|overwrite|delete|save|update|apply)/i.test(text);
  const startsWithQuestion = /^(do you want|would you like|are you sure|can you|can i|is this ok|should i)/i.test(normalized);

  return (hasQuestionMark && hasConfirmationWords && (hasYesNoChoice || startsWithQuestion || /\b(yes|no)\b/i.test(text)));
}

function setEnabled(nextState: boolean): void {
  enabled = nextState;
  const config = vscode.workspace.getConfiguration('claudeAutoAccept');
  config.update('enabled', enabled, vscode.ConfigurationTarget.Global);

  if (statusBarItem) {
    statusBarItem.text = enabled ? '$(check) AI Auto-Accept' : '$(circle-slash) AI Auto-Accept';
    statusBarItem.tooltip = enabled
      ? 'AI Auto-Accept is enabled.'
      : 'AI Auto-Accept is disabled.';
    statusBarItem.backgroundColor = enabled ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.show();
  }
}

function handleTerminalOutput(terminal: vscode.Terminal, data: string): void {
  const config = vscode.workspace.getConfiguration('claudeAutoAccept');
  const allowLocalOverride = config.get<boolean>('forceLocalOverride', true);

  if (!enabled || !allowLocalOverride || !isPromptCandidate(data)) {
    return;
  }

  const acceptanceText = 'y\n';
  setTimeout(() => {
    try {
      terminal.sendText(acceptanceText);
    } catch (error) {
      console.warn('AI Auto-Accept could not send approval:', error);
    }
  }, 150);
}

function monitorTerminal(terminal: vscode.Terminal): void {
  const terminalWithEvents = terminal as vscode.Terminal & {
    onDidWriteData?: (listener: (event: { data: string }) => void) => { dispose: () => void };
  };

  const disposable = terminalWithEvents.onDidWriteData?.((event: { data: string }) => {
    handleTerminalOutput(terminal, event.data);
  });

  vscode.window.onDidCloseTerminal((closed) => {
    if (closed === terminal && disposable) {
      disposable.dispose();
    }
  });
}

function ensureStatusBar(): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'ai-auto-accept.toggle';
    statusBarItem.text = enabled ? '$(check) AI Auto-Accept' : '$(circle-slash) AI Auto-Accept';
    statusBarItem.tooltip = enabled ? 'Disable AI Auto-Accept' : 'Enable AI Auto-Accept';
    statusBarItem.show();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('claudeAutoAccept');
  enabled = config.get<boolean>('enabled', true);

  ensureStatusBar();
  setEnabled(enabled);

  const enableCommand = vscode.commands.registerCommand('ai-auto-accept.enable', () => setEnabled(true));
  const disableCommand = vscode.commands.registerCommand('ai-auto-accept.disable', () => setEnabled(false));
  const toggleCommand = vscode.commands.registerCommand('ai-auto-accept.toggle', () => setEnabled(!enabled));

  const legacyEnable = vscode.commands.registerCommand('claude-auto-accept.enable', () => setEnabled(true));
  const legacyDisable = vscode.commands.registerCommand('claude-auto-accept.disable', () => setEnabled(false));
  const legacyToggle = vscode.commands.registerCommand('claude-auto-accept.toggle', () => setEnabled(!enabled));

  for (const terminal of vscode.window.terminals) {
    monitorTerminal(terminal);
  }

  const monitor = vscode.window.onDidOpenTerminal((terminal) => {
    monitorTerminal(terminal);
  });

  context.subscriptions.push(enableCommand, disableCommand, toggleCommand, legacyEnable, legacyDisable, legacyToggle, monitor, statusBarItem!);
}

export function deactivate(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
