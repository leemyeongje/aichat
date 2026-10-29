// The group chat: a shared transcript, a turn queue, and @mention routing.
// Only one agent runs at a time because they all share the same working dir.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const MAX_MSG_CHARS = 6000;
const MAX_CONTEXT_MSGS = 30;
// Markers agents write during /task: agreement with the current code, and a
// question that genuinely needs the user before consensus.
const AGREE = /\[동의\]/;
const ASK_USER = /\[질문\]/;

const CONSENSUS_RULES = [
  `합의 규칙 (두 사람이 모두 동의해야 끝난다):`,
  `- 현재 코드 상태가 완성됐다고 판단하면 답변에 [동의] 라고 쓴다.`,
  `- 이번 차례에 코드를 수정했다면 상대가 그 변경을 검토해야 한다. 상대에게 넘기지 않아도 aichat이 자동으로 넘긴다.`,
  `- 상대가 이미 [동의]했고 네가 코드를 바꾸지 않은 채 [동의]하면 합의 완료다. 그때 @user 에게 최종 결과를 보고한다.`,
  `- 사용자의 결정이 꼭 필요할 때만 [질문] 을 붙여 @user 에게 묻는다.`,
  `- 합의 전에는 @user 에게 보고하지 않는다. @user 와 상대를 한 답변에서 함께 멘션하지 마라.`,
].join('\n');

// The reviewer is told on every review turn, not just in the system prompt
// (Codex and Gemini only see that on their first turn).
const REVIEW_RULES = [
  `검토 원칙 (리뷰어):`,
  `- 요청자가 확인해 달라고 한 부분만 보지 마라. 사용자의 원래 요구사항을 기준으로 변경 전체를 의심하며 검토한다.`,
  `- 요청자의 설명과 "테스트 통과" 주장을 그대로 믿지 말고 직접 코드를 읽고 실행해 확인한다.`,
  `- 엣지 케이스, 에러 처리, 기존 기능 회귀, 빠진 요구사항, 보안·데이터 손실 위험을 찾는다.`,
  `- 문제없다고 결론 내기 전에 깨지는 입력이나 시나리오를 먼저 찾아본다. 못 찾았을 때만 [동의] 한다.`,
].join('\n');

export class Room extends EventEmitter {
  constructor({ cwd, config, agents }) {
    super();
    this.cwd = cwd;
    this.config = config;
    this.agents = agents;
    this.maxAutoTurns = config.maxAutoTurns;
    this.transcript = [];
    this.lastSeen = {}; // agent name → transcript length already shown to it
    this.queue = [];
    this.current = null;
    this.autoTurns = 0;
    // Active /task: { pair: [developer, reviewer], agreed: { name: bool } }.
    this.workflow = null;
    this.stateDir = path.join(cwd, '.aichat');
    this.load();
  }

