import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const CURSOR_DEFAULTS = Object.freeze({
  hold_short_seconds: 45, hold_long_seconds: 25200, rearm_mode: 'auto',
  rearm_margin_seconds: 60, stalled_after_minutes: 10,
  creation_prompt_max_chars: 1500, creation_confirm_timeout_seconds: 10,
  creation_max_attempts: 2, workspaces: [],
});
export const validIdentity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
export const stripCursorToken = text => String(text ?? '').replace(/ \[grs:[a-z0-9]{8}\]\s*$/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const generation = value => String(value ?? '').replace(/^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}).*$/i, '$1');
const asText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const textBlock = text => ({ type: 'text', text });

export function initialConversation(payload, at) {
  return {
    node_id: payload.node_id, conversation_id: payload.conversation_id,
    workspace_roots: [], model: null, attached: false, state: 'discovered',
    last_event_at: at, last_generation_id: null, hold_started_at: null,
    hold_deadline_at: null, queued_messages: [], origin_of_last_prompt: 'desk',
    created_by_garrison: false, creation_id: null, transcript_path: null,
    cursor_version: null, started_at: at, title: null,
  };
}

export function eventKey(payload) {
  const { received_at, node_id, user_email, ...identity } = payload;
  if (identity.hook_event_name === 'afterAgentThought') identity.generation_id = generation(identity.generation_id);
  return hash(JSON.stringify(identity));
}

export function applyCursorEvent(previous, payload, at, key = eventKey(payload)) {
  const state = { ...previous, last_event_at: at };
  if (Array.isArray(payload.workspace_roots)) state.workspace_roots = payload.workspace_roots.filter(r => typeof r === 'string');
  if (typeof payload.model === 'string') state.model = payload.model;
  if (typeof payload.cursor_version === 'string') state.cursor_version = payload.cursor_version;
  if (typeof payload.transcript_path === 'string') state.transcript_path = payload.transcript_path;
  const turn = generation(payload.generation_id);
  const name = payload.hook_event_name;
  if (turn) state.last_generation_id = turn;
  let role = 'system', event = null, blocks = [], origin;
  const tool = (toolName, input, result, completed) => {
    event = completed ? 'tool.call.completed' : 'tool.call.started';
    role = 'assistant';
    blocks = [{ type: 'tool_use', name: toolName, input,
      toolUseId: `${turn}:${hash(JSON.stringify([toolName, input]))}`,
      status: completed ? 'completed' : 'running', ...(completed ? { result: asText(result) } : {}),
      ...(Number.isFinite(payload.duration) ? { durationMs: payload.duration } : {}),
    }];
  };
  if (name === 'sessionStart') {
    state.state = 'working'; event = 'session.started';
    blocks = [textBlock(`Cursor session started in ${state.workspace_roots.join(', ')}`)];
  } else if (name === 'beforeSubmitPrompt') {
    state.state = 'working'; state.attached = false; state.origin_of_last_prompt = 'desk';
    state.hold_started_at = null; state.hold_deadline_at = null;
    const text = stripCursorToken(payload.prompt);
    state.title ||= text.replace(/\s+/g, ' ').slice(0, 100);
    role = 'user'; event = 'user.message'; origin = 'desk'; blocks = [textBlock(text)];
  } else if (name === 'afterAgentResponse') {
    role = 'assistant'; event = 'assistant.message'; blocks = [textBlock(asText(payload.text))];
  } else if (name === 'afterAgentThought') {
    role = 'assistant'; event = 'assistant.thought'; blocks = [{ type: 'thinking', text: asText(payload.text) }];
  } else if (name === 'beforeShellExecution' || name === 'afterShellExecution') {
    tool('Shell', { command: payload.command, cwd: payload.cwd }, payload.output, name === 'afterShellExecution');
  } else if (name === 'beforeMCPExecution' || name === 'afterMCPExecution') {
    tool(`${payload.mcp_server_name ?? 'Tool'}/${payload.tool_name ?? payload.command ?? 'call'}`, payload.tool_input ?? {}, payload.result_json, name === 'afterMCPExecution');
  } else if (name === 'afterFileEdit') {
    tool(`edited ${payload.file_path ?? ''}`, { path: payload.file_path }, payload.edits, true);
  } else if (name === 'beforeReadFile') {
    tool(`read ${payload.file_path ?? ''}`, { path: payload.file_path }, null, false);
  } else if (name === 'stop') {
    state.state = 'released'; state.hold_started_at = null; state.hold_deadline_at = null;
    event = 'session.released'; blocks = [textBlock('Released')];
  } else if (name === 'sessionEnd') {
    state.state = 'ended'; state.attached = false;
    state.hold_started_at = null; state.hold_deadline_at = null;
    event = 'session.ended'; blocks = [textBlock('Session ended')];
  }
  if (state.state === 'stalled' && !['stop', 'sessionEnd'].includes(name)) state.state = 'working';
  if (event && role === 'system') {
    role = 'assistant';
    blocks = [{ type: 'status', subtype: 'session_lifecycle', text: blocks.map(block => block.text ?? '').join('') }];
  }
  const entry = event ? {
    id: key, role, ts: at, turnId: turn || null, generationId: turn || null,
    sessionId: payload.conversation_id, event, blocks, ...(origin ? { origin } : {}),
  } : null;
  return { state, entry };
}

