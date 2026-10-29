# aichat — an AI group chat

A terminal orchestrator that puts Claude Code, Codex, and Gemini CLI in one group chat.
It runs each CLI in headless mode, so **no API keys are needed: each agent uses your existing subscription login (Claude Pro, ChatGPT Plus, Gemini)**.

```
› /task add rate limiting to the login API

@claude ← from user
│   ⚙ Read src/auth.js
│   ⚙ Edit src/auth.js
│ Added a rate limit middleware ...
│ @codex verify the src/auth.js change and run the tests
  ↪ handed off to @codex

@codex ← from @claude
│   ⚙ $ npm test
│ One test failed → fixed an off-by-one bug.
│ @user Done: ...
```

## Install

Requires Node.js 20 or later. Install straight from GitHub, no clone needed:

```bash
npm i -g --allow-git=root github:leemyeongje/aichat
```

npm 12 and later refuse git installs unless `--allow-git` is set; older npm versions don't need the flag. Run the same command again to update.

To work on aichat itself, clone the repo and run `npm link` in it instead.

If you don't have Gemini CLI:

```bash
npm i -g @google/gemini-cli && gemini   # log in once
```

Run each CLI (`claude`, `codex`, `gemini`) once beforehand and log in. Agents whose CLI is not installed are shown as not installed and skipped.

## Usage

```bash
cd your-project
aichat              # or: aichat /path/to/project
```

| Input | What it does |
|---|---|
| `message` | Sends to the default agent (claude) |
| `@codex message` | Sends to a specific agent. `@claude @codex ...` and `@all ...` also work |
| `/task description` | Consensus workflow: claude implements ⇄ codex verifies/debugs; reports to @user once both say `[동의]` |
| `/init [name]` | Analyzes the project and writes `AGENTS.md` (by the default agent, or a named one like `/init codex`). Creates a one-line `CLAUDE.md` with `@AGENTS.md` if there is none |
| `/stop`, `Ctrl+C` | Stops the running agent and clears the queue |
| `/agents` | Status, role, and session ID of each agent |
| `/default name` | Changes the default agent |
| `/auto N` | Max automatic agent-to-agent handoffs (default 8, 0 turns it off) |
| `/verbose` | Shows reasoning and detailed logs |
| `/history N` | Replays recent messages |
| `/new` | Resets the conversation and sessions |

You can type while an agent is working. Your message is added to the transcript right away and delivered on the next turn, after the current one finishes.

## How it works

- **Shared transcript**: every message is appended to `.aichat/transcript.jsonl`. Each time an agent is called, it gets the messages since its last turn as the prompt, so everyone sees the same conversation.
- **Per-agent memory**: each agent resumes its own session (`claude --resume`, `codex exec resume`, `gemini --resume`). Session IDs are saved in `.aichat/sessions.json`, so conversations continue after restarting aichat.
- **Handoffs**: a line in an agent's reply that starts with `@name ...` passes the next turn to that agent. Replies that end with `@user` or no mention return to you. If one reply mentions both `@user` and another agent, only the agent handoff is followed and the report to you waits until the agents are done (with `[질문]`, it's the other way around: the agents wait for your answer).
- **Consensus workflow (`/task`)**: whenever one agent changes code, the other reviews the change. The task ends and is reported to you only when both agents' latest replies contain `[동의]` and the last one didn't change code. Earlier attempts to hand off to `@user` are sent back to the other agent (unless they contain `[질문]`). Round trips count against the `/auto` limit. The reviewer (codex) is told on every review turn to critically review the whole change against the original request, not just the part it was asked to check.
- **One at a time**: all agents edit the same directory, so they never run concurrently; they take turns.

`[동의]` ("agree") and `[질문]` ("question") are the literal markers agents write; the agent prompts are in Korean.

## Project instruction files

Each agent reads a different instruction file: Claude Code reads `CLAUDE.md` (or `AGENTS.md` if there's none), Codex reads `AGENTS.md`, and Gemini reads `GEMINI.md`.
To keep a single file, write the instructions in `AGENTS.md` and put just `@AGENTS.md` in `CLAUDE.md`. Typing `/init` in aichat has an agent analyze the project and set this up. When running codex, aichat configures it to read `CLAUDE.md` if there's no `AGENTS.md`.
To make Gemini read `AGENTS.md`, add `{ "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }` to the project's `.gemini/settings.json`.

## Configuration

Override the defaults (`src/config.js`) with `./aichat.config.json` or `~/.aichat/config.json`.

```json
{
  "defaultAgent": "claude",
  "maxAutoTurns": 8,
  "workflow": { "developer": "claude", "reviewer": "codex" },
  "agents": {
    "claude": { "model": "opus" },
    "gemini": { "enabled": false }
  }
}
```

## Permissions warning

Headless mode can't ask for permission, so the defaults are fairly autonomous:

- claude: `--permission-mode acceptEdits` plus Bash/edit tools allowed
- codex: `sandbox_mode="workspace-write"` (blocks writes outside the working folder)
- gemini: `--yolo`

Use it only in project folders you trust, and track changes with git. To restrict it further, change `extraArgs` in the config.