  // ------------------------------------------------------------ persistence
  load() {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'sessions.json'), 'utf8'));
      for (const [name, a] of Object.entries(this.agents)) a.sessionId = s.sessions?.[name] ?? null;
      this.lastSeen = s.lastSeen ?? {};
      this.transcript = fs
        .readFileSync(path.join(this.stateDir, 'transcript.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      // No previous session in this directory.
    }
  }

  save() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const sessions = Object.fromEntries(Object.entries(this.agents).map(([n, a]) => [n, a.sessionId]));
    fs.writeFileSync(path.join(this.stateDir, 'sessions.json'), JSON.stringify({ sessions, lastSeen: this.lastSeen }, null, 2));
  }

  append(msg) {
    msg = { ts: new Date().toISOString(), ...msg };
    this.transcript.push(msg);
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(path.join(this.stateDir, 'transcript.jsonl'), JSON.stringify(msg) + '\n');
    return msg;
  }

  reset() {
    this.stop();
    for (const a of Object.values(this.agents)) a.sessionId = null;
    this.transcript = [];
    this.lastSeen = {};
    fs.rmSync(this.stateDir, { recursive: true, force: true });
  }

  // --------------------------------------------------------------- routing
  get names() {
    return Object.keys(this.agents);
  }

  // Splits a leading "@a @b text" into targets and body.
  parseTargets(text) {
    const targets = [];
    let rest = text.trim();
    let m;
    while ((m = rest.match(/^@(\w+)[,:]?\s*/))) {
      const name = m[1].toLowerCase();
      if (name === 'all') targets.push(...this.names);
      else if (this.agents[name]) targets.push(name);
      else break;
      rest = rest.slice(m[0].length);
    }
    return { targets: [...new Set(targets)], body: rest };
  }

  // Lines in an agent's reply that start with @name hand the turn over.
  parseHandoffs(from, text) {
    const handoffs = [];
    let cur = null;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*\**@(\w+)\**[,:]?\s+(.*)$/);
      const name = m?.[1].toLowerCase();
      if (m && (this.agents[name] || name === 'user')) {
        cur = { to: name, text: m[2] };
        handoffs.push(cur);
      } else if (cur && line.trim()) {
        cur.text += '\n' + line;
      }
    }
    return handoffs.filter((h) => h.to !== from);
  }

  // User input from the terminal.
  say(text, { prefix = '' } = {}) {
    let { targets, body } = this.parseTargets(text);
    if (!targets.length) targets = [this.config.defaultAgent];
    if (!body) return;
    this.autoTurns = 0;
    // A new user request makes earlier agreements stale.
    if (this.workflow) this.workflow.agreed = {};
    this.append({ from: 'user', to: targets, text: prefix + body });
    // User requests jump ahead of queued agent handoffs.
    const jobs = targets.map((agent) => ({ agent, from: 'user' }));
    const firstAgentJob = this.queue.findIndex((j) => j.from !== 'user');
    this.queue.splice(firstAgentJob === -1 ? this.queue.length : firstAgentJob, 0, ...jobs);
    this.pump();
  }

  task(text) {
    const { developer, reviewer } = this.config.workflow;
    const prefix =
      `[작업 지시 — 합의 워크플로] @${developer} 가 구현하고, 끝나면 @${reviewer} 에게 검증을 요청한다. ` +
      `@${reviewer} 는 실행·테스트로 검증하고 버그를 직접 고치거나 @${developer} 에게 수정을 요청한다.\n` +
      `${CONSENSUS_RULES}\n${REVIEW_RULES}\n\n`;
    this.workflow = { pair: [developer, reviewer], agreed: {} };
    this.say(`@${developer} ${text}`, { prefix });
  }

  // /init: one agent surveys the project and writes the shared instructions
  // file that every vendor CLI reads (CLAUDE.md just imports it).
  init(agent = this.config.defaultAgent) {
    const prefix =
      `[작업 지시 — 프로젝트 지침 파일 생성] 이 저장소를 분석해서 루트에 AGENTS.md 를 작성하라. ` +
      `AGENTS.md 는 Claude Code, Codex, Gemini CLI 가 이 저장소에서 일할 때 읽는 공용 지침 파일이다.\n` +
      `- 빌드·실행·테스트·린트 명령 (테스트 하나만 돌리는 법 포함), 여러 파일을 읽어야 알 수 있는 큰 구조와 핵심 흐름, 이 저장소만의 규칙과 주의점을 담는다.\n` +
      `- 파일 목록 나열, 코드만 봐도 아는 내용, "테스트를 잘 써라" 같은 일반론, 지어낸 정보는 넣지 않는다.\n` +
      `- README.md, package.json 같은 설정 파일, 기존 CLAUDE.md·GEMINI.md·.cursorrules·.github/copilot-instructions.md 가 있으면 참고해 중요한 내용을 반영한다.\n` +
      `- AGENTS.md 가 이미 있으면 새로 쓰지 말고 개선만 한다.\n` +
      `- CLAUDE.md 가 없으면 "@AGENTS.md" 한 줄만 담아 만든다. 이미 있으면 내용을 AGENTS.md 에 옮긴 뒤 "@AGENTS.md" 한 줄로 바꿔도 될지 @user 에게 [질문] 한다.\n` +
      `- 끝나면 @user 에게 무엇을 썼는지 짧게 보고한다.\n\n`;
    this.say(`@${agent} AGENTS.md 를 만들어줘.`, { prefix });
  }

  // During /task, the developer and reviewer keep handing the turn to each
  // other until both have agreed on the same state of the code. Returns the
  // handoffs to actually follow, plus a room note for the next agent.
  applyWorkflow(name, text, edited, handoffs) {
    const wf = this.workflow;
    if (!wf?.pair.includes(name)) return { handoffs };
    const other = wf.pair.find((n) => n !== name);
    // Changing files invalidates the other side's earlier agreement.
    if (edited) wf.agreed[other] = false;
    wf.agreed[name] = AGREE.test(text);

    if (wf.agreed[name] && wf.agreed[other]) {
      this.workflow = null;
      this.emit('notice', `@${wf.pair[0]} and @${wf.pair[1]} reached consensus. Task complete.`);
      return { handoffs: handoffs.filter((h) => h.to === 'user') };
    }
    if (ASK_USER.test(text)) return { handoffs };

    handoffs = handoffs.filter((h) => h.to !== 'user');
    if (handoffs.length) return { handoffs };
    const why = edited ? `@${name} 가 코드를 수정했습니다` : `@${other} 의 [동의]가 아직 없습니다`;
    return {
      handoffs: [{ to: other }],
      note: `[aichat] 아직 합의 전입니다 (${why}). @${other} 는 @${name} 의 답변과 변경 사항을 검토하라.\n${CONSENSUS_RULES}`,
    };
  }

  // An agent reports to the user only once the agents are done with each
  // other: a reply that hands work to another agent drops its @user line, and
  // a [질문] to the user holds the agent handoffs until the user answers.
  deferUserReport(text, handoffs) {
    const toUser = handoffs.some((h) => h.to === 'user');
    const toAgent = handoffs.some((h) => h.to !== 'user');
    if (!toUser || !toAgent) return handoffs;
    return handoffs.filter((h) => (ASK_USER.test(text) ? h.to === 'user' : h.to !== 'user'));
  }

  stop() {
    this.workflow = null;
    this.queue = [];
    this.current?.stop();
  }

  // ------------------------------------------------------------ execution
  systemPrompt(name) {
    const roster = this.names
      .map((n) => `- @${n}: ${this.agents[n].cfg.role}${this.agents[n].available ? '' : ' (현재 오프라인)'}`)
      .join('\n');
    return [
      `너는 터미널 단체 대화방의 참가자 "@${name}"이다. 사용자(@user)와 다음 AI 에이전트들이 함께 일한다:`,
      roster,
      ``,
      `너의 역할: ${this.agents[name].cfg.role}`,
      ``,
      `규칙:`,
      `- 모든 참가자는 같은 작업 디렉터리(${this.cwd})를 공유한다. 다른 에이전트가 파일을 바꿨을 수 있으니 필요하면 다시 확인하라.`,
      `- 다른 에이전트에게 일을 넘기거나 질문하려면 답변 끝에 줄 맨 앞에서 "@이름 요청 내용" 형식으로 써라. 예: "@codex src/auth.js 변경을 검증하고 테스트를 돌려줘"`,
      `- 사용자에게 보고하거나 결정을 물어야 하면 "@user ..." 로 끝내라. 멘션이 없으면 차례가 사용자에게 돌아간다.`,
      `- 다른 에이전트에게 일을 넘길 때는 @user 를 함께 멘션하지 마라. 넘긴 작업이 끝나고 서로 합의한 뒤에 마지막 에이전트가 @user 에게 최종 결과를 한 번만 보고한다.`,
      `- 꼭 필요할 때만 넘겨라. 같은 내용을 주고받는 핑퐁은 피하라.`,
      `- 답변은 간결하게: 무엇을 했는지, 결과, 다음 단계.`,
      ...(name === this.config.workflow.reviewer ? [``, REVIEW_RULES] : []),
    ].join('\n');
  }

  buildPrompt(name, from) {
    const seen = this.lastSeen[name] ?? 0;
    const fresh = this.transcript.slice(seen).filter((m) => m.from !== name).slice(-MAX_CONTEXT_MSGS);
    const fmt = (m) => {
      const to = m.to?.length ? ` → ${m.to.map((t) => '@' + t).join(' ')}` : '';
      const body = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + '\n…(생략)' : m.text;
      return `[@${m.from}${to}]\n${body}`;
    };
    const review = name === this.config.workflow.reviewer && from !== 'user' ? `\n\n${REVIEW_RULES}` : '';
    return `대화방의 새 메시지 (너의 지난 차례 이후):\n\n${fresh.map(fmt).join('\n\n')}\n\n위 메시지 중 너(@${name})에게 온 요청에 응답하라.${review}`;
  }

  async pump() {
    if (this.current) return;
    while (this.queue.length) {
      const job = this.queue.shift();
      const agent = this.agents[job.agent];
      if (!agent.available) {
        this.emit('notice', `@${job.agent} is not installed (${agent.cfg.bin} not found on PATH).`);
        continue;
      }
      // Skip if nothing new happened for this agent (e.g. duplicate handoffs).
      if (this.transcript.slice(this.lastSeen[job.agent] ?? 0).every((m) => m.from === job.agent)) continue;

      const prompt = this.buildPrompt(job.agent, job.from);
      this.lastSeen[job.agent] = this.transcript.length;
      this.current = agent;
      this.emit('start', job.agent, job.from);

      const { text, error, edited } = await agent.run(prompt, {
        cwd: this.cwd,
        systemPrompt: this.systemPrompt(job.agent),
        onEvent: (ev) => this.emit('event', job.agent, ev),
      });
      this.current = null;

      if (error) this.emit('notice', `@${job.agent} error: ${error}`);
      if (!text) {
        this.save();
        continue;
      }

      let { handoffs, note } = this.applyWorkflow(job.agent, text, edited, this.parseHandoffs(job.agent, text));
      handoffs = this.deferUserReport(text, handoffs);
      const targets = handoffs.map((h) => h.to);
      // lastSeen stays at the turn's start so messages the user typed while
      // this agent was working are still delivered on its next turn.
      this.append({ from: job.agent, to: targets, text });
      if (note) this.append({ from: 'aichat', to: targets, text: note });
      this.save();
      this.emit('done', job.agent, targets);

      for (const h of handoffs.filter((h) => h.to !== 'user')) {
        if (this.autoTurns >= this.maxAutoTurns) {
          this.emit('notice', `Auto handoff limit (${this.maxAutoTurns}) reached. Message an agent directly or raise it with /auto.`);
          break;
        }
        this.autoTurns++;
        this.queue.push({ agent: h.to, from: job.agent });
      }
    }
    this.emit('idle');
  }
}
