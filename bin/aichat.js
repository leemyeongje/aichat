#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAgents } from '../src/agents.js';
import { Room } from '../src/room.js';
import { startUI } from '../src/ui.js';

const cwd = path.resolve(process.argv[2] ?? process.cwd());
const config = loadConfig(cwd);
const room = new Room({ cwd, config, agents: createAgents(config) });
startUI(room);
