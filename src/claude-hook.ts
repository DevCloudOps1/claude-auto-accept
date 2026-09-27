// PreToolUse hook for Claude Code (CLI and VS Code panel) and VS Code chat / Copilot. They run it before every tool
// call; printing an "allow" decision skips the permission prompt. Printing nothing leaves the normal flow: the user is
// asked as usual. Standalone on purpose: the extension copies this file next to state.json in its global storage folder.
import * as fs from 'fs';
import * as path from 'path';

type Target = 'claude' | 'copilot';
type State = { claude?: boolean; copilot?: boolean; deny: string[] };

export function decide(input: { tool_name?: string; tool_input?: unknown }, state: State, target: Target = 'claude'): 'allow' | 'ask' {
  // The deny-list always applies: destructive commands (DROP TABLE, rm -rf, ...) go to the user.
  if (!state[target]) return 'ask';
  const text = JSON.stringify(input.tool_input ?? {});
  const unescaped = text.replace(/\\"/g, '"').replace(/\\\\/g, '\\'); // match commands as typed, not JSON-escaped
  for (const src of state.deny) {
    try {
      if (new RegExp(src, 'i').test(unescaped)) return 'ask';
    } catch {
      // invalid user regex: the extension already logs it
    }
  }
  return 'allow';
}

if (require.main === module) {
  // Claude Code's hook command passes no argument.
  const target: Target = process.argv[2] === 'copilot' ? 'copilot' : 'claude';
  let raw = '';
  process.stdin.on('data', (c) => (raw += c)).on('end', () => {
    try {
      const state: State = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
      if (decide(JSON.parse(raw), state, target) === 'allow') {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'AI Auto-Accept' } }));
      }
    } catch {
      // No state (extension uninstalled or never set up) or bad input: stay out of the way, the user is asked as usual.
    }
  });
}
