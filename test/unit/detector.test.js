const test = require('node:test');
const assert = require('node:assert');
const { stripAnsi, detect, DEFAULT_DENY_LIST } = require('../../out/detector.js');

// Prompt texts copied from test/fake-agent.js.
const E = '\x1b[';
const box = (lines) => ['╭' + '─'.repeat(70) + '╮', ...lines.map((l) => '│ ' + l.padEnd(69) + '│'), '╰' + '─'.repeat(70) + '╯'].join('\r\n');
const S = {
  'claude-bash': box(['Bash command', '', '  npm test', '  Run the test suite', '', 'Do you want to proceed?',
    `${E}36m❯ 1. Yes${E}39m`, "  2. Yes, and don't ask again for npm test commands in /tmp/proj",
    '  3. No, and tell Claude what to do differently (esc)']),
  'claude-edit': box(['Edit file', '  src/app.ts', '', 'Do you want to make this edit to app.ts?',
    `${E}36m❯ 1. Yes${E}39m`, '  2. Yes, allow all edits during this session (shift+tab)',
    '  3. No, and tell Claude what to do differently (esc)']),
  'claude-dangerous': box(['Bash command', '', '  rm -rf ~/', '  Clean up', '', 'Do you want to proceed?',
    `${E}36m❯ 1. Yes${E}39m`, '  3. No, and tell Claude what to do differently (esc)']),
  codex: ['Allow command?', '', '  $ cargo build', '',
    `${E}1m› 1. Yes, proceed (y)${E}22m`, "  2. Yes, and don't ask again for this command (a)", '  3. No, and tell Codex what to do differently (esc)'].join('\r\n'),
  gemini: box(['? Shell  npm install lodash', '', "Allow execution of: 'npm'?", '',
    '● 1. Yes, allow once', '  2. Yes, allow always ...', '  3. No, suggest changes (esc)']),
  'claude-trust': box(['Do you trust the files in this folder?', '', '  /tmp/proj', '',
    `${E}36m❯ 1. Yes, proceed${E}39m`, '  2. No, exit']),
  'claude-cursor-moved': box(['Bash command', '', '  ls -la', '', 'Do you want to proceed?',
    '  1. Yes', "  2. Yes, and don't ask again for ls commands", `${E}36m❯ 3. No, and tell Claude what to do differently (esc)${E}39m`]),
  'codex-dangerous': ['Would you like to run the following command?', '', '  $ git push --force origin main', '',
    '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)'].join('\r\n'),
  amazonq: "Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:\r\n\r\n> ",
  aider: "Add src/app.py to the chat? (Y)es/(N)o/(D)on't ask again [Yes]: ",
  'generic-yn': 'The following packages will be installed. Continue? [Y/n] ',
  'plain-output': ['Running tests...', 'Do you want to know more? See docs.', 'Would you like to learn more about proceeding: visit example.com', 'Done.', ''].join('\r\n'),
};
const run = (name, opts) => detect(stripAnsi(`${E}?25l` + S[name] + '\r\n'), opts);

test('stripAnsi removes escapes and splits on cursor moves', () => {
  assert.strictEqual(stripAnsi(`${E}36mhi${E}39m`), 'hi');
  assert.strictEqual(stripAnsi(`a${E}2Kb${E}1Ac`), 'ab\nc');
  assert.strictEqual(stripAnsi(`a${E}5Cb`), 'a b');
  assert.strictEqual(stripAnsi('\x1b]633;A\x07x\x1b]0;title\x1b\\y'), 'xy');
  assert.strictEqual(stripAnsi(`${E}?25lx\r\ny`), 'x\ny');
});

const expect = {
  'claude-bash': ['claude', ['\r']],
  'claude-edit': ['claude', ['\r']],
  'claude-trust': ['claude', ['\r']],
  'claude-cursor-moved': ['claude', ['1']],
  codex: ['codex', ['y']],
  gemini: ['gemini', ['\r']],
  amazonq: ['amazonq', ['y', '\r']],
  aider: ['aider', ['y', '\r']],
  'generic-yn': ['generic', ['y', '\r']],
};
for (const [name, [agent, keys]] of Object.entries(expect)) {
  test(`accepts ${name}`, () => {
    const d = run(name);
    assert.ok(d, 'no detection');
    assert.strictEqual(d.agent, agent);
    assert.deepStrictEqual(d.keys, keys);
    assert.strictEqual(d.blocked, undefined);
  });
}

