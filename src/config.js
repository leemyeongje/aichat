// Default settings, overridable by ./aichat.config.json or ~/.aichat/config.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  defaultAgent: 'claude',
  // Max agent→agent handoffs per user message, to stop endless ping-pong.
  maxAutoTurns: 8,
  // Roles used by /task: the developer builds, the reviewer verifies/debugs.
  workflow: { developer: 'claude', reviewer: 'codex' },
  agents: {
    claude: {
      bin: 'claude',
      color: 208,
      role: 'Developer. Designs from the requirements and implements the code.',
      // Headless mode can't ask for permission, so pre-approve edits and tools.
      extraArgs: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch'],
    },
    codex: {
      bin: 'codex',
      color: 77,
      role: 'Critical debugger/reviewer. Reviews the whole change against the original request, not just what was asked to check; runs and tests it, and fixes bugs.',
      sandbox: 'workspace-write',
      extraArgs: [],
    },
    gemini: {
      bin: 'gemini',
      color: 75,
      role: 'Researcher/architect. Helps the others with design input, docs research, and alternatives.',
      extraArgs: ['--yolo'],
    },
  },
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read config file (${file}): ${err.message}`);
    return null;
  }
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(cwd) {
  let cfg = DEFAULT_CONFIG;
  for (const file of [path.join(os.homedir(), '.aichat', 'config.json'), path.join(cwd, 'aichat.config.json')]) {
    const over = readJson(file);
    if (over) cfg = merge(cfg, over);
  }
  return cfg;
}
