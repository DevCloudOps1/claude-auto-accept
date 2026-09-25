// Runs inside VS Code's extension host. Each scenario starts the fake agent in a real terminal
// and checks which keys (if any) the auto-accept extension sent back.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

// expect: 'accept' = some accepting key was sent; 'none' = nothing must be sent.
const CASES = [
  ['claude-bash', 'accept'], ['claude-edit', 'accept'], ['claude-dangerous', 'none'],
  ['codex', 'accept'], ['gemini', 'accept'], ['amazonq', 'accept'], ['aider', 'accept'],
  ['generic-yn', 'accept'], ['plain-output', 'none'],
  ['claude-trust', 'accept'], ['claude-cursor-moved', 'accept'], ['codex-dangerous', 'none'],
  ['chunked', 'accept'], ['stuck', 'capped'], ['generic-default-no', 'none'],
  // Same accept-worthy prompt, but from a command that is not an AI agent: must be left alone.
  ['generic-yn', 'none', 'not-an-agent.js'],
];
const ACCEPT_KEYS = { 'claude-bash': ['\r', '1'], 'claude-edit': ['\r', '1'], codex: ['\r', 'y', '1'],
  gemini: ['\r', '1'], amazonq: ['y\r', 'y\n', 'y'], aider: ['y\r', 'y\n', '\r'], 'generic-yn': ['y\r', 'y\n', '\r'],
  'claude-trust': ['\r', '1'], 'claude-cursor-moved': ['1'], chunked: ['\r', '1'] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimKeys = (k) => k.replace(/\n$/, '\r');

async function waitFor(file, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); await sleep(100); }
  return null;
}

exports.run = async function () {
  const ext = vscode.extensions.all.find((e) => e.extensionPath === path.resolve(__dirname, '../..'));
  if (ext && !ext.isActive) await ext.activate();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-res-'));
  const results = [];
  for (const [scenario, expect, script = 'fake-agent.js'] of CASES) {
    const term = vscode.window.createTerminal({ name: `e2e-${scenario}` });
    term.show();
    const si = term.shellIntegration || await new Promise((res) => {
      const d = vscode.window.onDidChangeTerminalShellIntegration((e) => { if (e.terminal === term) { d.dispose(); res(e.shellIntegration); } });
      setTimeout(() => res(undefined), 8000);
    });
    const out = path.join(tmp, `${scenario}-${script}.json`);
    const agent = path.resolve(__dirname, '..', script);
    term.sendText(`node "${agent}" ${scenario} "${out}"`, true);
    const r = await waitFor(out, 10000);
    const keys = r ? r.keys : null;
    const accepted = expect === 'accept' && !!keys && (ACCEPT_KEYS[scenario] || []).some((k) => trimKeys(keys) === trimKeys(k));
    // 'capped': answered at least once, but must give up (<=3 presses) on a prompt that never goes away.
    const pass = expect === 'accept' ? accepted : expect === 'capped' ? !!r && r.presses >= 1 && r.presses <= 3 : r !== null && keys === '';
    results.push({ scenario, script, expect, shellIntegration: !!si, keys, presses: r && r.presses, ms: r && r.ms, pass });
    term.dispose();
    await sleep(300);
  }
  // Chat panel auto-approve: the command must write VS Code's own chat settings, and Undo must restore them.
  const conf = () => vscode.workspace.getConfiguration();
  const g = (k) => conf().inspect(k).globalValue;
  const chatCase = (name, pass, detail) => results.push({ scenario: name, script: 'chat', expect: 'settings', keys: detail, pass: !!pass });
  await conf().update('chat.agent.maxRequests', 30, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('ai-auto-accept.configureNativeAutoApprove', 'recommended');
  const rules = g('chat.tools.terminal.autoApprove') || {};
  const denyKey = Object.keys(rules).find((k) => k.includes('git') && k.includes('push'));
  chatCase('chat-recommended', rules['/.*/'] === true && denyKey && rules[denyKey].approve === false && rules[denyKey].matchCommandLine === true
    && g('chat.tools.terminal.enableAutoApprove') === true && g('chat.agent.maxRequests') === 200 && g('chat.permissions.default') === undefined,
    JSON.stringify({ allowAll: rules['/.*/'], denyKey, maxRequests: g('chat.agent.maxRequests'), permissions: g('chat.permissions.default') }));
  await vscode.commands.executeCommand('ai-auto-accept.configureNativeAutoApprove', 'everything');
  chatCase('chat-everything', g('chat.permissions.default') === 'autoApprove' && (g('chat.defaultConfiguration') || {}).approvals === 'allowAll',
    JSON.stringify({ permissions: g('chat.permissions.default'), defaultConfiguration: g('chat.defaultConfiguration') }));
  await vscode.commands.executeCommand('ai-auto-accept.configureNativeAutoApprove', 'undo');
  chatCase('chat-undo', g('chat.tools.terminal.autoApprove') === undefined && g('chat.permissions.default') === undefined
    && g('chat.defaultConfiguration') === undefined && g('chat.agent.maxRequests') === 30,
    JSON.stringify({ rules: g('chat.tools.terminal.autoApprove'), permissions: g('chat.permissions.default'), maxRequests: g('chat.agent.maxRequests') }));

  const outFile = process.env.E2E_RESULTS || path.resolve(__dirname, 'results.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.log(`E2E ${passed}/${results.length} passed`);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.scenario}${r.script === 'fake-agent.js' ? '' : ' via ' + r.script} expect=${r.expect} keys=${JSON.stringify(r.keys)} si=${r.shellIntegration} ms=${r.ms}`);
  if (passed !== results.length) throw new Error(`${results.length - passed} e2e scenario(s) failed`);
};