export class CursorStore extends EventEmitter {
  constructor({ home, nodeId, accent = '#527c91', now = Date.now, config = {} }) {
    super();
    if (!validIdentity(nodeId)) throw new Error('Invalid Cursor node identity');
    this.root = path.join(home, 'cursor', 'conversations');
    this.nodeId = nodeId; this.accent = accent; this.now = now;
    this.config = { ...CURSOR_DEFAULTS, ...config };
    this.conversations = new Map();
    this.setMaxListeners(0);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(this.root).filter(f => /^[a-f0-9]{64}\.jsonl$/.test(f))) {
      const fullPath = path.join(this.root, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const end = raw.lastIndexOf('\n') + 1;
      for (const line of raw.slice(0, end).split('\n').filter(Boolean)) this.replay(JSON.parse(line));
      if (end < raw.length) fs.truncateSync(fullPath, Buffer.byteLength(raw.slice(0, end)));
    }
  }
  replay(record) {
    const p = record.payload;
    if (p.node_id !== this.nodeId || !validIdentity(p.conversation_id)) throw new Error('Invalid Cursor journal identity');
    const conversation = this.conversations.get(p.conversation_id) ?? {
      state: initialConversation(p, record.at), entries: new Map(), seen: new Set(), pendingTools: new Map(), lastEntry: null,
    };
    if (conversation.seen.has(record.key)) return conversation;
    const { state, entry } = applyCursorEvent(conversation.state, p, record.at, record.key);
    conversation.state = state;
    conversation.seen.add(record.key);
    conversation.lastEntry = null;
    if (entry) {
      const block = entry.blocks[0];
      if (block?.type === 'tool_use') {
        const signature = JSON.stringify([entry.turnId, block.name, block.name === 'Shell' ? block.input?.command : block.input]);
        const pending = conversation.pendingTools.get(signature) ?? [];
        if (block.status === 'running') {
          block.toolUseId = entry.id;
          pending.push(entry.id);
        } else if (pending.length) {
          const startedId = pending.shift();
          const started = conversation.entries.get(startedId);
          entry.id = startedId;
          entry.ts = started.ts;
          entry.revision = (started.revision ?? 0) + 1;
          block.toolUseId = startedId;
          block.input = started.blocks[0].input;
        }
        conversation.pendingTools.set(signature, pending);
      }
      const previous = conversation.entries.get(entry.id);
      const saved = { ...entry, order: previous?.order ?? conversation.entries.size };
      conversation.entries.set(saved.id, saved);
      conversation.lastEntry = saved;
    }
    this.conversations.set(p.conversation_id, conversation);
    return conversation;
  }
  ingest(payload) {
    if (payload?.node_id !== this.nodeId || !validIdentity(payload.conversation_id) || typeof payload.hook_event_name !== 'string') {
      throw new Error('Invalid Cursor hook identity');
    }
    const key = eventKey(payload);
    if (this.conversations.get(payload.conversation_id)?.seen.has(key)) return this.get(payload.conversation_id);
    const record = { v: 1, key, at: this.now(), payload };
    const file = path.join(this.root, `${hash(`${this.nodeId}\0${payload.conversation_id}`)}.jsonl`);
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const conversation = this.replay(record);
    this.emit('change', { row: this.row(conversation.state), entry: conversation.lastEntry });
    return conversation.state;
  }
  get(id) { return this.conversations.get(id)?.state ?? null; }
  entries(id) { return [...(this.conversations.get(id)?.entries.values() ?? [])]; }
  row(state) {
    const workspace = this.config.workspaces.find(w => w.roots?.length && w.roots.every(root => state.workspace_roots.includes(root)));
    return {
      id: state.conversation_id, node: this.nodeId, nodeAccent: this.accent,
      nodeStatus: 'online', connection: 'connected', shellOrigin: null,
      runtime: 'cursor', kind: 'desktop', cwd: state.workspace_roots[0] ?? null,
      project: workspace?.label ?? state.workspace_roots.map(r => path.basename(r)).join(', '),
      title: state.title ?? 'Cursor conversation', status: state.state === 'working' ? 'working' : state.state === 'ended' ? 'ended' : 'idle',
      statusSource: 'cursor-hooks', startedAt: new Date(state.started_at).toISOString(),
      lastActivityAt: new Date(state.last_event_at).toISOString(), resumable: false,
      attachable: false, resumeRef: null, resumeCommand: null,
      transcript: { format: 'cursor-hooks', path: '' }, cursor: { ...state, queued_messages: undefined, transcript_path: undefined },
    };
  }
  rows() { return [...this.conversations.values()].map(c => this.row(c.state)); }
}
