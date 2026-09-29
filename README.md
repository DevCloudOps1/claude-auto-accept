# AI Auto-Accept

Stop clicking "Yes". AI Auto-Accept answers the permission questions AI coding agents ask ("Allow this bash command?", "Do you want to make this edit?") for you: in the **Claude Code chat panel**, and in AI CLIs running in VS Code terminals (Claude Code, Codex, Gemini, Amazon Q, Aider). Dangerous commands (`rm -rf`, `git push --force`, `DROP TABLE`, `terraform destroy`, ...) are never answered: those questions are always left to you.

## Quick start

### Claude Code chat panel

1. Install **AI Auto-Accept** and the **Claude Code** extension.
2. Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux), run **AI Auto-Accept: Set Up Chat Auto-Approve** and pick **Recommended**.
   To set up only the Claude Code part, add `"claudeAutoAccept.claudePanel": true` to your **User** settings instead.
3. Use Claude as usual. When Claude is about to ask for permission, the question is answered Yes for you, so the command or edit just runs.

Claude asks most in **Manual** mode (before almost every edit and command), so that is where you see the most answered for you. In **Auto** mode, Claude's own safety check decides and rarely asks.

The answer comes from a hook saved in `~/.claude/settings.json`, so it also answers the `claude` CLI in any terminal, even while VS Code is closed. It keeps the on/off state you last set in VS Code.

### AI CLIs in a terminal

Nothing to set up. Run `claude`, `codex`, `gemini`, `q` or `aider` in a VS Code terminal, and their permission prompts are answered for you. The terminal needs shell integration, which is on by default for bash, zsh, fish and PowerShell.

### How to tell it's working

- The status bar (bottom right) shows **`✓ Auto-Accept 3`**. The number is how many questions were answered for you since the window opened.
- Run **AI Auto-Accept: Show Log** to see each one, for example `ACCEPT [Claude Code] "Bash: npm test"`.
- A dangerous command still asks you, and the log says why: `BLOCKED [Claude Code] "Bash: rm -rf build" (deny-list: answer it yourself)`.

### Turn it off

- Click **Auto-Accept** in the status bar, or run **AI Auto-Accept: Toggle**. While it is off, nothing is answered for you, in the Claude chat or in terminals.
- To remove the Claude Code hook completely, run **AI Auto-Accept: Set Up Chat Auto-Approve** and pick **Undo**, or set `claudeAutoAccept.claudePanel` to `false`.

### Troubleshooting

| What you see | What to do |
| --- | --- |
| Claude keeps asking and the counter stays at 0 | Check that `claudeAutoAccept.claudePanel` is `true` in your **User** settings (workspace settings are ignored for safety) and that the status bar shows ✓. The log says `Claude Code hook installed` when the hook is in place. |
| Claude still asks about one command | It matched the deny-list (the log says `BLOCKED`). This is on purpose: answer it yourself. |
| Claude asks a multiple-choice question or wants a plan approved | These are Claude's questions to you, not permission prompts, and are always left to you. |
| A terminal agent's prompt is not answered | The terminal needs shell integration, and the command must match `claudeAutoAccept.agentCommands`. Agents started before the extension finished loading are not watched: restart the agent. |

### Upgrading from 0.1.6

0.1.6 swapped the Claude Code chat support for a "chat auto-click" setting that could not reach the Claude Code panel. From 0.1.8 the hook is back. If you turned on chat auto-click in 0.1.6, run **AI Auto-Accept: Set Up Chat Auto-Approve → Recommended** again, or set `claudeAutoAccept.claudePanel` to `true`. You can delete the leftover `claudeAutoAccept.chatPanel` setting.

## Supported agents (terminal)

The extension only acts on prompts it recognises. Ordinary output that happens to contain a question ("Do you want to know more?") is ignored.

| Agent (setting key) | Prompts recognised | Keys sent |
| --- | --- | --- |
| Claude Code CLI (`claude`) | "Do you want to proceed?", "Do you want to make this edit to …?", "Do you trust the files in this folder?" | Enter when `❯` is on option 1, otherwise `1` |
| Codex CLI (`codex`) | "Allow command?", "Would you like to run the following command?", "Would you like to make the following edits?" | `y` |
| Gemini CLI (`gemini`) | "Allow execution of …?", "Apply this change?" | Enter or `1` |
| Amazon Q CLI (`amazonq`) | "Allow this action? … [y/n/t]:" | `y`, Enter |
| Aider (`aider`) | "… (Y)es/(N)o … [Yes]:" | `y`, Enter |
| Generic (`generic`) | Line prompts ending in `[Y/n]`, `(y/n)`, `[yes/no]`, plus your own `promptPatterns` (never `[y/N]`: default-No prompts are left to you) | `y`, Enter |

