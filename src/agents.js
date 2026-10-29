// Adapters that run each vendor CLI in headless mode and normalize its JSON
// event stream into a common shape:
//   { kind: 'text' | 'tool' | 'info' | 'error', text }
// Each adapter remembers its own session id so the agent keeps its memory
// across turns (claude --resume, codex exec resume, gemini --resume).

import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';

const clip = (s, n = 160) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export function isInstalled(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

class Agent {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.sessionId = null;
    this.proc = null;
    this.available = isInstalled(cfg.bin);
  }

  get busy() {
    return this.proc !== null;
  }

  stop() {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    const p = this.proc;
    setTimeout(() => p.exitCode === null && p.kill('SIGKILL'), 3000).unref();
  }

  // Runs one turn. onEvent receives normalized events while streaming.
  // Resolves with { text, error } where text is the agent's final reply.
  run(prompt, { cwd, systemPrompt, onEvent }) {
    const args = this.buildArgs(prompt, systemPrompt);
    return new Promise((resolve) => {
      const proc = spawn(this.cfg.bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      this.proc = proc;
      this.finalText = '';
      this.textParts = [];
      this.edited = false; // set by parse() when the agent changes files
      let stderr = '';

      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        line = line.trim();
        if (!line) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          // Non-JSON output (warnings, plain text fallback).
          onEvent({ kind: 'info', text: clip(line) });
          return;
        }
        for (const out of this.parse(ev)) onEvent(out);
      });
      proc.stderr.on('data', (d) => (stderr += d));

      proc.on('error', (err) => {
        this.proc = null;
        resolve({ text: '', error: err.message, edited: false });
      });
      proc.on('close', (code, signal) => {
        this.proc = null;
        const text = (this.finalText || this.textParts.join('\n\n')).trim();
        let error = null;
        if (signal) error = `stopped (${signal})`;
        else if (code !== 0 && !text) error = clip(stderr.trim().split('\n').slice(-3).join(' '), 400) || `exit ${code}`;
        resolve({ text, error, edited: this.edited });
      });
    });
  }
}

// ---------------------------------------------------------------- Claude Code
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

class ClaudeAgent extends Agent {
  buildArgs(prompt, systemPrompt) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (this.cfg.model) args.push('--model', this.cfg.model);
    return args.concat(this.cfg.extraArgs ?? []);
  }

  *parse(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) {
          this.textParts.push(c.text);
          yield { kind: 'text', text: c.text };
        } else if (c.type === 'tool_use') {
          if (CLAUDE_EDIT_TOOLS.has(c.name)) this.edited = true;
          yield { kind: 'tool', text: describeClaudeTool(c.name, c.input) };
        }
      }
    } else if (ev.type === 'result') {
      if (ev.is_error) yield { kind: 'error', text: clip(ev.result || ev.subtype, 400) };
      else if (typeof ev.result === 'string') this.finalText = ev.result;
    }
  }
}

function describeClaudeTool(name, input = {}) {
  const target = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? '';
  return `${name}${target ? ' ' + clip(target, 120) : ''}`;
}

// ---------------------------------------------------------------------- Codex
class CodexAgent extends Agent {
  buildArgs(prompt, systemPrompt) {
    // codex has no system-prompt flag; prepend the room rules on the first turn.
    const body = !this.sessionId && systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${this.cfg.sandbox ?? 'workspace-write'}"`];
    // Projects that only have CLAUDE.md still give codex the same instructions.
    common.push('-c', 'project_doc_fallback_filenames=["CLAUDE.md"]');
    if (this.cfg.model) common.push('-m', this.cfg.model);
    common.push(...(this.cfg.extraArgs ?? []));
    return this.sessionId
      ? ['exec', 'resume', ...common, this.sessionId, body]
      : ['exec', ...common, body];
  }

  *parse(ev) {
    if (ev.type === 'thread.started') this.sessionId = ev.thread_id;
    else if (ev.type === 'turn.failed') yield { kind: 'error', text: clip(ev.error?.message ?? 'turn failed', 400) };
    else if (ev.type === 'error') yield { kind: 'error', text: clip(ev.message, 400) };
    else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
      yield { kind: 'tool', text: `$ ${clip(ev.item.command, 140)}` };
    } else if (ev.type === 'item.completed') {
      const it = ev.item ?? {};
      switch (it.type) {
        case 'agent_message':
          this.textParts.push(it.text);
          this.finalText = it.text; // the last agent_message is the final answer
          yield { kind: 'text', text: it.text };
          break;
        case 'command_execution':
          if (it.exit_code) yield { kind: 'info', text: `  ↳ exit ${it.exit_code}` };
          break;
        case 'file_change':
          this.edited = true;
          for (const c of it.changes ?? []) yield { kind: 'tool', text: `${c.kind ?? 'edit'} ${c.path}` };
          break;
        case 'mcp_tool_call':
          yield { kind: 'tool', text: `${it.server}.${it.tool}` };
          break;
        case 'web_search':
          yield { kind: 'tool', text: `search ${clip(it.query, 100)}` };
          break;
        case 'reasoning':
          if (it.text) yield { kind: 'info', text: clip(it.text, 140) };
          break;
        case 'error':
          yield { kind: 'error', text: clip(it.message, 400) };
          break;
      }
    }
  }
}

// --------------------------------------------------------------------- Gemini
const GEMINI_EDIT_TOOLS = new Set(['write_file', 'replace', 'edit']);

class GeminiAgent extends Agent {
  buildArgs(prompt, systemPrompt) {
    const body = !this.sessionId && systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const args = ['-p', body, '--output-format', 'stream-json'];
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (this.cfg.model) args.push('-m', this.cfg.model);
    return args.concat(this.cfg.extraArgs ?? []);
  }

  *parse(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;
    switch (ev.type) {
      case 'message':
        if (ev.role === 'assistant' && ev.content) {
          // Streams as deltas; stitch them into one reply.
          if (ev.delta && this.textParts.length) this.textParts[this.textParts.length - 1] += ev.content;
          else this.textParts.push(ev.content);
          yield { kind: 'delta', text: ev.content };
        }
        break;
      case 'tool_use':
        if (GEMINI_EDIT_TOOLS.has(ev.tool_name)) this.edited = true;
        yield { kind: 'tool', text: `${ev.tool_name} ${clip(JSON.stringify(ev.parameters ?? {}), 120)}` };
        break;
      case 'tool_result':
        if (ev.status === 'error') yield { kind: 'info', text: `  ↳ ${clip(ev.error?.message ?? 'error', 140)}` };
        break;
      case 'error':
        yield { kind: 'error', text: clip(ev.message, 400) };
        break;
      case 'result':
        if (ev.status === 'error') yield { kind: 'error', text: clip(ev.error?.message ?? 'error', 400) };
        break;
    }
  }
}

const CLASSES = { claude: ClaudeAgent, codex: CodexAgent, gemini: GeminiAgent };

export function createAgents(config) {
  const agents = {};
  for (const [name, cfg] of Object.entries(config.agents)) {
    if (cfg.enabled === false) continue;
    const Cls = CLASSES[cfg.type ?? name];
    if (!Cls) throw new Error(`Unknown agent type: ${cfg.type ?? name}`);
    agents[name] = new Cls(name, cfg);
  }
  return agents;
}
