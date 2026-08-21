// Remote-shell session manager.
//
// A SESSION is a live attachment to one named tmux session on one transport.
// The local node-pty child is an `ssh -tt <target> tmux attach` CLIENT — the
// agent itself lives in the REMOTE tmux server, so it survives Garrison
// restarts, network blips, and browser closes; killing the local PTY only
// detaches (the dev-env tmux-mode invariant, one hop further away).
//
// Lifecycle state is HOOK-DRIVEN, not scraped: the remote agent's hooks append
// {"event":"agent-start"|"agent-stop"} lines to a LOCAL file on the remote
// machine (~/.garrison/events.jsonl there), and this manager follows that file
// over an ssh exec channel (`tail -F`). agent-start → running, agent-stop →
// idle + turn settlement + notification fan-out. The events channel is the
// same inbound ssh transport as everything else — the remote NEVER dials us.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pty from "node-pty";
import { garrisonHome, sshArgv, sshExec } from "./transports.mjs";

const OUTPUT_BUFFER_BYTES = 512 * 1024; // full alt-screen redraw replay
const EVENTS_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

function stateDir() {
  return path.join(garrisonHome(), "remote-shell");
}

function sessionsFile() {
  return path.join(stateDir(), "sessions.json");
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class SessionManager {
  constructor({ tunnels, transports, notify }) {
    this.tunnels = tunnels;
    this.transports = transports; // Map name -> transport
    this.notify = notify; // async ({title, text, link, tag}) => void
    this.sessions = new Map(); // id -> record
    this.subscribers = new Map(); // id -> Set<ws-like {send}>
  }

  // ── Persistence (records only; PTYs re-attach lazily) ────────────────────

  async persist() {
    mkdirSync(stateDir(), { recursive: true });
    const rows = [...this.sessions.values()].map((s) => ({
      id: s.id,
      transport: s.transport.name,
      tmuxSession: s.tmuxSession,
      label: s.label,
      createdAt: s.createdAt,
      state: s.state === "running" ? "running" : "idle",
      lastEventAt: s.lastEventAt
    }));
    await writeFile(sessionsFile(), JSON.stringify({ sessions: rows }, null, 2));
  }

  async restore() {
    let rows = [];
    try {
      rows = JSON.parse(await readFile(sessionsFile(), "utf8"))?.sessions ?? [];
    } catch {
      return 0;
    }
    let n = 0;
    for (const row of rows) {
      const transport = this.transports.get(row.transport);
      if (!transport || this.findByTarget(row.transport, row.tmuxSession)) continue;
      this.#register({
        id: row.id,
        transport,
        tmuxSession: row.tmuxSession,
        label: row.label,
        createdAt: row.createdAt,
        state: row.state === "running" ? "running" : "idle",
        lastEventAt: row.lastEventAt ?? null
      });
      n++;
    }
    return n;
  }

  findByTarget(transportName, tmuxSession) {
    for (const s of this.sessions.values()) {
      if (s.transport.name === transportName && s.tmuxSession === tmuxSession) return s;
    }
    return null;
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }

  summary(s) {
    return {
      id: s.id,
      transport: s.transport.name,
      label: s.label,
      tmuxSession: s.tmuxSession,
      state: s.state,
      createdAt: s.createdAt,
      lastEventAt: s.lastEventAt,
      attached: Boolean(s.pty),
      eventsWatcher: s.eventsChild ? "up" : "down",
      activeTurn: s.activeTurn
        ? { id: s.activeTurn.id, startedAt: s.activeTurn.startedAt }
        : null
    };
  }

  #register(fields) {
    const record = {
      pty: null,
      buffer: Buffer.alloc(0),
      eventsChild: null,
      eventsBackoffIdx: 0,
      eventsStopped: false,
      activeTurn: null,
      turns: new Map(), // turnId -> {id, text, startedAt, endedAt, state, waiters[]}
      cols: 220,
      rows: 50,
      ...fields
    };
    this.sessions.set(record.id, record);
    return record;
  }

  // ── Session bring-up ──────────────────────────────────────────────────────

  /**
   * Start (or re-attach) the session for a transport. Idempotent per
   * (transport, tmuxSession): an existing record is revived in place.
   */
  async start(transportName, { label } = {}) {
    const transport = this.transports.get(transportName);
    if (!transport) throw new HttpError(404, `unknown transport "${transportName}"`);

    const tunnel = await this.tunnels.ensure(transport);
    if (!tunnel.ok) throw new HttpError(502, tunnel.error);

    // Reachability + remote tmux session (create if missing, in the work cwd).
    const ensure = await sshExec(
      transport,
      `tmux has-session -t ${shellQuote(transport.tmuxSession)} 2>/dev/null || ` +
        `tmux new-session -d -s ${shellQuote(transport.tmuxSession)} -c ${shellQuote(transport.cwd)} -x 220 -y 50; ` +
        // Shared-attach sizing: the most recently active client drives the
        // window size, so a second smaller viewer doesn't shrink the first.
        `tmux set-option -t ${shellQuote(transport.tmuxSession)} -g window-size latest 2>/dev/null; ` +
        `tmux display-message -p -t ${shellQuote(transport.tmuxSession)} '#{pane_current_command}'`
    );
    if (ensure.code !== 0) {
      throw new HttpError(502, `cannot reach ${transport.name} over ssh: ${(ensure.stderr || ensure.stdout).trim().slice(0, 400)}`);
    }

    let session = this.findByTarget(transportName, transport.tmuxSession);
    if (!session) {
      session = this.#register({
        id: randomUUID(),
        transport,
        tmuxSession: transport.tmuxSession,
        label: label || transport.label,
        createdAt: new Date().toISOString(),
        state: "idle",
        lastEventAt: null
      });
    } else if (label) {
      session.label = label;
    }

    // If the pane is sitting at a bare shell and the transport names an agent
    // command, start the agent. Never touch a pane already running something.
    const paneCommand = ensure.stdout.trim().split("\n").pop()?.trim() ?? "";
    const bareShells = new Set(["bash", "zsh", "sh", "fish", "dash", "-bash", "-zsh"]);
    if (transport.agentCommand && bareShells.has(paneCommand)) {
      await sshExec(
        transport,
        `tmux send-keys -t ${shellQuote(transport.tmuxSession)} -l ${shellQuote(transport.agentCommand)} && ` +
          `tmux send-keys -t ${shellQuote(transport.tmuxSession)} Enter`
      );
    }

    this.ensureAttached(session);
    this.#ensureEventsWatcher(session);
    await this.persist();
    return session;
  }

  // ── PTY attach (the streaming surface) ───────────────────────────────────

  ensureAttached(session) {
    if (session.pty) return session;
    const t = session.transport;
    const argv = [
      ...sshArgv(t, { pty: true }),
      `tmux attach-session -t ${shellQuote(session.tmuxSession)}`
    ];
    const child = pty.spawn("ssh", argv, {
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
      env: { ...process.env, TERM: "xterm-256color" }
    });
    session.pty = child;
    child.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      session.buffer = session.buffer.length + chunk.length > OUTPUT_BUFFER_BYTES
        ? Buffer.concat([session.buffer, chunk]).subarray(-OUTPUT_BUFFER_BYTES)
        : Buffer.concat([session.buffer, chunk]);
      for (const ws of this.subscribers.get(session.id) ?? []) {
        try { ws.send(chunk); } catch {}
      }
    });
    child.onExit(({ exitCode }) => {
      if (session.pty === child) session.pty = null;
      for (const ws of this.subscribers.get(session.id) ?? []) {
        try { ws.send(JSON.stringify({ type: "detached", exitCode })); } catch {}
      }
    });
    return session;
  }

  detach(session) {
    if (session.pty) {
      try { session.pty.kill(); } catch {}
      session.pty = null;
    }
  }

  resize(session, cols, rows) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return;
    session.cols = Math.floor(cols);
    session.rows = Math.floor(rows);
    if (session.pty) {
      try { session.pty.resize(session.cols, session.rows); } catch {}
    }
  }

  subscribe(session, ws) {
    let set = this.subscribers.get(session.id);
    if (!set) {
      set = new Set();
      this.subscribers.set(session.id, set);
    }
    set.add(ws);
    return () => set.delete(ws);
  }

  // ── Input paths ──────────────────────────────────────────────────────────

  /** Raw bytes from the terminal pane straight into the attach client. */
  writeRaw(session, bytes) {
    this.ensureAttached(session);
    try { session.pty.write(bytes); } catch {}
  }

  /** A line of instruction typed outside the terminal (chat box / delegate
   *  lane): literal text into the TUI's input box, then Enter. Sent through
   *  tmux send-keys on an exec channel so it works with NO local PTY attached.
   *  Newlines are flattened — Enter submits in agent TUIs. */
  async sendInstruction(session, text) {
    const flat = String(text).replace(/\s*\n\s*/g, " ").trim();
    if (!flat) throw new HttpError(400, "empty instruction");
    const r = await sshExec(
      session.transport,
      `tmux send-keys -t ${shellQuote(session.tmuxSession)} -l ${shellQuote(flat)} && ` +
        `sleep 0.15 && tmux send-keys -t ${shellQuote(session.tmuxSession)} Enter`
    );
    if (r.code !== 0) {
      throw new HttpError(502, `send-keys failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  }

  /** Named keys (Escape, C-c, ...) for cancel and control. */
  async sendKeys(session, keys) {
    const safe = String(keys).trim();
    if (!/^[A-Za-z0-9-]{1,16}$/.test(safe)) throw new HttpError(400, "bad key name");
    const r = await sshExec(
      session.transport,
      `tmux send-keys -t ${shellQuote(session.tmuxSession)} ${shellQuote(safe)}`
    );
    if (r.code !== 0) throw new HttpError(502, "send-keys failed");
  }

  /** Last lines of the pane, ANSI-free — turn summaries, never state. */
  async capturePane(session, lines = 40) {
    const r = await sshExec(
      session.transport,
      `tmux capture-pane -p -t ${shellQuote(session.tmuxSession)} -S -${Math.max(1, Math.min(lines, 200))}`
    );
    return r.code === 0 ? r.stdout : "";
  }

  // ── Turns (the delegate/chat lane) ───────────────────────────────────────

  async startTurn(session, text) {
    if (session.activeTurn) {
      throw new HttpError(409, `session already has an active turn (${session.activeTurn.id})`);
    }
    const turn = {
      id: randomUUID(),
      text: String(text),
      startedAt: new Date().toISOString(),
      endedAt: null,
      state: "running",
      waiters: []
    };
    session.turns.set(turn.id, turn);
    session.activeTurn = turn;
    this.#setState(session, "running");
    try {
      await this.sendInstruction(session, text);
    } catch (err) {
      turn.state = "failed";
      turn.endedAt = new Date().toISOString();
      turn.error = err.message;
      session.activeTurn = null;
      this.#setState(session, "idle");
      throw err;
    }
    return turn;
  }

  /** Resolve when the turn leaves `running`, or after waitMs. */
  awaitTurn(session, turnId, waitMs) {
    const turn = session.turns.get(turnId);
    if (!turn) throw new HttpError(404, "unknown turn");
    if (turn.state !== "running" || !waitMs) return Promise.resolve(turn);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        turn.waiters = turn.waiters.filter((w) => w !== waiter);
        resolve(turn);
      }, waitMs);
      const waiter = () => {
        clearTimeout(timer);
        resolve(turn);
      };
      turn.waiters.push(waiter);
    });
  }

  // ── Hook-driven lifecycle (the events watcher) ───────────────────────────

  #ensureEventsWatcher(session) {
    if (session.eventsChild || session.eventsStopped) return;
    const t = session.transport;
    // -n 0: only NEW events. Missed-stop recovery on (re)connect is handled by
    // the catch-up read below, keyed on lastEventAt.
    const child = spawn("ssh", [
      ...sshArgv(t),
      `touch ${shellQuote(t.eventsFile)} 2>/dev/null; tail -n 0 -F ${shellQuote(t.eventsFile)} 2>/dev/null`
    ], { stdio: ["ignore", "pipe", "pipe"] });
    session.eventsChild = child;

    let carry = "";
    child.stdout.on("data", (d) => {
      session.eventsBackoffIdx = 0;
      carry += d.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) this.onEventLine(session, line);
    });
    child.on("close", () => {
      if (session.eventsChild === child) session.eventsChild = null;
      if (session.eventsStopped || !this.sessions.has(session.id)) return;
      const delay = EVENTS_BACKOFF_MS[Math.min(session.eventsBackoffIdx++, EVENTS_BACKOFF_MS.length - 1)];
      setTimeout(() => {
        if (!session.eventsStopped && this.sessions.has(session.id)) {
          this.#catchUpEvents(session).finally(() => this.#ensureEventsWatcher(session));
        }
      }, delay).unref?.();
    });
  }

  /** After a watcher gap, re-read the tail of the events file so a stop that
   *  fired during the gap still settles the turn. */
  async #catchUpEvents(session) {
    const t = session.transport;
    const r = await sshExec(t, `tail -n 25 ${shellQuote(t.eventsFile)} 2>/dev/null`);
    if (r.code !== 0) return;
    const since = session.lastEventAt ? Date.parse(session.lastEventAt) : 0;
    for (const line of r.stdout.split("\n")) {
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(evt?.ts ?? "");
      if (Number.isFinite(ts) && ts > since) this.onEventLine(session, line);
    }
  }

  /** Public for the events watcher and the test suite. */
  onEventLine(session, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { return; }
    if (!evt || typeof evt.event !== "string") return;
    session.lastEventAt = evt.ts ?? new Date().toISOString();

    if (evt.event === "agent-start") {
      this.#setState(session, "running");
    } else if (evt.event === "agent-stop") {
      this.#settleStop(session, evt);
    }
    this.persist().catch(() => {});
  }

  async #settleStop(session, evt) {
    this.#setState(session, "idle");
    const turn = session.activeTurn;
    if (turn && turn.state === "running") {
      turn.state = "completed";
      turn.endedAt = evt.ts ?? new Date().toISOString();
      turn.tail = await this.capturePane(session, 60).catch(() => "");
      session.activeTurn = null;
      for (const w of turn.waiters.splice(0)) w();
    }
    // Completion notification through the channel /notify contract. The
    // idempotency key is stable per stop event so channels that dedupe before
    // spending push budget (capture-service) never double-send on a redelivery.
    try {
      await this.notify({
        title: session.label,
        text: `${session.label}: agent finished on ${session.transport.name}.`,
        actions: [],
        tag: `remote-shell:${session.id}`,
        idempotencyKey: `remote-shell:${session.id}:${evt.ts ?? turn?.endedAt ?? "stop"}`,
        link: null
      });
    } catch (err) {
      console.warn(`[remote-shell] notify failed: ${err.message}`);
    }
  }

  #setState(session, state) {
    if (session.state === state) return;
    session.state = state;
    for (const ws of this.subscribers.get(session.id) ?? []) {
      try { ws.send(JSON.stringify({ type: "state", state })); } catch {}
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  /** Forget the local record. The REMOTE tmux session is never killed. */
  async remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.eventsStopped = true;
    if (session.eventsChild) { try { session.eventsChild.kill(); } catch {} }
    this.detach(session);
    this.sessions.delete(id);
    await this.persist();
    return true;
  }

  shutdownAll() {
    for (const session of this.sessions.values()) {
      session.eventsStopped = true;
      if (session.eventsChild) { try { session.eventsChild.kill(); } catch {} }
      this.detach(session);
    }
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
