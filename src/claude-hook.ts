// Claude Code PreToolUse hook (CLI and VS Code panel). Claude runs it before every tool call; printing an "allow"
// decision skips the permission prompt. Printing nothing leaves Claude's normal flow: it asks the user as usual.
// Standalone on purpose: the extension copies this file next to state.json in its global storage folder.
import * as fs from 'fs';
import * as path from 'path';

type State = { enabled: boolean; level?: 'recommended' | 'everything'; deny: string[] };

export function decide(input: { tool_name?: string; tool_input?: unknown }, state: State): 'allow' | 'ask' {
  // The deny-list applies at every level: destructive commands (DROP TABLE, rm -rf, ...) always go to the user.
  if (!state.enabled || !state.level) return 'ask';
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
  let raw = '';
  process.stdin.on('data', (c) => (raw += c)).on('end', () => {
    try {
      const state: State = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
      if (decide(JSON.parse(raw), state) === 'allow') {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'AI Auto-Accept' } }));
      }
    } catch {
      // No state (extension uninstalled or never set up) or bad input: stay out of the way, Claude asks as usual.
    }
  });
}
