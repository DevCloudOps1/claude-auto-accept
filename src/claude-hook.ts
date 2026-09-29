// Permission hook. Claude Code (CLI and VS Code panel) runs it as a PermissionRequest hook, only when it is about to ask
// the user; VS Code chat / Copilot runs it as a PreToolUse hook before every tool call. Printing an "allow" decision
// answers Yes; printing nothing leaves the question to the user. Standalone on purpose: the extension copies this file
// next to state.json in its global storage folder.
import * as fs from 'fs';
import * as path from 'path';

type Target = 'claude' | 'copilot';
type State = { claude?: boolean; copilot?: boolean; deny: string[] };
type HookInput = { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
// Claude's own questions to the user (multiple choice, plan approval) need the user's answer, not a Yes.
const USER_QUESTIONS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export function decide(input: HookInput, state: State, target: Target = 'claude'): 'allow' | 'ask' {
  // The deny-list always applies: destructive commands (DROP TABLE, rm -rf, ...) go to the user.
  if (!state[target] || USER_QUESTIONS.has(input.tool_name ?? '')) return 'ask';
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
      const input: HookInput = JSON.parse(raw);
      const decision = decide(input, state, target);
      const question = input.hook_event_name === 'PermissionRequest';
      if (decision === 'allow') {
        process.stdout.write(JSON.stringify(question
          ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
          : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'AI Auto-Accept' } }));
      }
      // One line per permission question answered or left to the user, for the extension's status bar counter and log.
      if (question && state[target] && !USER_QUESTIONS.has(input.tool_name ?? '')) {
        const t = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
        const what = `${input.tool_name ?? 'tool'}: ${String(t.command ?? t.file_path ?? JSON.stringify(t))}`.replace(/\s+/g, ' ').slice(0, 160);
        fs.appendFileSync(path.join(__dirname, 'decisions.jsonl'), JSON.stringify({ target, decision, what }) + '\n');
      }
    } catch {
      // No state (extension uninstalled or never set up) or bad input: stay out of the way, the user is asked as usual.
    }
  });
}
