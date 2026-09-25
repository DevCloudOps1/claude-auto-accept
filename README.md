# AI Auto-Accept

A lightweight VS Code extension that watches active terminal output for common approval prompts from AI coding assistants and automatically sends `y` to continue.

It works across Claude, GitHub Copilot, Amazon Q, and other AI tools that ask for confirmation before running commands or continuing a session.

## What it does

- Monitors every terminal you open in VS Code.
- Detects prompt patterns like:
  - `Allow Claude Code to run this command?`
  - `Github Copilot wants to run this command`
  - `Amazon Q wants to execute this action`
  - `Continue? [Y/n]`
  - `Would you like to proceed?`
- Auto-sends `y` to keep working without repeated prompts.

## Controls

- Status bar toggle in the VS Code bottom toolbar
- Command Palette commands:
  - `AI Auto-Accept: Enable`
  - `AI Auto-Accept: Disable`
  - `AI Auto-Accept: Toggle`

## Local override behavior

This extension is designed to override remote-side auto-approve disablement at the local terminal layer. If the AI service or server-side flow refuses to auto-approve, the VS Code terminal can still answer `y` locally when a matching approval prompt appears.

## Configuration

Set the default through VS Code settings:

```json
{
  "claudeAutoAccept.enabled": true,
  "claudeAutoAccept.forceLocalOverride": true,
  "claudeAutoAccept.promptPatterns": [
    "allow.*(claude|copilot|amazon q|ai).*",
    "approve.*command",
    "continue\\?",
    "would you like to proceed",
    "do you want to continue",
    "are you sure",
    "\\[y/n\\]",
    "\\[Y/n\\]"
  ]
}
```

## Development

```bash
npm install
npm run compile
```