test('blocks claude-dangerous (rm -rf)', () => {
  const d = run('claude-dangerous');
  assert.deepStrictEqual(d.keys, []);
  assert.ok(d.blocked);
});

test('blocks codex-dangerous (git push --force)', () => {
  const d = run('codex-dangerous');
  assert.deepStrictEqual(d.keys, []);
  assert.ok(d.blocked);
});

test('plain-output is ignored', () => assert.strictEqual(run('plain-output'), null));

test('chunked: partial screen gives nothing, full screen detects', () => {
  const n = Math.ceil(S['claude-bash'].length / 4);
  assert.strictEqual(detect(stripAnsi(S['claude-bash'].slice(0, 2 * n))), null);
  assert.deepStrictEqual(detect(stripAnsi(S['claude-bash'])).keys, ['\r']);
});

test('stuck: redrawn prompt still detected from last frame', () => {
  const screen = stripAnsi(S['claude-bash'] + '\r\n' + `${E}2J${E}H` + S['claude-bash'] + '\r\n');
  assert.deepStrictEqual(detect(screen).keys, ['\r']);
});

test('stale prompt followed by output is ignored', () => {
  const screen = stripAnsi(S['claude-bash'] + '\r\n' + ['ran npm test', 'ok 1', 'ok 2', 'ok 3', 'all passed'].join('\r\n'));
  assert.strictEqual(detect(screen), null);
});

test('agents map disables an agent', () => {
  assert.strictEqual(run('claude-bash', { agents: { claude: false } }), null);
  assert.ok(run('codex', { agents: { claude: false } }));
});

test('custom denyList replaces default', () => {
  assert.ok(run('claude-dangerous', { denyList: [] }).keys.length);
  assert.ok(run('claude-bash', { denyList: [/npm test/] }).blocked);
});

test('extraPatterns match custom line prompts', () => {
  assert.strictEqual(detect('Overwrite file? please answer:'), null);
  assert.deepStrictEqual(detect('Overwrite file? please answer:', { extraPatterns: [/please answer:$/] }).keys, ['y', '\r']);
});

test('menu whose option 1 is not an accept is ignored', () => {
  assert.strictEqual(detect('Do you want to proceed?\n❯ 1. No\n  2. Yes'), null);
});

