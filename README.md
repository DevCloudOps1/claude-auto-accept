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
- **Deny-list (on by default).** A prompt whose text matches any `claudeAutoAccept.denyList` regex is never answered. The patterns are also checked against the command box with its wrapped lines rejoined, so a long command the agent wraps (`git push origin my-branch` on one line, `--force` on the next) is still caught. The log records which pattern matched, and you answer the prompt yourself. The default list covers recursive `rm` (`-r`, `-R`, `-rf`, `--recursive`, flags in any order), `git push --force`/`+refspec`, `find -delete`, `curl … | sh/python/node`, `git push --force`, `git reset --hard`, `git clean -f`, `dd of=`, `mkfs`, `chmod 777`, `DROP TABLE/DATABASE`, writes to raw disks, and fork bombs. The deny-list is a safety net, not a sandbox: a command written in a way the patterns don't cover will still be accepted.
- **Dry run.** Set `claudeAutoAccept.dryRun` to log what would be sent without sending anything.
- **Per-agent switches.** You can turn off any agent under `claudeAutoAccept.agents`.
- **Toggle.** Click the status bar item, or use **AI Auto-Accept: Toggle**.

## Chat panels

Terminal watching can't see webview chat UIs. You have two options:

- **AI Auto-Accept: Configure Native Auto-Approve** asks for confirmation, then sets these user settings:
  - `chat.tools.global.autoApprove = true`: Copilot agent mode runs tools without asking.
  - `claudeCode.initialPermissionMode = "acceptEdits"`: the Claude Code panel accepts file edits.

  Each setting is written separately. If Copilot Chat or the Claude Code extension isn't installed, its setting is skipped and the result is shown in the notification and log.
- `claudeAutoAccept.copilotChat = true` runs `workbench.action.chat.acceptTool` every 1.5 s, which accepts any pending Copilot tool confirmation.

The deny-list does **not** apply to either option.

## Settings

```jsonc
{
  "claudeAutoAccept.enabled": true,
  "claudeAutoAccept.agents": { "claude": true, "codex": true, "gemini": true, "amazonq": true, "aider": true, "generic": true },
  "claudeAutoAccept.denyList": ["\\brm\\s+(-\\S+\\s+)*-[a-zA-Z]*(r[a-zA-Z]*f|f[a-zA-Z]*r)", "..."],
  "claudeAutoAccept.promptPatterns": [],   // extra regexes, answered with y + Enter
  "claudeAutoAccept.dryRun": false,
  "claudeAutoAccept.copilotChat": false,
  "claudeAutoAccept.maxRepeat": 3
}
```

The extension logs and skips any invalid regex in `denyList` or `promptPatterns`. If you set `denyList` yourself, your list replaces the default, so copy the default entries into it if you want to keep them.

## Commands

- AI Auto-Accept: Enable / Disable / Toggle (the legacy `claude-auto-accept.*` commands still work)
- AI Auto-Accept: Show Log
- AI Auto-Accept: Configure Native Auto-Approve

## Limitations

- **Only AI agent commands are watched.** A terminal command is watched only if it matches `claudeAutoAccept.agentCommands` (the program name, by default `claude`, `claude-code`, `codex`, `gemini`, `q`, `qchat`, `aider`, `copilot`, `opencode`; `npx`/`node` launchers are looked through). A `[Y/n]` from `apt`, `npm` or `prisma` is never answered. Prompts whose default is No (`[y/N]`) are never answered, even from agents.
- **Requires shell integration.** This is on by default for bash, zsh, fish and PowerShell. If a terminal has no shell integration after 10 s, the extension logs a warning and adds it to the status bar tooltip. That terminal is not watched.
- Commands that were already running before the extension activated (for example, after a window reload) are missed. Restart the agent to fix this.
- Detection is pattern-based. A new CLI version that rewords its prompts may stop being recognised until the patterns are updated. Use `promptPatterns` in the meantime.
- Webview chat panels are only covered through the native settings or the Copilot `acceptTool` polling described above.
- Requires VS Code 1.93 or later.

## Development

```bash
npm install
npm run compile
npm run test:e2e   # launches real VS Code against test/fake-agent.js scenarios
```
