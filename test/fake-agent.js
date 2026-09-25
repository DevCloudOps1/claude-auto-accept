// Mimics the permission prompts of real AI CLIs, then records the first keys it receives.
// usage: node fake-agent.js <scenario> <resultFile>
const fs = require('fs');
const [scenario, resultFile] = process.argv.slice(2);
const E = '\x1b[';
const box = (lines) => ['╭' + '─'.repeat(70) + '╮', ...lines.map((l) => '│ ' + l.padEnd(69) + '│'), '╰' + '─'.repeat(70) + '╯'].join('\r\n');

const SCENARIOS = {
  'claude-bash': box(['Bash command', '', '  npm test', '  Run the test suite', '', 'Do you want to proceed?',
    `${E}36m❯ 1. Yes${E}39m`, "  2. Yes, and don't ask again for npm test commands in /tmp/proj",
    '  3. No, and tell Claude what to do differently (esc)']),
  'claude-edit': box(['Edit file', '  src/app.ts', '', 'Do you want to make this edit to app.ts?',
    `${E}36m❯ 1. Yes${E}39m`, "  2. Yes, allow all edits during this session (shift+tab)",
    '  3. No, and tell Claude what to do differently (esc)']),
  'claude-dangerous': box(['Bash command', '', '  rm -rf ~/', '  Clean up', '', 'Do you want to proceed?',
    `${E}36m❯ 1. Yes${E}39m`, '  3. No, and tell Claude what to do differently (esc)']),
  'claude-db-delete': box(['Bash command', '', '  psql $DATABASE_URL -c "DELETE FROM customers WHERE created_at < now()"', '  Clean old rows', '',
    'Do you want to proceed?', `${E}36m❯ 1. Yes${E}39m`, '  2. No, and tell Claude what to do differently (esc)']),
  'codex': [ 'Allow command?', '', '  $ cargo build', '',
    `${E}1m› 1. Yes, proceed (y)${E}22m`, '  2. Yes, and don\'t ask again for this command (a)', '  3. No, and tell Codex what to do differently (esc)'].join('\r\n'),
  'gemini': box(['? Shell  npm install lodash', '', 'Allow execution of: \'npm\'?', '',
    '● 1. Yes, allow once', '  2. Yes, allow always ...', '  3. No, suggest changes (esc)']),
  'claude-trust': box(['Do you trust the files in this folder?', '', '  /tmp/proj', '',
    `${E}36m❯ 1. Yes, proceed${E}39m`, '  2. No, exit']),
  // Cursor sits on "No": pressing Enter would reject, so the extension must pick option 1 explicitly.
  'claude-cursor-moved': box(['Bash command', '', '  ls -la', '', 'Do you want to proceed?',
    '  1. Yes', "  2. Yes, and don't ask again for ls commands", `${E}36m❯ 3. No, and tell Claude what to do differently (esc)${E}39m`]),
  'codex-dangerous': ['Would you like to run the following command?', '', '  $ git push --force origin main', '',
    '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)'].join('\r\n'),
  'amazonq': 'Allow this action? Use \'t\' to trust (always allow) this tool for the session. [y/n/t]:\r\n\r\n> ',
  'aider': 'Add src/app.py to the chat? (Y)es/(N)o/(D)on\'t ask again [Yes]: ',
  'generic-default-no': 'This will reset your database. All data will be lost. Continue? (y/N) ',
  'generic-yn': 'The following packages will be installed. Continue? [Y/n] ',
  // Must NOT be answered: ordinary output that merely contains trigger-ish words.
  'plain-output': [ 'Running tests...', 'Do you want to know more? See docs.', 'Would you like to learn more about proceeding: visit example.com', 'Done.', ''].join('\r\n'),
};

SCENARIOS['chunked'] = SCENARIOS['claude-bash'];
SCENARIOS['stuck'] = SCENARIOS['claude-bash'];
const text = SCENARIOS[scenario];
if (!text) { console.error('unknown scenario ' + scenario); process.exit(2); }
// Ink-like rendering: hide cursor, draw, keep process alive awaiting raw keys.
if (scenario === 'chunked') {
  // Real TUIs flush in pieces; emit the prompt in 4 chunks 60ms apart.
  const n = Math.ceil(text.length / 4);
  [0, 1, 2, 3].forEach((i) => setTimeout(() => process.stdout.write(text.slice(i * n, (i + 1) * n)), i * 60));
} else process.stdout.write(`${E}?25l` + text + '\r\n');
const started = Date.now();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let got = '';
const finish = () => {
  fs.writeFileSync(resultFile, JSON.stringify({ scenario, keys: got, presses, ms: Date.now() - started }));
  process.stdout.write(`${E}?25h`);
  process.exit(0);
};
let presses = 0;
process.stdin.on('data', (d) => {
  got += d.toString(); presses++;
  // 'stuck': an agent that ignores answers and keeps redrawing the same prompt. Count how often we get poked.
  if (scenario === 'stuck') { process.stdout.write(`${E}2J${E}H` + text + '\r\n'); return; }
  setTimeout(finish, 300);
});
setTimeout(finish, Number(process.env.FAKE_AGENT_TIMEOUT || 6000));
