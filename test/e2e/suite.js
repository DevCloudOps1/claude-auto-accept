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
  ['chunked', 'accept'], ['stuck', 'capped'],
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
  const agent = path.resolve(__dirname, '../fake-agent.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-res-'));
  const results = [];
  for (const [scenario, expect] of CASES) {
    const term = vscode.window.createTerminal({ name: `e2e-${scenario}` });
    term.show();
    const si = term.shellIntegration || await new Promise((res) => {
      const d = vscode.window.onDidChangeTerminalShellIntegration((e) => { if (e.terminal === term) { d.dispose(); res(e.shellIntegration); } });
      setTimeout(() => res(undefined), 8000);
    });
    const out = path.join(tmp, scenario + '.json');
    term.sendText(`node "${agent}" ${scenario} "${out}"`, true);
    const r = await waitFor(out, 10000);
    const keys = r ? r.keys : null;
    const accepted = !!keys && (ACCEPT_KEYS[scenario] || []).some((k) => trimKeys(keys) === trimKeys(k));
    // 'capped': answered at least once, but must give up (<=3 presses) on a prompt that never goes away.
    const pass = expect === 'accept' ? accepted : expect === 'capped' ? !!r && r.presses >= 1 && r.presses <= 3 : r !== null && keys === '';
    results.push({ scenario, expect, shellIntegration: !!si, keys, presses: r && r.presses, ms: r && r.ms, pass });
    term.dispose();
    await sleep(300);
  }
  const outFile = process.env.E2E_RESULTS || path.resolve(__dirname, 'results.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.log(`E2E ${passed}/${results.length} passed`);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.scenario} expect=${r.expect} keys=${JSON.stringify(r.keys)} si=${r.shellIntegration} ms=${r.ms}`);
  if (passed !== results.length) throw new Error(`${results.length - passed} e2e scenario(s) failed`);
};
