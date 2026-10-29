# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, Gemini CLI) when working with code in this repository. `CLAUDE.md` imports it, so edit this file only.

## Project

`aichat` is a terminal "group chat" orchestrator that drives the Claude Code, Codex, and Gemini CLIs in headless mode so they can talk to the user and hand work to each other in one shared working directory. It uses each CLI's own subscription login — no API keys. Terminal UI text (prompt, status lines, notices, `/help`, errors) is in English, with Markdown in agent replies rendered to ANSI by `createMarkdown` in `src/ui.js` (tables are buffered until the last row and drawn as a box, or as `header: value` lines if wider than the terminal; widths count CJK as 2 columns). Agent roles in `DEFAULT_CONFIG` are English because the UI shows them. Agent prompts are in Korean; keep new ones in Korean to match. The README is in English.

## Commands

Plain Node ESM (Node >= 20), zero dependencies, no build step, no test suite, no linter.

```bash
npm link                         # install the `aichat` bin globally (once)
node bin/aichat.js [project-dir] # run without linking; defaults to cwd
for f in bin/*.js src/*.js; do node --check "$f"; done  # syntax check (the only automated check)
```

Running it requires the `claude`, `codex`, and/or `gemini` CLIs on PATH and logged in. Agents whose binary is missing are shown as not installed and skipped. To try a change end to end, run it against a scratch directory (`node bin/aichat.js /tmp/scratch`), not this repo: the `.aichat/` directory here may be the state of the session you are running in, so don't edit or delete it.

## Architecture

Entry `bin/aichat.js` wires four modules: `loadConfig` → `createAgents` → `new Room` → `startUI`.

- **`src/config.js`**: `DEFAULT_CONFIG` deep-merged with `~/.aichat/config.json` and then `./aichat.config.json` (objects merge, arrays and scalars replace). Each agent entry has `bin`, `color` (256-color code), `role` (injected into prompts), `extraArgs`, and optional `model`, `enabled: false`, and `type` (adapter class, defaults to the entry's key, so you can define extra agents that reuse an adapter).
- **`src/agents.js`**: one adapter class per vendor CLI, extending a base `Agent` that spawns the process, reads stdout line by line as JSON (non-JSON lines become `info` events), and resolves `{ text, error, edited }`. `text` is `finalText` if set, else `textParts` joined; a non-zero exit is an error only when there is no text. A subclass implements only:
  - `buildArgs(prompt, systemPrompt)`: CLI flags, including resume by `this.sessionId`. Only Claude has a system-prompt flag; Codex and Gemini get the system prompt prepended to the first turn (when there's no session yet). Codex is also passed `project_doc_fallback_filenames=["CLAUDE.md"]` so projects with only a `CLAUDE.md` still reach it.
  - `*parse(ev)`: a generator that captures the session id, collects the final reply into `this.finalText` / `this.textParts`, and yields normalized events `{ kind: 'text' | 'delta' | 'tool' | 'info' | 'error', text }`. `delta` is for streamed fragments (Gemini); the UI buffers it until a newline.
  - New adapters must be registered in `CLASSES`.
- **`src/room.js`** (`Room extends EventEmitter`): the core state machine.
  - The shared transcript is persisted to `<cwd>/.aichat/transcript.jsonl`; per-agent session ids and `lastSeen` are in `.aichat/sessions.json`, so conversations survive restarts. `/new` deletes `.aichat/`.
  - `lastSeen[agent]` is the transcript index the agent has already been shown. `buildPrompt` sends only the messages since then, excluding the agent's own (capped at `MAX_CONTEXT_MSGS`/`MAX_MSG_CHARS`); the vendor session holds the agent's longer-term memory. `lastSeen` is set at the *start* of a turn on purpose, so user messages typed mid-turn are delivered next turn.
  - Agents run **strictly one at a time** through `queue` + `pump()`, because they all edit the same directory. User jobs are inserted ahead of queued agent-to-agent handoffs.
  - Handoffs: `parseHandoffs` treats any reply line starting with `@name` (optionally bolded or followed by `:`/`,`) as a handoff to that agent, or to `@user`. Agent-to-agent handoffs count against `maxAutoTurns`, which resets on each user message. `deferUserReport` never lets one reply go to both `@user` and an agent: the `@user` handoff is dropped, unless the reply contains `[질문]`, in which case the agent handoffs are held until the user answers. A job is skipped if the agent has nothing new in the transcript.
  - `/init [agent]` calls `say()` with a prefix asking one agent to analyze the repo, write `AGENTS.md`, and create a `CLAUDE.md` containing only `@AGENTS.md` (or ask via `[질문]` before replacing an existing one).
  - `/task` sets `this.workflow` (developer/reviewer pair) and calls `say()` with a prefix explaining the consensus rules. After each turn, `applyWorkflow` does the following. When a turn edits files (adapters set `edited` from their edit-tool events), the other agent's agreement is cleared. The turn ends with consensus only when both agents' latest replies contain `[동의]`. Until then, `@user` handoffs are dropped unless the reply contains `[질문]`, and if no agent handoff is left, the turn goes to the counterpart along with an `aichat` note in the transcript. `stop()`/`reset()` clear the workflow.
  - The workflow reviewer gets `REVIEW_RULES` (be critical beyond what the requester asked, verify claims by running code, hunt for counterexamples) in its system prompt and again in every prompt for a turn handed over by an agent, because Codex and Gemini see the system prompt only on their first turn.
  - Emits `start`, `event`, `done` (with the final handoff targets), `notice`, and `idle` for the UI.
- **`src/ui.js`**: a readline front end that only listens to Room events and prints above the live input line (`print` clears and redraws the prompt). Slash commands live in the `commands` map; when adding one, also update `HELP` and the README table.

## Permissions

Headless agents can't prompt for permission, so the defaults are autonomous: Claude runs with `--permission-mode acceptEdits` plus an allowed-tools list, Codex runs with `sandbox_mode="workspace-write"`, and Gemini runs with `--yolo`. Changes to the defaults in `extraArgs` or `sandbox` affect safety for every user.
