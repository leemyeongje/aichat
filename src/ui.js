// Terminal front-end: streams every agent's activity into one scrollback and
// keeps the input line usable while agents are working.

import readline from 'node:readline';

const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const fg = (n, s) => c(`38;5;${n}`, s);

// Inline code and code blocks, close to Claude Code's own color.
const CODE_COLOR = 147;
const LINK_COLOR = 244;

const HELP = `
${bold('Usage')}
  message             Talk to the default agent
  @codex message      Talk to specific agents (several: @claude @codex ..., everyone: @all ...)
  /task description   Workflow: developer implements ⇄ reviewer verifies, report once both say [동의]
  /init [name]        Analyze the project and write AGENTS.md (CLAUDE.md imports it)
  /stop  (or Ctrl+C)  Stop the running agent and clear the queue
  /agents             Participants, status, roles, session ids
  /default name       Change the default agent
  /auto N             Max agent-to-agent handoffs per message (0 = off)
  /verbose            Toggle agents' thinking and detail logs
  /history [N]        Replay the last N messages
  /new                Reset the conversation and all agent sessions
  /quit               Exit
`;

// Terminal columns a string takes: ANSI codes are free, CJK and emoji are 2.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;
const width = (s) => {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) w += WIDE.test(ch) ? 2 : /\p{Mn}/u.test(ch) ? 0 : 1;
  return w;
};

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;
// Cells of "| a | b \| c |", keeping escaped pipes inside a cell.
const cells = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

// Minimal Markdown → ANSI for agent replies, fed one line at a time. Each call
// returns the lines to print (fences print nothing; table rows are held until
// the table ends, since column widths need every row). Styles close with their
// own off codes instead of a full reset so they nest (e.g. code inside bold).
function createMarkdown({ isName, colorOf, columns }) {
  let inFence = false;
  let table = [];

  const inline = (s) => {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => `\0${codes.push(code) - 1}\0`);
    s = s
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '\x1b[1m$1\x1b[22m')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?![*\w])/g, '$1\x1b[3m$2\x1b[23m')
      .replace(/\[([^\]]+)\]\((\S+?)\)/g, `\x1b[4m$1\x1b[24m \x1b[38;5;${LINK_COLOR}m($2)\x1b[39m`)
      .replace(/(^|[^\w@])@(\w+)/g, (m, pre, name) =>
        isName(name.toLowerCase()) ? `${pre}\x1b[38;5;${colorOf(name.toLowerCase())}m@${name}\x1b[39m` : m,
      );
    return s.replace(/\0(\d+)\0/g, (_, i) => `\x1b[38;5;${CODE_COLOR}m${codes[i]}\x1b[39m`);
  };

  const renderTable = (rows) => {
    if (rows.length < 2 || !TABLE_SEP.test(rows[1])) return rows.map(inline);
    const align = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
    const body = [rows[0], ...rows.slice(2)].map((r) => cells(r).map(inline));
    const n = Math.max(...body.map((r) => r.length));
    const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...body.map((r) => width(r[i] ?? ''))));
    const [head, ...data] = body;

    // Too wide for the terminal: wrapped box lines would be unreadable, so
    // list each row as "header: value" lines instead.
    if (widths.reduce((a, w) => a + w + 3, 1) > columns()) {
      return data.flatMap((r, ri) => [
        ...(ri ? [''] : []),
        ...r.map((cell, i) => `${bold(head[i] ?? '')}${dim(':')} ${cell}`),
      ]);
    }

    const pad = (s, i) => {
      const gap = widths[i] - width(s);
      if (align[i] === 'right') return ' '.repeat(gap) + s;
      if (align[i] === 'center') return ' '.repeat(gap >> 1) + s + ' '.repeat(gap - (gap >> 1));
      return s + ' '.repeat(gap);
    };
    const rule = (l, m, r) => dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
    const row = (r, style = (x) => x) =>
      dim('│') + widths.map((_, i) => ` ${style(pad(r[i] ?? '', i))} `).join(dim('│')) + dim('│');
    return [rule('┌', '┬', '┐'), row(head, bold), rule('├', '┼', '┤'), ...data.map((r) => row(r)), rule('└', '┴', '┘')];
  };

  const flush = () => {
    const out = table.length ? renderTable(table) : [];
    table = [];
    return out;
  };

  const render = (text) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return [];
    }
    if (inFence) return [fg(CODE_COLOR, text)];
    let m;
    if ((m = text.match(/^\s*#{1,6}\s+(.*)$/))) return [bold(inline(m[1]))];
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) return [dim('─'.repeat(40))];
    if ((m = text.match(/^(\s*)>\s?(.*)$/))) return [`${m[1]}${dim('▎')} ${inline(m[2])}`];
    return [inline(text)];
  };

  const line = (text) => {
    if (!inFence && TABLE_ROW.test(text)) {
      table.push(text);
      return [];
    }
    return [...flush(), ...render(text)];
  };

  // End of a reply: emit any table still being collected.
  const end = () => {
    inFence = false;
    return flush();
  };

  return { line, end };
}