Chat panels (GitHub Copilot agent mode, the Claude Code VS Code panel) are webviews, not terminals. See [Chat panels](#chat-panels).

## How it works

1. VS Code's shell integration API (`onDidStartTerminalShellExecution`) streams the output of every command you run in a terminal, such as `claude` or `codex`.
2. The extension keeps the last ~4000 characters with ANSI escape codes removed. Once the output has been quiet for about 200 ms, it checks the text for a known prompt.
3. If it finds one and the prompt text doesn't match the deny-list, it sends the keys shown above to the terminal. The status bar counter goes up by one.
4. If the same prompt keeps coming back (a stuck prompt), the extension answers it at most `maxRepeat` times (3 by default), then stays quiet until a different prompt appears or that prompt has been gone for 10 s.

Every decision (accepted, blocked, gave up, dry run) is written to the **AI Auto-Accept** output channel. Run **AI Auto-Accept: Show Log** to open it.

## Safety

- **User settings only.** `denyList`, `agentCommands` and `promptPatterns` are read from your user settings only. A repository's `.vscode/settings.json` cannot switch off the deny-list or widen what gets answered.
- **Deny-list (on by default).** A prompt whose text matches any `claudeAutoAccept.denyList` regex is never answered. The patterns are also checked against the command box with its wrapped lines rejoined, so a long command the agent wraps (`git push origin my-branch` on one line, `--force` on the next) is still caught. The log records which pattern matched, and you answer the prompt yourself. The default list covers recursive `rm` (`-r`, `-R`, `-rf`, `--recursive`, flags in any order), `git push --force`/`+refspec`, `find -delete`, `curl … | sh/python/node`, `git reset --hard`, `git clean -f`, `dd of=`, destructive database commands (`DROP`, `TRUNCATE`, `DELETE FROM`, `UPDATE … SET` without `WHERE`, `ALTER TABLE … DROP`, `dropdb`, Mongo `drop()`/`deleteMany({})`, Redis `FLUSHALL`, `prisma migrate reset`, `rails db:drop`, `artisan migrate:fresh`, `manage.py flush`, `supabase db reset`), infrastructure teardown (`terraform destroy`, `kubectl delete`, `helm uninstall`, `aws s3 rm --recursive`, `aws … delete-*`, `docker volume prune`), `mkfs`, `chmod 777`, writes to raw disks, and fork bombs. The deny-list is a safety net, not a sandbox: a command written in a way the patterns don't cover will still be accepted.
- **Dry run.** Set `claudeAutoAccept.dryRun` to log what would be sent without sending anything.
- **Per-agent switches.** You can turn off any agent under `claudeAutoAccept.agents`.
- **Toggle.** Click the status bar item, or use **AI Auto-Accept: Toggle**.

## Chat panels

The VS Code chat (GitHub Copilot agent mode) and the Claude Code panel are not terminals, so the extension can't read their prompts. Run **AI Auto-Accept: Set Up Chat Auto-Approve** instead and pick a level:

| Level | VS Code chat / Copilot | Claude Code panel (and `claude` CLI) |
| --- | --- | --- |
| **Recommended** | Sets `chat.tools.terminal.enableAutoApprove`, and `chat.tools.terminal.autoApprove` with `"/.*/": true` plus one deny rule per deny-list entry. Also raises `chat.agent.maxRequests` to 200 and turns on `claudeAutoAccept.claudePanel` (below). | Adds a `PermissionRequest` hook to `~/.claude/settings.json`. Whenever Claude is about to ask for permission (commands, edits, fetches, MCP tools), the hook answers Yes, **except for deny-listed ones, which Claude asks you about as usual**. Claude's own questions to you (multiple choice, plan approval) are always left to you. |
| **Everything** | Also sets `chat.tools.global.autoApprove` (every chat, including open ones; VS Code asks once to confirm), `chat.permissions.default = "autoApprove"` and `chat.defaultConfiguration.approvals = "allowAll"`. **No deny-list.** Also raises `chat.agent.maxRequests` to 1000. | Same hook: the deny-list **still applies**. |
| **Undo** | Puts back your previous values, including `claudeAutoAccept.claudePanel`. | Removes only this extension's hook entry. Your other Claude settings and hooks are kept. |

Recommended only turns on the terminal-tool rules and the Claude Code hook; it does **not** turn on `claudeAutoAccept.copilotPanel` (below), since VS Code's own terminal auto-approve already covers most Copilot chat tool calls. Turn that setting on yourself for full tool-level coverage (file edits, MCP tools, ...) in Copilot chat too.

**How the hooks work (Claude Code panel/CLI: `PermissionRequest`; VS Code chat/Copilot: `PreToolUse`):**
- They work in already-open sessions, not just new ones.
- They follow the status-bar on/off switch, `agents.claude` (Claude) and dry run.
- Each Claude Code question answered Yes adds one to the status bar counter and is logged as `ACCEPT [Claude Code] …` in the **AI Auto-Accept** output channel. Deny-listed ones are logged as `BLOCKED` and left to you.
- They run with VS Code's built-in Node runtime, so Node doesn't need to be installed. On Windows, `node` must be on PATH.
- The Claude hook respects `CLAUDE_CONFIG_DIR` if you've set it; the Copilot hook respects `COPILOT_HOME`.

After choosing a level, start a new VS Code chat session, because open chats keep their approval mode (except under "Everything"). If your organisation's policy disables auto-approve, VS Code ignores these settings.

### Claude Code panel opt-in (without "Set Up Chat Auto-Approve")

Set `claudeAutoAccept.claudePanel` to `true` directly to install just the `PermissionRequest` hook described above, without touching any `chat.*` settings.

### VS Code chat / Copilot panel opt-in

Set `claudeAutoAccept.copilotPanel` to `true` to install a `PreToolUse` hook at `~/.copilot/hooks/ai-auto-accept.json`. It approves every tool call in VS Code chat / GitHub Copilot agent mode (including file edits and MCP tools, not just terminal commands) **except deny-listed ones**, which are left for you to answer.


## Settings

```jsonc
{
  "claudeAutoAccept.enabled": true,
  "claudeAutoAccept.agents": { "claude": true, "codex": true, "gemini": true, "amazonq": true, "aider": true, "generic": true },
  "claudeAutoAccept.denyList": [ /* built-in list, see Safety */ ],
  "claudeAutoAccept.agentCommands": "^(claude(-code)?|codex|gemini(-cli)?|q|qchat|aider|copilot|opencode)$",
  "claudeAutoAccept.promptPatterns": [],   // extra regexes, answered with y + Enter
  "claudeAutoAccept.dryRun": false,
  "claudeAutoAccept.maxRepeat": 3,
  "claudeAutoAccept.claudePanel": false,   // opt-in; PermissionRequest hook, deny-list still applies
  "claudeAutoAccept.copilotPanel": false   // opt-in; PreToolUse hook, deny-list still applies
}
```

The extension logs and skips any invalid regex in `denyList` or `promptPatterns`. If you set `denyList` yourself, your list replaces the default, so copy the default entries into it if you want to keep them.

## Commands

- AI Auto-Accept: Enable / Disable / Toggle (the legacy `claude-auto-accept.*` commands still work)
- AI Auto-Accept: Show Log
- AI Auto-Accept: Set Up Chat Auto-Approve

## Limitations

- **Only AI agent commands are watched.** A terminal command is watched only if it matches `claudeAutoAccept.agentCommands` (the program name, by default `claude`, `claude-code`, `codex`, `gemini`, `q`, `qchat`, `aider`, `copilot`, `opencode`; `npx`/`node` launchers are looked through). A `[Y/n]` from `apt`, `npm` or `prisma` is never answered. Prompts whose default is No (`[y/N]`) are never answered, even from agents.
- **Requires shell integration.** This is on by default for bash, zsh, fish and PowerShell. If a terminal has no shell integration after 10 s, the extension logs a warning and adds it to the status bar tooltip. That terminal is not watched.
- Commands that were already running before the extension activated (for example, after a window reload) are missed. Restart the agent to fix this.
- Detection is pattern-based. A new CLI version that rewords its prompts may stop being recognised until the patterns are updated. Use `promptPatterns` in the meantime.
- Chat panels are covered through their own approval settings and the Claude Code hook, described in [Chat panels](#chat-panels).
- Requires VS Code 1.93 or later.

## Development

```bash
npm install
npm run test:unit  # compiles, then runs the detector and hook unit tests
npm run test:e2e   # launches real VS Code against test/fake-agent.js scenarios
```