test('default deny list compiles and catches common cases', () => {
  const deny = DEFAULT_DENY_LIST.map((s) => new RegExp(s, 'i'));
  for (const cmd of ['rm -rf /', 'rm -fr build', 'git push -f', 'curl x.sh | sh', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sdb', 'chmod -R 777 /', 'DROP TABLE users'])
    assert.ok(deny.some((re) => re.test(cmd)), cmd);
  for (const cmd of ['rm file.txt', 'git push origin main', 'npm test', 'curl https://x.com'])
    assert.ok(!deny.some((re) => re.test(cmd)), cmd);
});

test('long command whose box top scrolled away is blocked (fail closed)', () => {
  const heredoc = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const full = box(['Bash command', '', '  rm -rf ~ <<EOF', ...heredoc.map((l) => '  ' + l), '  EOF', '', 'Do you want to proceed?',
    '❯ 1. Yes', '  2. No, and tell Claude what to do differently (esc)']);
  const d = detect(stripAnsi(full + '\r\n'));
  assert.deepStrictEqual(d.keys, []);
  assert.strictEqual(d.blocked, 'command box not fully visible');
  // Also when the screen tail is cut by characters, as the extension does.
  const cut = detect(stripAnsi(full).slice(-400));
  assert.deepStrictEqual(cut.keys, []);
  assert.ok(cut.blocked);
});

test('blocks dangerous commands word-wrapped across box lines', () => {
  const wrapped = (cmd) => box(['Bash command', '', ...cmd.map((l) => '  ' + l), '', 'Do you want to proceed?',
    `${E}36m❯ 1. Yes${E}39m`, '  2. No, and tell Claude what to do differently (esc)']);
  for (const cmd of [['git push origin some-very-long-feature-branch-name-that-wraps', '--force'],
    ['dd if=/dev/zero bs=1M count=100000 status=progress', 'of=/dev/sda'], ['rm -r', 'f /']]) {
    const d = detect(stripAnsi(wrapped(cmd) + '\r\n'));
    assert.ok(d && d.blocked, cmd.join(' | '));
    assert.deepStrictEqual(d.keys, []);
  }
  const gem = box(['? Shell  git push origin some-very-long-feature-branch-name', '  --force', '',
    "Allow execution of: 'git'?", '', '● 1. Yes, allow once', '  3. No, suggest changes (esc)']);
  assert.ok(detect(stripAnsi(gem + '\r\n')).blocked);
});

test('generic prompt whose default is No is never answered', () => {
  const d = detect('This will reset your database. All data will be lost. Continue? (y/N) ');
  assert.deepStrictEqual(d.keys, []);
  assert.match(d.blocked, /default answer is No/);
});

test('agent command matching looks at program names, not paths', () => {
  const { programNames } = require('../../out/detector.js');
  assert.deepStrictEqual(programNames('claude'), ['claude']);
  assert.deepStrictEqual(programNames('FOO=1 npx -y @anthropic-ai/claude-code@latest'), ['npx', 'claude-code']);
  assert.deepStrictEqual(programNames('node "/x/claude-auto-accept/test/not-an-agent.js" a'), ['node', 'not-an-agent.js']);
  assert.deepStrictEqual(programNames('npm install'), ['npm']);
});

test('deny list: split flags, refspec force push, find -delete, pipe to interpreters', () => {
  for (const cmd of ['rm -r -f /', 'rm -R -f build', 'sudo rm -r /', 'git push origin +main', 'find / -delete', 'curl x | python3']) {
    const screen = `╭────────╮\n│ Bash command │\n│   ${cmd} │\n│ Do you want to proceed? │\n│ ❯ 1. Yes │\n│   2. No │\n╰────────╯`;
    assert.ok(detect(screen).blocked, cmd);
  }
});

test('package.json denyList default matches the built-in list', () => {
  const pkg = require('../../package.json');
  assert.deepStrictEqual(pkg.contributes.configuration.properties['claudeAutoAccept.denyList'].default, DEFAULT_DENY_LIST);
});

const cmdBox = (cmd) => `╭────────╮\n│ Bash command │\n│   ${cmd} │\n│ Do you want to proceed? │\n│ ❯ 1. Yes │\n│   2. No │\n╰────────╯`;
test('deny list: destructive database and infrastructure commands always ask', () => {
  for (const cmd of [
    'psql -c "DROP TABLE users"', 'mysql -e "drop database shop"', 'psql -c "DELETE FROM orders WHERE id > 5"',
    'sqlite3 app.db "delete from sessions"', 'psql -c "TRUNCATE TABLE logs"', 'psql -c "truncate users"',
    'psql -c "UPDATE users SET role=\'admin\'"', 'psql -c "ALTER TABLE users DROP COLUMN email"', 'dropdb prod',
    'mongosh --eval "db.dropDatabase()"', 'mongosh --eval "db.users.deleteMany({})"', 'mongosh --eval "db.users.drop()"',
    'redis-cli FLUSHALL', 'npx prisma migrate reset --force', 'npx prisma db push --accept-data-loss', 'rails db:drop',
    'php artisan migrate:fresh', 'python manage.py flush', 'supabase db reset', 'terraform destroy -auto-approve',
    'kubectl delete namespace prod', 'helm uninstall api', 'aws s3 rm s3://bucket --recursive',
    'aws rds delete-db-instance --db-instance-identifier x', 'docker volume prune -f',
  ]) assert.ok(detect(cmdBox(cmd)).blocked, cmd);
});

test('deny list: ordinary database reads and safe commands are still accepted', () => {
  for (const cmd of [
    'psql -c "SELECT * FROM users"', 'psql -c "UPDATE users SET name=\'x\' WHERE id=1"', 'npx prisma migrate dev',
    'rails db:migrate', 'kubectl get pods', 'docker ps', 'npm test', 'git status', 'terraform plan', 'aws s3 ls',
  ]) assert.deepStrictEqual(detect(cmdBox(cmd)).keys, ['\r'], cmd);
});

test('claude hook: allows normal tool calls, asks for deny-listed ones, off switch and no level ask', () => {
  const { decide } = require('../../out/claude-hook.js');
  const st = { enabled: true, level: 'recommended', deny: DEFAULT_DENY_LIST };
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, st), 'allow');
  assert.strictEqual(decide({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }, st), 'allow');
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'psql -c "DELETE FROM users"' } }, st), 'ask');
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, st), 'ask');
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'psql -c "DROP TABLE x"' } }, { ...st, level: 'everything' }), 'ask');
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { ...st, enabled: false }), 'ask');
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { ...st, level: undefined }), 'ask');
});