export function startUI(room) {
  const colorOf = (name) => (name === 'user' ? 81 : room.agents[name]?.cfg.color ?? 250);
  const tag = (name) => bold(fg(colorOf(name), `@${name}`));
  const md = createMarkdown({
    isName: (n) => n === 'user' || !!room.agents[n],
    colorOf,
    // Two columns go to the "│ " gutter.
    columns: () => (process.stdout.columns || 80) - 2,
  });
  let verbose = false;
  let deltaBuf = '';
  let ctrlCArmed = false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 500 });

  const refreshPrompt = () => {
    const cur = room.current;
    const waiting = room.queue.length ? dim(` +${room.queue.length} queued`) : '';
    rl.setPrompt(cur ? `${fg(colorOf(cur.name), `● ${cur.name} working`)}${waiting} ${bold('›')} ` : `${bold('›')} `);
    rl.prompt(true);
  };

  // Print above the input line without clobbering what the user is typing.
  const print = (text) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(text + '\n');
    refreshPrompt();
  };

  const printOut = (name, lines) => {
    for (const out of lines) print(`${fg(colorOf(name), '│')} ${out}`);
  };

  const printLine = (name, line) => printOut(name, md.line(line));

  const flushDelta = (name) => {
    if (deltaBuf) printLine(name, deltaBuf);
    deltaBuf = '';
    printOut(name, md.end());
  };

  const printBody = (name, text) => {
    for (const line of text.split('\n')) printLine(name, line);
    printOut(name, md.end());
  };

  room.on('start', (name, from) => {
    md.end();
    print('');
    print(`${tag(name)} ${dim(`← from ${from === 'user' ? 'user' : '@' + from}`)}`);
  });

  room.on('event', (name, ev) => {
    switch (ev.kind) {
      case 'text':
        printBody(name, ev.text.trim());
        break;
      case 'delta': {
        deltaBuf += ev.text;
        const lines = deltaBuf.split('\n');
        deltaBuf = lines.pop();
        for (const l of lines) printLine(name, l);
        break;
      }
      case 'tool':
        print(dim(`${fg(colorOf(name), '│')}   ⚙ ${ev.text}`));
        break;
      case 'info':
        if (verbose) print(dim(`${fg(colorOf(name), '│')}   ${ev.text}`));
        break;
      case 'error':
        print(`${fg(colorOf(name), '│')} ${c('31', '✗ ' + ev.text)}`);
        break;
    }
  });

  room.on('done', (name, targets) => {
    flushDelta(name);
    if (targets.length) print(dim(`  ↪ handed off to ${targets.map((t) => '@' + t).join(', ')}`));
  });

  room.on('notice', (msg) => {
    flushDelta(room.current?.name);
    print(c('33', `• ${msg}`));
  });

  room.on('idle', () => {
    print(dim('— Idle. Type a message.'));
  });

  const commands = {
    help: () => print(HELP),
    stop: () => {
      if (!room.current && !room.queue.length) return print(dim('Nothing is running.'));
      room.stop();
      print(c('33', '• Stopped.'));
    },
    task: (arg) => (arg ? room.task(arg) : print('Usage: /task <what to build>')),
    init: (arg) => {
      const name = arg.replace(/^@/, '').toLowerCase() || room.config.defaultAgent;
      if (!room.agents[name]) return print(`Agents: ${room.names.join(', ')}`);
      print('');
      print(`${tag('user')} /init → ${tag(name)}`);
      room.init(name);
    },
    agents: () => {
      for (const [n, a] of Object.entries(room.agents)) {
        const status = !a.available ? c('31', 'not installed') : room.current === a ? c('33', 'working') : c('32', 'idle');
        const def = n === room.config.defaultAgent ? dim(' (default)') : '';
        print(`${tag(n)}${def} ${status}  ${a.cfg.role}`);
        print(dim(`    session: ${a.sessionId ?? '(new)'}`));
      }
    },
    default: (arg) => {
      if (!room.agents[arg]) return print(`Agents: ${room.names.join(', ')}`);
      room.config.defaultAgent = arg;
      print(`Default agent → ${tag(arg)}`);
    },
    auto: (arg) => {
      const n = Number.parseInt(arg, 10);
      if (Number.isNaN(n) || n < 0) return print(`Auto handoff limit: ${room.maxAutoTurns}`);
      room.maxAutoTurns = n;
      print(`Auto handoff limit → ${n}`);
    },
    verbose: () => {
      verbose = !verbose;
      print(`Verbose log ${verbose ? 'on' : 'off'}`);
    },
    history: (arg) => {
      const n = Number.parseInt(arg, 10) || 10;
      for (const m of room.transcript.slice(-n)) {
        print('');
        print(`${tag(m.from)}${m.to?.length ? dim(' → ' + m.to.map((t) => '@' + t).join(' ')) : ''}`);
        printBody(m.from, m.text);
      }
    },
    new: () => {
      room.reset();
      print(c('33', '• Conversation and sessions reset.'));
    },
    quit: () => {
      room.stop();
      rl.close();
    },
  };
  commands.exit = commands.quit;

  rl.on('line', (line) => {
    ctrlCArmed = false;
    line = line.trim();
    if (!line) return refreshPrompt();
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const fn = commands[cmd.toLowerCase()];
      return fn ? fn(rest.join(' ')) : print(`Unknown command: /${cmd} (see /help)`);
    }
    // Echo the user's message into the shared log.
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    print('');
    print(`${tag('user')} ${line}`);
    if (room.current) print(dim('  (delivered when the current turn ends; /stop to interrupt)'));
    room.say(line);
  });

  rl.on('SIGINT', () => {
    if (room.current || room.queue.length) return commands.stop();
    if (ctrlCArmed) return commands.quit();
    ctrlCArmed = true;
    print(dim('Press Ctrl+C again to exit.'));
  });

  rl.on('close', () => {
    room.stop();
    process.stdout.write('\n');
    process.exit(0);
  });

  // Banner
  print(bold('aichat') + dim(`  ·  ${room.cwd}`));
  for (const [n, a] of Object.entries(room.agents)) {
    print(`  ${tag(n)} ${a.available ? '' : c('31', '(not installed) ')}${dim(a.cfg.role)}`);
  }
  if (room.transcript.length) print(dim(`  Resuming ${room.transcript.length} previous messages. (/history, /new)`));
  print(dim('  Type /help for commands'));
  print('');
}
