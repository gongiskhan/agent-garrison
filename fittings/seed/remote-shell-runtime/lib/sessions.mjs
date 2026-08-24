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
// Turn progress: how often the running turn's output is re-read from the remote
// pane, and how much of it is kept. One ssh exec per tick, and only while a
// delegated turn is actually in flight.
const PROGRESS_POLL_MS = 2500;
const PROGRESS_MAX_LINES = 400;
const PROGRESS_MAX_CHARS = 24_000;

function stateDir() {
  return path.join(garrisonHome(), "remote-shell");
}

function sessionsFile() {
  return path.join(stateDir(), "sessions.json");
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Remote paths configured as ~/... must expand on the REMOTE shell — a
// single-quoted tilde never does, so `tail -F '~/x'` follows a nonexistent
// literal path forever, silently. Splice in an unquoted "$HOME" instead.
const remotePath = (p) => {
  const s = String(p);
  return s.startsWith("~/") ? `"$HOME"${shellQuote(s.slice(1))}` : shellQuote(s);
};

// A capture always ends with the agent TUI's own input box — the rule, the
// "add a follow-up" prompt, the model/status bar — redrawn at the bottom of the
// pane. That is furniture, not output, and repeating it under every message in
// the ledger buries the actual answer. Cut from the last full-width divider in
// the closing lines; anything else is kept verbatim, so a TUI whose box this
// does not match simply keeps its trailer rather than losing content.
const DIVIDER_RE = /^[\s▀-▟─-╿_=-]{8,}$/;
const CHROME_TAIL_LINES = 12;

export function stripPromptChrome(text) {
  const lines = String(text).replace(/\s+$/, "").split("\n");
  const from = Math.max(0, lines.length - CHROME_TAIL_LINES);
  // The FIRST divider in that closing window opens the box, so everything from
  // it down is the box.
  for (let i = from; i < lines.length; i++) {
    if (DIVIDER_RE.test(lines[i])) return lines.slice(0, i).join("\n").replace(/\s+$/, "");
  }
  return lines.join("\n");
}

// Copy-mode is where scrolling lives, and keys sent to a pane in it are read as
// copy commands. Cancel it before typing — conditionally, so the common case
// does not spew tmux's "not in a mode" on stderr.
const leaveCopyMode = (target) =>
  `[ "$(tmux display-message -p -t ${target} '#{pane_in_mode}')" = "1" ] && ` +
  `tmux send-keys -t ${target} -X cancel;`;

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
        `tmux new-session -d -s ${shellQuote(transport.tmuxSession)} -c ${remotePath(transport.cwd)} -x 220 -y 50; ` +
        // Shared-attach sizing: the most recently active client drives the
        // window size, so a second smaller viewer doesn't shrink the first.
        `tmux set-option -t ${shellQuote(transport.tmuxSession)} -g window-size latest 2>/dev/null; ` +
        // Scrolling. The attach client is ALWAYS in the alternate screen (tmux
        // owns it), so the browser terminal has no scrollback of its own to
        // move: xterm.js turns a wheel tick into a cursor-key sequence, which
        // the remote agent's TUI reads as "previous message" instead of
        // scrolling its output. The pane's history lives in tmux, and copy-mode
        // is the only way in — which is what mouse mode binds the wheel to.
        // Session-scoped (no -g) so it stays confined to the pane we attach to.
        `tmux set-option -t ${shellQuote(transport.tmuxSession)} mouse on 2>/dev/null; ` +
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

  /**
   * The replay buffer with terminal QUERY sequences stripped. tmux interrogates
   * the attaching terminal on attach (DA1/DA2, CPR, color and termcap queries);
   * those bytes end up in the raw output buffer, and REPLAYING them makes
   * xterm.js answer a question nobody is asking anymore — tmux then treats the
   * answer (`ESC[>0;276;0c`) as KEYSTROKES and types it into the remote TUI's
   * input box, once per reconnect. Queries only mean anything live, so the
   * replay drops them; the live stream is untouched.
   */
  replayBuffer(session) {
    const raw = session.buffer.toString("latin1");
    const stripped = raw.replace(
      // DA1/DA2/version queries, CPR request, OSC 10/11 color queries, XTGETTCAP.
      /\x1b\[>?0?c|\x1b\[6n|\x1b\[>q|\x1b\]1[01];\?(?:\x07|\x1b\\)|\x1bP\+q[^\x07\x1b]*(?:\x07|\x1b\\)/g,
      ""
    );
    return Buffer.from(stripped, "latin1");
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
    const target = shellQuote(session.tmuxSession);
    const r = await sshExec(
      session.transport,
      // Leave copy-mode first. Someone scrolling the pane back (in Garrison or
      // in any other client) leaves it in a mode where keys are copy commands,
      // not input: the instruction is swallowed without an error and the turn
      // waits forever for an agent that was never asked anything.
      `${leaveCopyMode(target)} ` +
        `tmux send-keys -t ${target} -l ${shellQuote(flat)} && ` +
        `sleep 0.15 && tmux send-keys -t ${target} Enter`
    );
    if (r.code !== 0) {
      throw new HttpError(502, `send-keys failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  }

  /** Named keys (Escape, C-c, ...) for cancel and control. */
  async sendKeys(session, keys) {
    const safe = String(keys).trim();
    if (!/^[A-Za-z0-9-]{1,16}$/.test(safe)) throw new HttpError(400, "bad key name");
    const target = shellQuote(session.tmuxSession);
    const r = await sshExec(
      session.transport,
      // Same copy-mode guard as sendInstruction: a control key aimed at the
      // agent (Escape to interrupt it) must not be eaten by the scrollback
      // viewer instead.
      `${leaveCopyMode(target)} tmux send-keys -t ${target} ${shellQuote(safe)}`
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

  /**
   * Where the pane's output currently ENDS, as one absolute line number:
   * scrollback depth plus the cursor's row in the visible pane. A turn records
   * this before it types, and reads back everything past it — without the
   * cursor row a turn that scrolls nothing would "since" the whole screenful of
   * whatever was already there.
   */
  async outputCursor(session) {
    const r = await sshExec(
      session.transport,
      `tmux display-message -p -t ${shellQuote(session.tmuxSession)} '#{history_size} #{cursor_y}'`
    );
    const [h, y] = String(r.stdout).trim().split(/\s+/).map(Number);
    if (r.code !== 0 || !Number.isFinite(h) || !Number.isFinite(y)) return null;
    // A couple of rows of slack: the cursor idles INSIDE the agent's input box,
    // and the first lines it prints replace that box's top.
    return h + Math.max(0, y - 2);
  }

  /**
   * Everything the pane has printed since `baseline` scrollback lines — i.e.
   * since the turn started. The agent TUI here renders INLINE (no alternate
   * screen), so its output really does scroll into tmux's history and this is a
   * faithful transcript rather than a screenshot of the last screenful.
   *
   * Both halves must read the same instant, so history_size is taken on the
   * remote inside the same command rather than in a second round trip.
   */
  async captureSince(session, baseline) {
    if (!Number.isFinite(baseline)) return this.capturePane(session, 60);
    const base = Math.max(0, Math.floor(baseline));
    const target = shellQuote(session.tmuxSession);
    const r = await sshExec(
      session.transport,
      `h=$(tmux display-message -p -t ${target} '#{history_size}'); ` +
        `back=$(( h - ${base} )); ` +
        `[ "$back" -lt 0 ] && back=0; ` +
        `[ "$back" -gt ${PROGRESS_MAX_LINES} ] && back=${PROGRESS_MAX_LINES}; ` +
        `echo "H:$h"; ` +
        `tmux capture-pane -p -t ${target} -S -"$back" -E -`
    );
    if (r.code !== 0) return "";
    const lines = String(r.stdout).split("\n");
    const header = lines.shift() ?? "";
    // Nothing has scrolled off yet, so the capture necessarily starts at the top
    // of the visible pane — above where this turn began. Drop that lead-in, or
    // every short turn reports a screenful of the previous one's output.
    const h = Number(header.replace(/^H:/, ""));
    const skip = Number.isFinite(h) ? Math.max(0, Math.min(base - h, lines.length)) : 0;
    return stripPromptChrome(lines.slice(skip).join("\n")).slice(-PROGRESS_MAX_CHARS);
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
      waiters: [],
      // Progress (the delegate lane's live feedback): the absolute pane line
      // this turn started at, the output read back since, and a revision the
      // long-poll uses to hand a caller only what it has not seen.
      baseline: null,
      output: "",
      outputRev: 0,
      progressTimer: null
    };
    session.turns.set(turn.id, turn);
    session.activeTurn = turn;
    this.#setState(session, "running");
    try {
      turn.baseline = await this.outputCursor(session);
      await this.sendInstruction(session, text);
    } catch (err) {
      turn.state = "failed";
      turn.endedAt = new Date().toISOString();
      turn.error = err.message;
      session.activeTurn = null;
      this.#setState(session, "idle");
      throw err;
    }
    this.#startProgress(session, turn);
    return turn;
  }

  /** Re-read the running turn's output on a timer so the delegate lane can show
   *  the work as it happens instead of one blob at the end. */
  #startProgress(session, turn) {
    if (turn.progressTimer) return;
    let inFlight = false;
    const tick = async () => {
      if (turn.state !== "running") { this.#stopProgress(turn); return; }
      if (inFlight) return;
      inFlight = true;
      try {
        const text = await this.captureSince(session, turn.baseline);
        if (text && text !== turn.output) {
          turn.output = text;
          turn.outputRev++;
          for (const w of turn.waiters.splice(0)) w();
        }
      } catch {
        /* a progress read must never fail the turn */
      } finally {
        inFlight = false;
      }
    };
    turn.progressTimer = setInterval(tick, PROGRESS_POLL_MS);
    turn.progressTimer.unref?.();
  }

  #stopProgress(turn) {
    if (turn?.progressTimer) {
      clearInterval(turn.progressTimer);
      turn.progressTimer = null;
    }
  }

  /**
   * Resolve when the turn leaves `running`, when its output has moved past
   * `sinceRev`, or after waitMs. The output condition is what makes the caller's
   * long-poll a stream: it returns as soon as there is something new to show.
   */
  awaitTurn(session, turnId, waitMs, sinceRev = null) {
    const turn = session.turns.get(turnId);
    if (!turn) throw new HttpError(404, "unknown turn");
    const settled = () => turn.state !== "running";
    const advanced = () => Number.isFinite(sinceRev) && turn.outputRev > sinceRev;
    if (settled() || advanced() || !waitMs) return Promise.resolve(turn);
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
      `touch ${remotePath(t.eventsFile)} 2>/dev/null; tail -n 0 -F ${remotePath(t.eventsFile)} 2>/dev/null`
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
    const r = await sshExec(t, `tail -n 25 ${remotePath(t.eventsFile)} 2>/dev/null`);
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
      this.#stopProgress(turn);
      // The turn's own output (everything printed since it started) is the
      // reply; the last-60-lines tail stays for callers that only ever wanted a
      // screenful.
      turn.output = await this.captureSince(session, turn.baseline).catch(() => turn.output);
      turn.outputRev++;
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
    this.#stopProgress(session.activeTurn);
    this.detach(session);
    this.sessions.delete(id);
    await this.persist();
    return true;
  }

  shutdownAll() {
    for (const session of this.sessions.values()) {
      session.eventsStopped = true;
      if (session.eventsChild) { try { session.eventsChild.kill(); } catch {} }
      this.#stopProgress(session.activeTurn);
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
