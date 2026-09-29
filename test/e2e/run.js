// Launches the real local VS Code with the extension under development and runs e2e/suite.js inside it.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-ud-'));
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'terminal.integrated.defaultProfile.osx': 'bash',
    'terminal.integrated.profiles.osx': { bash: { path: '/bin/bash', args: [] } },
    'terminal.integrated.shellIntegration.enabled': true,
    'workbench.startupEditor': 'none',
    // Treat the fake agent like a real AI CLI; the default list only matches real agent binaries.
    'claudeAutoAccept.agentCommands': '^(claude|codex|fake-agent\\.js)$',
  }));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-ws-'));
  // Never touch the real ~/.claude or ~/.copilot: Claude Code, Copilot and the extension all honour
  // CLAUDE_CONFIG_DIR / COPILOT_HOME.
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-claude-'));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'keep-me', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-own-hook' }] }] } }));
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-copilot-'));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_BIN || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      extensionTestsEnv: { CLAUDE_CONFIG_DIR: claudeDir, COPILOT_HOME: copilotDir },
      launchArgs: [ws, '--disable-extensions', '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes'],
    });
  } catch (e) {
    console.error('E2E failed:', e);
    process.exit(1);
  }
})();
