# AI Auto-Accept

A VS Code extension that watches your integrated terminals for permission prompts from AI coding CLIs (Claude Code, Codex, Gemini, Amazon Q, Aider, and plain `[Y/n]` prompts) and answers them for you, unless the command matches a dangerous-command deny-list.

It only acts on prompts it recognises. Ordinary output that happens to contain a question ("Do you want to know more?") is ignored.

## Supported agents

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
- **Deny-list (on by default).** A prompt whose text matches any `claudeAutoAccept.denyList` regex is never answered. The patterns are also checked against the command box with its wrapped lines rejoined, so a long command the agent wraps (`git push origin my-branch` on one line, `--force` on the next) is still caught. The log records which pattern matched, and you answer the prompt yourself. The default list covers recursive `rm` (`-r`, `-R`, `-rf`, `--recursive`, flags in any order), `git push --force`/`+refspec`, `find -delete`, `curl … | sh/python/node`, `git push --force`, `git reset --hard`, `git clean -f`, `dd of=`, destructive database commands (`DROP`, `TRUNCATE`, `DELETE FROM`, `UPDATE … SET` without `WHERE`, `ALTER TABLE … DROP`, `dropdb`, Mongo `drop()`/`deleteMany({})`, Redis `FLUSHALL`, `prisma migrate reset`, `rails db:drop`, `artisan migrate:fresh`, `manage.py flush`, `supabase db reset`), infrastructure teardown (`terraform destroy`, `kubectl delete`, `helm uninstall`, `aws s3 rm --recursive`, `aws … delete-*`, `docker volume prune`), `mkfs`, `chmod 777`, `writes to raw disks, and fork bombs. The deny-list is a safety net, not a sandbox: a command written in a way the patterns don't cover will still be accepted.
- **Dry run.** Set `claudeAutoAccept.dryRun` to log what would be sent without sending anything.
- **Per-agent switches.** You can turn off any agent under `claudeAutoAccept.agents`.
- **Toggle.** Click the status bar item, or use **AI Auto-Accept: Toggle**.

## Chat panels

The VS Code chat (GitHub Copilot agent mode) and the Claude Code panel are not terminals, so the extension can't read their prompts. Run **AI Auto-Accept: Set Up Chat Auto-Approve** instead and pick a level:

| Level | VS Code chat / Copilot | Claude Code panel (and `claude` CLI) |
| --- | --- | --- |
| **Recommended** | Sets `chat.tools.terminal.enableAutoApprove`, and `chat.tools.terminal.autoApprove` with `"/.*/": true` plus one deny rule per deny-list entry. Also raises `chat.agent.maxRequests` to 200. | Adds a `PreToolUse` hook to `~/.claude/settings.json`. It approves every tool call (commands, edits, fetches, MCP tools) **except deny-listed ones, which Claude asks you about as usual**. |
| **Everything** | Also sets `chat.tools.global.autoApprove` (every chat, including open ones; VS Code asks once to confirm), `chat.permissions.default = "autoApprove"` and `chat.defaultConfiguration.approvals = "allowAll"`. **No deny-list.** Also raises `chat.agent.maxRequests` to 1000. | Same hook: the deny-list **still applies**. |
| **Undo** | Puts back your previous values. | Removes only this extension's hook entry. Your other Claude settings and hooks are kept. |

**How the Claude Code hook works:**
- It works in the panel and the CLI, and sessions that are already open pick it up.
- It follows the status-bar on/off switch and the `agents.claude` setting.
- It runs with VS Code's built-in Node runtime, so Node doesn't need to be installed. On Windows, `node` must be on PATH.
- It respects `CLAUDE_CONFIG_DIR` if you've set it.

After choosing a level, start a new VS Code chat session, because open chats keep their approval mode (except under "Everything"). If your organisation's policy disables auto-approve, VS Code ignores these settings.

## Settings

```jsonc
{
  "claudeAutoAccept.enabled": true,
  "claudeAutoAccept.agents": { "claude": true, "codex": true, "gemini": true, "amazonq": true, "aider": true, "generic": true },
  "claudeAutoAccept.denyList": ["\\brm\\s+(-\\S+\\s+)*-[a-zA-Z]*(r[a-zA-Z]*f|f[a-zA-Z]*r)", "..."],
  "claudeAutoAccept.promptPatterns": [],   // extra regexes, answered with y + Enter
  "claudeAutoAccept.dryRun": false,
  "claudeAutoAccept.maxRepeat": 3
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
npm run compile
npm run test:e2e   # launches real VS Code against test/fake-agent.js scenarios
```
