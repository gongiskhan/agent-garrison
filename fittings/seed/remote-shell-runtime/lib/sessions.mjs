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
//
// EVERY ssh call here goes through #exec, which is not decoration: a completed
// exec is the strongest evidence the tunnel is carrying, and a timed-out one is
// the earliest evidence it is not. Both are reported to the TunnelManager, so
// a busy session is never probed and a dying one is repaired without waiting
// for a human to notice.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pty from "node-pty";
import { garrisonHome, sshArgv, sshExec } from "./transports.mjs";

const OUTPUT_BUFFER_BYTES = 512 * 1024; // full alt-screen redraw replay
const EVENTS_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
// Session pulse: how often the remote is asked for the running turn's output,
// the pane's state, and the render-storm byte counter. ONE ssh exec per session
// per tick, deliberately — adding a second timer during a saturation event is
// exactly the wrong move, so the storm meter rides the progress read rather
// than opening a channel of its own.
const PROGRESS_POLL_MS = 2500;
const PROGRESS_MAX_LINES = 400;
const PROGRESS_MAX_CHARS = 24_000;
const PULSE_TIMEOUT_MS = 12_000;
// An idle, unwatched session still has to be watched for a storm, but not four
// times a minute: every pulse is an ssh connection through the very tunnel the
// storm is drowning. A ten-second window is still one sample above the sustain
// threshold, so detection is no slower - it is only cheaper.
const IDLE_PULSE_MS = 10_000;
// Three consecutive dead pulses (~7.5s) is not a blip; the turn is degraded and
// the caller deserves to be told rather than watching a frozen transcript.
const DEGRADED_AFTER_PULSES = 3;

function stateDir() {
  return path.join(garrisonHome(), "remote-shell");
}

function sessionsFile() {
  return path.join(stateDir(), "sessions.json");
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A remote cwd from the UI: ~-relative or absolute, one line, no control
// bytes. shellQuote/remotePath contain injection; this contains nonsense.
function cleanRemoteCwd(raw) {
  const p = String(raw ?? "").trim();
  if (!p || p.length > 300 || /[\n\r\0]/.test(p)) return null;
  if (!p.startsWith("~/") && !p.startsWith("/") && p !== "~") return null;
  return p.replace(/\/+$/, "") || "/";
}

// Events attribution across MULTIPLE sessions on one transport: the hook now
// stamps the agent's cwd into every event, and ~-vs-absolute must not break
// the match. "~/dev/x" and "/home/anyone/dev/x" both normalize to "/dev/x".
/** The name a numbered instance wears in the UI: the second agent in
 *  `csg-spec` is "csg-spec #2", not a second row also called "csg-spec". */
function instanceLabel(label, sessName, instance) {
  const base = label || sessName;
  return instance > 1 ? `${base} #${instance}` : base;
}

function normCwd(raw) {
  return String(raw ?? "")
    .replace(/^~(?=\/|$)/, "")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "")
    .replace(/\/+$/, "") || "/";
}

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

// A human-visible pane peaks in the low tens of KB/s; a repaint storm runs
// hundreds. Sustained for this long with no turn streaming = pathology.
const STORM_BYTES_PER_SEC = 250_000;
const STORM_SUSTAIN_MS = 8_000;
const STORM_COOLDOWN_MS = 5 * 60_000;
// A recovery that could not reach the remote has recovered nothing, so it gets
// a short retry rather than the full cooldown.
const STORM_RETRY_MS = 20_000;
const STORM_EXEC_TIMEOUT_MS = 30_000;
// A generating agent prints NEW text; a repainting one repeats itself. That is
// the discriminator that lets the detector stay armed during a turn.
const TURN_STALL_MS = 30_000;
// How long a hook-driven `running` is trusted to mean "an agent is working".
const RUNNING_TRUST_MS = 15 * 60_000;

// Standing output budget on the attach client — the mirror of writeRaw's input
// breaker. 8 MB per 10s is ~800 KB/s sustained, an order of magnitude above any
// human-plausible pane.
const OUTPUT_BUDGET_WINDOW_MS = 10_000;
const DEFAULT_ATTACH_BUDGET_MB = 8;
const ATTACH_SUPPRESS_MS = 60_000;
const ATTACH_FAST_EXIT_MS = 5_000;
const ATTACH_SETTLED_MS = 10_000;
// A terminal repainting faster than this is invisible to a human, and xterm.js
// prefers fewer, larger writes.
const FANOUT_FLUSH_MS = 40;
// A stalled pulse would otherwise let the remote byte file grow without bound.
const PANE_BYTES_CEILING = 64 * 1024 * 1024;

// The lifecycle hook the fitting maintains at ~/.garrison/agent-event-hook.sh
// on every transport. It gained "cwd" the day one transport stopped meaning
// one session: without it, every session on a machine flips running/idle on
// every other session's events. Content-addressed write: one exec per fitting
// process per transport, and only when the bytes differ.
export const REMOTE_EVENT_HOOK = `#!/usr/bin/env bash
# Append one JSON line per agent lifecycle event to a local file.
# $1 = event name (agent-start | agent-stop). Never makes network calls.
# Maintained by Garrison's remote-shell fitting - local edits are overwritten.
event="\${1:-agent-stop}"
input=$(cat 2>/dev/null || true)
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sid=$(printf '%s' "$input" | grep -oE '"(conversation_id|session_id|chat_id)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\\1/')
cwd=$(printf '%s' "$input" | grep -oE '"(cwd|workspace_root|workspacePath)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\\1/')
[ -z "$cwd" ] && cwd="$PWD"
printf '{"ts":"%s","event":"%s","session_id":"%s","cwd":"%s"}\\n' "$ts" "$event" "\${sid:-unknown}" "$cwd" >> ~/.garrison/events.jsonl
exit 0
`;

export class SessionManager {
  constructor({ tunnels, transports, notify, exec = sshExec, ptySpawn = null, env = process.env }) {
    this.tunnels = tunnels;
    this.transports = transports; // Map name -> transport
    this.notify = notify; // async ({title, text, link, tag}) => void
    // Injectable so the storm and tunnel-failure paths are reachable by a test
    // with no remote in sight; every ssh call in this file goes through #exec.
    this.exec = exec;
    this.ptySpawn = ptySpawn ?? ((file, argv, opts) => pty.spawn(file, argv, opts));
    const mb = Number(env.GARRISON_REMOTESHELLRUNTIME_ATTACH_OUTPUT_BUDGET_MB);
    this.attachBudgetBytes = (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_ATTACH_BUDGET_MB) * 1024 * 1024;
    this.sessions = new Map(); // id -> record
    this.subscribers = new Map(); // id -> Set<ws-like {send}>
    // `<transport>\u0000<tmuxSession>` names an allocation between choosing the
    // instance and registering it. Two "another session here" clicks in the same
    // second would otherwise both see the same free name.
    this.#reserved = new Set();
  }

  #reserved;

  // ── Remote lifecycle hook upkeep ─────────────────────────────────────────

  /** Write REMOTE_EVENT_HOOK to the transport if the bytes differ. Once per
   *  fitting process per transport - the hook is part of this fitting's
   *  contract with the remote, not a manual install step someone remembers. */
  async #ensureRemoteHook(transport) {
    this.hookEnsured ??= new Set();
    if (this.hookEnsured.has(transport.name)) return;
    this.hookEnsured.add(transport.name);
    const r = await this.#exec(
      transport,
      `mkdir -p "$HOME/.garrison" && cat > "$HOME/.garrison/.agent-event-hook.next" && ` +
        `if cmp -s "$HOME/.garrison/.agent-event-hook.next" "$HOME/.garrison/agent-event-hook.sh" 2>/dev/null; then ` +
        `rm -f "$HOME/.garrison/.agent-event-hook.next"; echo SAME; else ` +
        `mv "$HOME/.garrison/.agent-event-hook.next" "$HOME/.garrison/agent-event-hook.sh" && ` +
        `chmod +x "$HOME/.garrison/agent-event-hook.sh" && echo UPDATED; fi`,
      { input: REMOTE_EVENT_HOOK }
    ).catch(() => null);
    if (r?.stdout?.includes("UPDATED")) {
      console.log(`[remote-shell] lifecycle hook updated on ${transport.name}`);
    } else if (!r || r.code !== 0) {
      // Non-fatal: the old hook still reports events, only without cwd.
      this.hookEnsured.delete(transport.name);
    }
  }

  // ── Remote project listing ───────────────────────────────────────────────

  /** Folders under ~/dev on the transport - the spawn targets the picker
   *  offers. Ordinary exec, no cache: one ls per modal open is cheaper than
   *  one staleness bug. */
  async listProjects(transportName) {
    const transport = this.transports.get(transportName);
    if (!transport) throw new HttpError(404, `unknown transport "${transportName}"`);
    const tunnel = await this.tunnels.ensure(transport);
    if (!tunnel.ok) throw new HttpError(502, tunnel.error);
    const r = await this.#exec(
      transport,
      `for d in "$HOME"/dev/*/ ; do [ -d "$d" ] && printf '%s\n' "$d"; done`
    );
    if (r.code !== 0) {
      throw new HttpError(502, `cannot list projects on ${transport.name}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    // EVERY session in a folder, not one: a project can host several agents,
    // and a picker that showed only the first would make the others
    // unreachable from the one surface that spawns them.
    const byCwd = new Map();
    for (const x of this.sessions.values()) {
      if (x.transport.name !== transportName || !x.cwd) continue;
      const key = normCwd(x.cwd);
      if (!byCwd.has(key)) byCwd.set(key, []);
      byCwd.get(key).push(this.summary(x));
    }
    for (const list of byCwd.values()) list.sort((a, b) => a.tmuxSession.localeCompare(b.tmuxSession));
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((abs) => {
      const name = abs.replace(/\/+$/, "").split("/").pop() ?? abs;
      const home = `~/dev/${name}`;
      const sessions = byCwd.get(normCwd(home)) ?? [];
      return { name, path: home, sessions };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── The one ssh choke point ───────────────────────────────────────────────

  /**
   * Every remote command in this file. The wrapper exists for the reporting,
   * not the call: a clean exit is proof the tunnel carries (stronger than any
   * synthetic probe, and it is what keeps a busy transport from being probed at
   * all), while a timeout or ssh's own 255 is the earliest signal the leg is
   * dying — earlier than anything the supervisor can see on its own clock.
   */
  async #exec(transport, command, opts = {}) {
    const r = await this.exec(transport, command, opts);
    if (r.code === 0) this.tunnels?.noteTraffic?.(transport);
    // 255 is ssh's own failure (it never reached a shell); anything else
    // non-zero means the remote ran the command and it failed, which still
    // proves the link carried.
    else if (r.code === null || r.code === 255) this.tunnels?.markSuspect?.(transport);
    else this.tunnels?.noteTraffic?.(transport);
    return r;
  }

  // ── Persistence (records only; PTYs re-attach lazily) ────────────────────

  async persist() {
    mkdirSync(stateDir(), { recursive: true });
    const rows = [...this.sessions.values()].map((s) => ({
      id: s.id,
      transport: s.transport.name,
      tmuxSession: s.tmuxSession,
      cwd: s.cwd ?? null,
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
        cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : transport.cwd,
        label: row.label,
        createdAt: row.createdAt,
        // ALWAYS idle, never the persisted `running`. activeTurn is not
        // persisted, so a session written mid-turn would come back running with
        // no turn — and `running` disarms the storm detector, latching it shut
        // from boot with nothing able to clear it. #catchUpEvents replays a
        // genuine still-running agent-start from the file tail.
        state: "idle",
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
      cwd: s.cwd ?? null,
      // The transport's STANDING session (the one a binding with no tmux name
      // means). Consumers match threads to sessions by name; without this they
      // would have to know the transport's default, which is fitting config.
      standing: s.tmuxSession === s.transport.tmuxSession,
      state: s.state,
      createdAt: s.createdAt,
      lastEventAt: s.lastEventAt,
      attached: Boolean(s.pty),
      eventsWatcher: s.eventsChild ? "up" : "down",
      link: this.tunnels?.healthy ? (this.tunnels.healthy(s.transport) ? "up" : "unknown") : "up",
      activeTurn: s.activeTurn
        ? { id: s.activeTurn.id, startedAt: s.activeTurn.startedAt, degraded: Boolean(s.activeTurn.degraded) }
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
      // Pulse + storm + reattach bookkeeping.
      pulseTimer: null,
      pulseArmed: false,
      pulseInFlight: false,
      pulseAt: 0,
      attachSuppressedUntil: 0,
      reattachIdx: 0,
      reattachTimer: null,
      fanOut: null,
      outputBudget: null,
      stormMeter: null,
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
  async start(transportName, { label, recycle = false, tmuxSession = null, cwd = null, allocate = false } = {}) {
    const transport = this.transports.get(transportName);
    if (!transport) throw new HttpError(404, `unknown transport "${transportName}"`);

    // A transport is a MACHINE, not a session: any project folder on it can
    // host its own tmux session + agent. The default (no spec) remains the
    // transport's standing session, so every existing thread keeps working.
    const base = tmuxSession
      ? String(tmuxSession).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)
      : transport.tmuxSession;
    if (!base) throw new HttpError(400, "empty tmux session name");
    const sessCwd = cwd ? cleanRemoteCwd(cwd) : (base === transport.tmuxSession ? transport.cwd : null);
    if (!sessCwd) throw new HttpError(400, "a custom session needs a cwd (the project folder on the remote)");

    const tunnel = await this.tunnels.ensure(transport);
    if (!tunnel.ok) throw new HttpError(502, tunnel.error);

    await this.#ensureRemoteHook(transport);

    // `allocate` is the "another agent in this same folder" gesture: the name
    // is a BASE and the free instance beside it is chosen here, on the machine
    // that can see both sides. A client picking the number would have to
    // enumerate first and would collide with itself on a double click.
    let sessName = base;
    let instance = 1;
    if (allocate) {
      // The remote's list is the only part that needs an await, so it is taken
      // FIRST and the choose-and-reserve below runs to completion without one:
      // two clicks in the same second would otherwise both read the same free
      // name (each holding its own pre-reservation snapshot) and the second
      // agent would silently attach to the first one's session.
      const remoteTaken = await this.#remoteSessionNames(transport);
      while (this.#nameTaken(transport, sessName, remoteTaken)) {
        instance += 1;
        sessName = `${base}-${instance}`.slice(0, 60);
      }
      this.#reserved.add(`${transport.name}\u0000${sessName}`);
    }
    try {

    // Reachability + remote tmux session (create if missing, in the work cwd).
    // The cwd is asserted first: `tmux new-session -c <missing>` silently falls
    // back to $HOME, and an agent started in the wrong tree looks exactly like
    // a working session until it edits the wrong repo.
    const ensure = await this.#exec(
      transport,
      `[ -d ${remotePath(sessCwd)} ] || { echo "NO_SUCH_DIR"; exit 9; }; ` +
      `tmux has-session -t ${shellQuote(sessName)} 2>/dev/null || ` +
        `tmux new-session -d -s ${shellQuote(sessName)} -c ${remotePath(sessCwd)} -x 220 -y 50; ` +
        // Sizing is an explicit AUTHORITY, not an activity heuristic. With
        // `latest`, two live clients at different sizes (the web pane plus a
        // direct attach on the box) flip the window size on every answered
        // terminal query - the inline agent TUI re-renders its transcript on
        // each flip, which reads as the pane scrolling up and down forever.
        // `manual` pins the size; resize() below is the one writer.
        `tmux set-option -t ${shellQuote(sessName)} -g window-size manual 2>/dev/null; ` +
        // Reap zombie viewers: a hard tunnel drop leaves the server-side sshd
        // (and so its tmux client) alive at a stale size. Anything silent for
        // an hour is not a viewer anymore.
        `tmux list-clients -t ${shellQuote(sessName)} -F '#{client_tty} #{client_activity}' 2>/dev/null | ` +
        `while read tty at; do [ $(( $(date +%s) - at )) -gt 3600 ] && tmux detach-client -t "$tty" 2>/dev/null; done; ` +
        // Scrolling. The attach client is ALWAYS in the alternate screen (tmux
        // owns it), so the browser terminal has no scrollback of its own to
        // move: xterm.js turns a wheel tick into a cursor-key sequence, which
        // the remote agent's TUI reads as "previous message" instead of
        // scrolling its output. The pane's history lives in tmux, and copy-mode
        // is the only way in — which is what mouse mode binds the wheel to.
        // Session-scoped (no -g) so it stays confined to the pane we attach to.
        `tmux set-option -t ${shellQuote(sessName)} mouse on 2>/dev/null; ` +
        `tmux display-message -p -t ${shellQuote(sessName)} '#{pane_current_command}'`
    );
    if (ensure.code !== 0) {
      if (ensure.stdout.includes("NO_SUCH_DIR")) {
        throw new HttpError(400, `no such folder on ${transport.name}: ${sessCwd}`);
      }
      throw new HttpError(502, `cannot reach ${transport.name} over ssh: ${(ensure.stderr || ensure.stdout).trim().slice(0, 400)}`);
    }

    let session = this.findByTarget(transportName, sessName);
    if (!session) {
      session = this.#register({
        id: randomUUID(),
        transport,
        tmuxSession: sessName,
        cwd: sessCwd,
        label: instanceLabel(label, sessName, instance) ||
          (sessName === transport.tmuxSession ? transport.label : sessName),
        createdAt: new Date().toISOString(),
        state: "idle",
        lastEventAt: null
      });
    } else {
      if (label) session.label = label;
      if (!session.cwd) session.cwd = sessCwd;
    }

    // If the pane is sitting at a bare shell and the transport names an agent
    // command, start the agent. Never touch a pane already running something.
    const paneCommand = ensure.stdout.trim().split("\n").pop()?.trim() ?? "";
    const bareShells = new Set(["bash", "zsh", "sh", "fish", "dash", "-bash", "-zsh"]);
    if (transport.agentCommand && bareShells.has(paneCommand)) {
      await this.#exec(
        transport,
        `tmux send-keys -t ${shellQuote(sessName)} -l ${shellQuote(transport.agentCommand)} && ` +
          `tmux send-keys -t ${shellQuote(sessName)} Enter`
      );
    }

    // An explicit reconnect recycles the attach client: whatever mode or
    // half-dead state the old ssh/tmux client pair is in dies with it.
    if (recycle) this.detach(session);
    this.ensureAttached(session);
    this.#ensureEventsWatcher(session);
    this.#startPulse(session);
    await this.persist();
    return session;
    } finally {
      // The reservation only has to survive the awaits above; once the record
      // is registered (or the start failed) the name is either really taken or
      // really free, and findByTarget is the truth again.
      this.#reserved.delete(`${transport.name}\u0000${sessName}`);
    }
  }

  /** tmux sessions already on the remote. They outlive this fitting, so after a
   *  restart they are the only record that a name is in use. */
  async #remoteSessionNames(transport) {
    const names = new Set();
    const r = await this.#exec(transport, `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`);
    if (r.code !== 0) return names;
    for (const line of r.stdout.split("\n")) {
      const n = line.trim();
      if (n) names.add(n);
    }
    return names;
  }

  /** Synchronous by design - see the allocation above. */
  #nameTaken(transport, sessName, remoteTaken) {
    if (remoteTaken.has(sessName)) return true;
    if (this.#reserved.has(`${transport.name}\u0000${sessName}`)) return true;
    return Boolean(this.findByTarget(transport.name, sessName));
  }

  /**
   * The tunnel this transport rides came back. Everything that gave up while it
   * was down is restarted here rather than waiting for a human to open a pane:
   * the pulse (which is the only storm detector that works detached), the events
   * watcher, and the attach client if anyone is actually watching.
   */
  transportRecovered(transport) {
    for (const session of this.sessions.values()) {
      if (session.transport.name !== transport?.name) continue;
      this.#startPulse(session);
      this.#ensureEventsWatcher(session);
      this.#reattachIfWanted(session);
    }
  }

  // ── PTY attach (the streaming surface) ───────────────────────────────────

  ensureAttached(session) {
    if (session.pty) return session;
    const now = Date.now();
    if (session.attachSuppressedUntil > now) {
      // Without this, the WS init path or the next writeRaw reopens the
      // firehose immediately and the system flaps: detach → poll → reattach →
      // storm → detach.
      this.#push(session, {
        type: "error",
        message: `terminal detached to protect the link; reattaching in ${Math.ceil((session.attachSuppressedUntil - now) / 1000)}s`
      });
      return session;
    }
    const t = session.transport;
    const argv = [
      ...sshArgv(t, { pty: true }),
      `tmux attach-session -t ${shellQuote(session.tmuxSession)}`
    ];
    const child = this.ptySpawn("ssh", argv, {
      name: "xterm-256color",
      cols: session.cols,
      rows: session.rows,
      env: { ...process.env, TERM: "xterm-256color" }
    });
    session.pty = child;
    session.attachedAt = now;
    session.sawAttachData = false;
    // A browser attach must not hang on a tunnel check, and a cached verdict
    // must never block a user action - so the PTY is spawned regardless (ssh's
    // own ConnectTimeout bounds it) and the diagnosis arrives as a frame.
    if (this.tunnels?.healthy && !this.tunnels.healthy(t)) void this.#diagnose(session);
    child.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      session.sawAttachData = true;
      session.buffer = session.buffer.length + chunk.length > OUTPUT_BUFFER_BYTES
        ? Buffer.concat([session.buffer, chunk]).subarray(-OUTPUT_BUFFER_BYTES)
        : Buffer.concat([session.buffer, chunk]);
      this.#observeOutput(session, chunk.length);
      if (this.#overOutputBudget(session, chunk.length)) {
        this.#shedOutput(session);
        return;
      }
      this.#fanOut(session, chunk);
    });
    child.onExit(({ exitCode }) => {
      const lived = Date.now() - (session.attachedAt ?? 0);
      if (session.pty === child) session.pty = null;
      this.#push(session, { type: "detached", exitCode });
      // An attach that died in seconds having printed nothing did not reach a
      // tmux server; that is the tunnel, not tmux, and it is the earliest thing
      // the browser path can tell anyone.
      if (lived < ATTACH_FAST_EXIT_MS && !session.sawAttachData) {
        this.tunnels?.markSuspect?.(session.transport);
        void this.#diagnose(session);
      }
      session.reattachIdx = lived < ATTACH_SETTLED_MS ? session.reattachIdx + 1 : 0;
      this.#reattachIfWanted(session);
    });
    return session;
  }

  /** Ask the tunnel layer why, and put the sentence in the pane. Never blocks
   *  a caller: the answer is a frame, not a return value. */
  async #diagnose(session) {
    try {
      const r = await this.tunnels.ensure(session.transport);
      if (r && r.ok === false && r.error) this.#push(session, { type: "error", message: r.error });
    } catch { /* a diagnosis that fails is not worse than no diagnosis */ }
  }

  /**
   * Bring the attach client back after a drop. ALWAYS through a timer, never
   * inline from onExit: an ssh that exits immediately would otherwise spin a
   * hot reconnect loop against a dead remote. A restored session nobody is
   * watching is deliberately left detached — it must not dial on every boot.
   */
  #reattachIfWanted(session) {
    if (session.reattachTimer || session.pty) return;
    if (!this.sessions.has(session.id)) return;
    const wanted = (this.subscribers.get(session.id)?.size ?? 0) > 0 || Boolean(session.activeTurn);
    if (!wanted) {
      session.reattachIdx = 0;
      return;
    }
    const now = Date.now();
    const delay = Math.max(
      session.attachSuppressedUntil > now ? session.attachSuppressedUntil - now : 0,
      EVENTS_BACKOFF_MS[Math.min(session.reattachIdx, EVENTS_BACKOFF_MS.length - 1)]
    );
    session.reattachTimer = setTimeout(() => {
      session.reattachTimer = null;
      if (session.pty || !this.sessions.has(session.id)) return;
      if ((this.subscribers.get(session.id)?.size ?? 0) === 0 && !session.activeTurn) return;
      if (this.tunnels?.healthy && !this.tunnels.healthy(session.transport)) {
        session.reattachIdx++;
        this.#reattachIfWanted(session);
        return;
      }
      this.ensureAttached(session);
    }, delay);
    session.reattachTimer.unref?.();
  }

  detach(session) {
    if (session.fanOut?.timer) {
      clearTimeout(session.fanOut.timer);
      session.fanOut.timer = null;
    }
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
    // window-size is manual (see start()), so the viewer's dimensions must be
    // pushed to tmux explicitly - the pty resize alone no longer moves it.
    // Debounced: a seam drag emits a burst, the tunnel round-trip is not free.
    if (session.resizeTimer) clearTimeout(session.resizeTimer);
    session.resizeTimer = setTimeout(() => {
      session.resizeTimer = null;
      this.#exec(
        session.transport,
        `tmux resize-window -t ${shellQuote(session.tmuxSession)} -x ${session.cols} -y ${session.rows} 2>/dev/null`
      ).catch(() => { /* next resize retries */ });
    }, 300);
    session.resizeTimer.unref?.();
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
    if (session.idleDetachTimer) {
      clearTimeout(session.idleDetachTimer);
      session.idleDetachTimer = null;
    }
    return () => {
      set.delete(ws);
      // Nobody watching: the attach client is just one more zombie-in-waiting
      // holding a size vote and a tunnel slot. Drop it after a grace period;
      // the buffer stays for replay and the next subscriber re-attaches.
      if (set.size === 0) {
        if (session.idleDetachTimer) clearTimeout(session.idleDetachTimer);
        session.idleDetachTimer = setTimeout(() => {
          session.idleDetachTimer = null;
          if ((this.subscribers.get(session.id)?.size ?? 0) === 0) this.detach(session);
        }, 60_000);
        session.idleDetachTimer.unref?.();
      }
    };
  }

  // ── Fan-out to browsers ──────────────────────────────────────────────────

  /**
   * Coalesced. Under a storm the raw path was also pushing 1 MB/s per subscriber
   * over the tailnet to a phone; a terminal repainting faster than 40 ms is
   * invisible to a human anyway, and xterm.js prefers fewer, larger writes. An
   * idle pane still flushes immediately, so a keystroke echo is not delayed.
   */
  #fanOut(session, chunk) {
    const q = session.fanOut ??= { chunks: [], timer: null, lastFlush: 0 };
    q.chunks.push(chunk);
    if (q.timer) return;
    const wait = FANOUT_FLUSH_MS - (Date.now() - q.lastFlush);
    if (wait <= 0) {
      this.#flushFanOut(session);
      return;
    }
    q.timer = setTimeout(() => {
      q.timer = null;
      this.#flushFanOut(session);
    }, wait);
    q.timer.unref?.();
  }

  #flushFanOut(session) {
    const q = session.fanOut;
    if (!q || q.chunks.length === 0) return;
    const buf = Buffer.concat(q.chunks.splice(0));
    q.lastFlush = Date.now();
    for (const ws of this.subscribers.get(session.id) ?? []) {
      try { ws.send(buf); } catch {}
    }
  }

  /** A JSON frame to every subscriber, after any pending bytes, so an "error"
   *  or "state" frame never overtakes the output it describes. */
  #push(session, frame) {
    this.#flushFanOut(session);
    const text = JSON.stringify(frame);
    for (const ws of this.subscribers.get(session.id) ?? []) {
      try { ws.send(text); } catch {}
    }
  }

  // ── Input paths ──────────────────────────────────────────────────────────

  /** Raw bytes from the terminal pane straight into the attach client.
   *
   *  Behind a CIRCUIT BREAKER. A human types tens of messages a second at
   *  most; a runaway feeder (a wheel/mouse loop, a stuck key, a buggy
   *  bridge) delivers hundreds, and every one makes the inline agent TUI
   *  re-render its transcript - the "pane scrolls frantically forever"
   *  storm. Budget is a message-count token bucket with a byte allowance
   *  per message so pastes pass; an empty bucket trips the breaker for 5s,
   *  during which only interrupt bytes (Ctrl+C / Escape) pass, and the
   *  event is logged with a rate so the feeder is attributable. */
  writeRaw(session, bytes) {
    this.ensureAttached(session);
    const now = Date.now();
    const b = session.inputBreaker ??= { tokens: 300, refillAt: now, trippedUntil: 0, dropped: 0, warnedAt: 0 };
    b.tokens = Math.min(300, b.tokens + ((now - b.refillAt) / 1000) * 100);
    b.refillAt = now;
    const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes);
    if (now < b.trippedUntil) {
      if (text === "\x03" || text === "\x1b") { try { session.pty?.write(bytes); } catch {} return; }
      b.dropped++;
      return;
    }
    // A paste is few LARGE chunks; a storm is thousands of tiny ones. Count
    // messages, not bytes, but bill oversized chunks as several.
    const cost = Math.max(1, Math.ceil(text.length / 512));
    if (b.tokens < cost) {
      b.trippedUntil = now + 5000;
      b.dropped++;
      if (now - b.warnedAt > 10_000) {
        b.warnedAt = now;
        console.warn(`[remote-shell] input storm on ${session.id} (${session.transport.name}): breaker tripped, dropping input for 5s (${b.dropped} dropped so far)`);
      }
      this.#push(session, { type: "error", message: "input storm suppressed for 5s (circuit breaker)" });
      return;
    }
    b.tokens -= cost;
    try { session.pty?.write(bytes); } catch {}
  }

  /** A line of instruction typed outside the terminal (chat box / delegate
   *  lane): literal text into the TUI's input box, then Enter. Sent through
   *  tmux send-keys on an exec channel so it works with NO local PTY attached.
   *  Newlines are flattened — Enter submits in agent TUIs. */
  async sendInstruction(session, text) {
    const flat = String(text).replace(/\s*\n\s*/g, " ").trim();
    if (!flat) throw new HttpError(400, "empty instruction");
    const target = shellQuote(session.tmuxSession);
    const r = await this.#exec(
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
    const r = await this.#exec(
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
    const r = await this.#exec(
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
    const r = await this.#exec(
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
    const r = await this.#exec(session.transport, this.#captureFragment(shellQuote(session.tmuxSession), base));
    if (r.code !== 0) return "";
    return this.#parseCapture(r.stdout, base);
  }

  /** The remote half of captureSince, as a command fragment, so the session
   *  pulse can carry it without opening a second channel. */
  #captureFragment(target, base) {
    return `h=$(tmux display-message -p -t ${target} '#{history_size}'); ` +
      `back=$(( h - ${base} )); ` +
      `[ "$back" -lt 0 ] && back=0; ` +
      `[ "$back" -gt ${PROGRESS_MAX_LINES} ] && back=${PROGRESS_MAX_LINES}; ` +
      `echo "H:$h"; ` +
      `tmux capture-pane -p -t ${target} -S -"$back" -E -`;
  }

  /** The pulse's capture for one turn. A turn whose baseline read failed has no
   *  line to read back FROM, so it falls back to the last screenful rather than
   *  to 400 lines of whatever preceded it — the same trade captureSince makes. */
  #turnCaptureFragment(target, turn) {
    if (!Number.isFinite(turn.baseline)) {
      return `echo "H:0"; tmux capture-pane -p -t ${target} -S -60`;
    }
    return this.#captureFragment(target, Math.max(0, Math.floor(turn.baseline)));
  }

  #parseCapture(text, base) {
    const lines = String(text).split("\n");
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
    // The one gate worth paying for. Without it a turn started over a wedged
    // tunnel types into nothing, the pulse swallows every failed read ("a
    // progress read must never fail the turn"), and the caller watches a frozen
    // transcript until the gateway's own timeout fires — with no diagnosis
    // anywhere. Here it is an immediate 502 carrying the real sentence.
    const tunnel = await this.tunnels.ensure(session.transport, { reason: "turn" });
    if (!tunnel.ok) throw new HttpError(502, tunnel.error);
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
      outputRevAt: Date.now(),
      pulseFailures: 0,
      degraded: false
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
    this.#startPulse(session);
    return turn;
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

  // ── The session pulse ────────────────────────────────────────────────────
  //
  // ONE exec per session per tick, carrying three things that used to be (or
  // could not be) separate reads: the running turn's output, the pane's current
  // command, and the render-storm byte counter. It runs whether or not a local
  // PTY is attached, which is the entire point — the previous storm detector's
  // only input was the attach client's onData, so a storm that killed the
  // tunnel destroyed the detector's evidence along with it.

  #startPulse(session) {
    session.pulseArmed = true;
    if (session.pulseTimer) return;
    session.pulseTimer = setInterval(() => { void this.#pulse(session); }, PROGRESS_POLL_MS);
    session.pulseTimer.unref?.();
  }

  #stopPulse(session) {
    session.pulseArmed = false;
    if (session.pulseTimer) {
      clearInterval(session.pulseTimer);
      session.pulseTimer = null;
    }
  }

  async #pulse(session) {
    if (!session.pulseArmed || session.pulseInFlight) return;
    if (!this.sessions.has(session.id)) return;
    const t = session.transport;
    // Skipped only while the tunnel layer holds an ACKNOWLEDGED repair — not on
    // a merely-failed probe. Skipping on that would blind the detector exactly
    // when a storm is what made the probe fail.
    if (this.tunnels?.repairing?.(t)) return;
    const startedAt = Date.now();
    const since = session.pulseAt || startedAt - PROGRESS_POLL_MS;
    // Full cadence only when someone is actually waiting on the answer.
    const hot = Boolean(session.activeTurn) || Boolean(session.pty) || (this.subscribers.get(session.id)?.size ?? 0) > 0;
    if (!hot && startedAt - since < IDLE_PULSE_MS) return;
    session.pulseInFlight = true;
    try {
      const r = await this.#exec(t, this.#pulseCommand(session), { timeoutMs: PULSE_TIMEOUT_MS });
      session.pulseAt = Date.now();
      if (r.code === null) {
        this.#pulseFailed(session);
        return;
      }
      const turn = session.activeTurn;
      if (turn) {
        // `degraded` describes the link NOW, not a scar. A read that got
        // through means the transcript below it is live again.
        turn.pulseFailures = 0;
        turn.degraded = false;
      }
      this.#applyPulse(session, r.stdout, Math.max(500, session.pulseAt - since));
    } catch {
      this.#pulseFailed(session);
    } finally {
      session.pulseInFlight = false;
    }
  }

  #pulseCommand(session) {
    const target = shellQuote(session.tmuxSession);
    const file = `"$HOME/.garrison/pane-${session.tmuxSession}.bytes"`;
    // Measured ON THE REMOTE, before the tunnel. The local meter counts bytes
    // that already crossed it, so a throttled or backpressured link drops the
    // observed rate below the threshold while the remote emits ten times it —
    // the measurement was on the wrong side of the bottleneck.
    //
    // `#{history_size}` is the obvious alternative and does not work: it is
    // capped by history-limit (2000 by default), so a real storm pins it inside
    // a second and its delta reads 0 for the rest of an 8s sustain window.
    const pipe = shellQuote(`umask 077; mkdir -p "$HOME/.garrison"; cat >> ${file}`);
    return [
      // -o opens the pipe only when none exists, so re-issuing every tick is free.
      `tmux pipe-pane -o -t ${target} ${pipe} 2>/dev/null`,
      // Read and reset in one command. `cat >>` holds the file O_APPEND, so the
      // truncate is safe: the next write lands at offset 0, no sparse file. The
      // bytes written between the read and the truncate are under one tick's
      // worth, which is irrelevant to a rate threshold.
      `b=$(wc -c < ${file} 2>/dev/null || echo 0); : > ${file} 2>/dev/null; echo "B:$b"`,
      `tmux display-message -p -t ${target} 'S:#{pane_in_mode} #{pane_current_command}'`,
      ...(session.activeTurn ? [this.#turnCaptureFragment(target, session.activeTurn)] : [])
    ].join("; ");
  }

  #applyPulse(session, stdout, elapsedMs) {
    const lines = String(stdout).split("\n");
    let bytes = null;
    let paneCommand = null;
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("H:")) break; // everything from here is pane capture
      if (bytes === null && /^B:\d+$/.test(line)) {
        bytes = Number(line.slice(2));
        continue;
      }
      if (paneCommand === null && line.startsWith("S:")) {
        const fields = line.slice(2).trim().split(/\s+/);
        session.paneInMode = fields[0] === "1";
        paneCommand = fields.slice(1).join(" ");
      }
    }
    if (paneCommand) session.paneCommand = paneCommand;
    if (Number.isFinite(bytes) && bytes >= 0) {
      if (bytes > PANE_BYTES_CEILING) {
        console.warn(`[remote-shell] pane byte counter for ${session.id} reached ${bytes} bytes - the pulse was stalled; it has been truncated`);
      }
      this.#observeRemote(session, bytes, elapsedMs);
    }
    const turn = session.activeTurn;
    if (!turn || turn.state !== "running" || i >= lines.length) return;
    const text = this.#parseCapture(lines.slice(i).join("\n"), Math.max(0, Math.floor(turn.baseline)));
    if (text && text !== turn.output) {
      turn.output = text;
      turn.outputRev++;
      turn.outputRevAt = Date.now();
      for (const w of turn.waiters.splice(0)) w();
    }
  }

  /** A pulse that could not reach the remote. The turn still must not fail on a
   *  progress read — but it stops pretending everything is fine, so the caller
   *  can say the link was lost instead of showing a frozen transcript. */
  #pulseFailed(session) {
    const turn = session.activeTurn;
    if (!turn || turn.state !== "running") return;
    turn.pulseFailures = (turn.pulseFailures ?? 0) + 1;
    if (turn.pulseFailures < DEGRADED_AFTER_PULSES || turn.degraded) return;
    turn.degraded = true;
    turn.outputRev++;
    turn.outputRevAt = Date.now();
    for (const w of turn.waiters.splice(0)) w();
    console.warn(`[remote-shell] turn ${turn.id} on ${session.transport.name}: ${turn.pulseFailures} consecutive progress reads failed - link degraded`);
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
      this.tunnels?.noteTraffic?.(t);
      carry += d.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) this.onEventLine(session, line);
    });
    child.on("close", () => {
      if (session.eventsChild === child) session.eventsChild = null;
      if (session.eventsStopped || !this.sessions.has(session.id)) return;
      const idx = session.eventsBackoffIdx++;
      // A watcher that has run out of backoff is the earliest tunnel-death
      // signal this fitting produces, and until now it triggered nothing at all.
      if (idx >= EVENTS_BACKOFF_MS.length - 1) this.tunnels?.markSuspect?.(t);
      const delay = EVENTS_BACKOFF_MS[Math.min(idx, EVENTS_BACKOFF_MS.length - 1)];
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
    const r = await this.#exec(t, `tail -n 25 ${remotePath(t.eventsFile)} 2>/dev/null`);
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
    // The events file is per MACHINE and every session on it tails the same
    // file, so an event that names a cwd belongs only to the session working
    // there. An event without one (the pre-cwd hook) keeps the old behavior
    // rather than going silent.
    if (evt.cwd && session.cwd && normCwd(evt.cwd) !== normCwd(session.cwd)) return;
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
      // The turn's own output (everything printed since it started) is the
      // reply; the last-60-lines tail stays for callers that only ever wanted a
      // screenful.
      turn.output = await this.captureSince(session, turn.baseline).catch(() => turn.output);
      turn.outputRev++;
      turn.outputRevAt = Date.now();
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
    this.#push(session, { type: "state", state });
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  /** Forget the local record. The remote tmux session survives by DEFAULT -
   *  a Garrison restart must never take the agent with it - and dies only on
   *  the explicit killRemote a human clicked (the Shells picker's Stop). */
  async remove(id, { killRemote = false } = {}) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (killRemote) {
      await this.#exec(
        session.transport,
        `tmux kill-session -t ${shellQuote(session.tmuxSession)} 2>/dev/null; true`
      ).catch(() => {});
    }
    session.eventsStopped = true;
    if (session.eventsChild) { try { session.eventsChild.kill(); } catch {} }
    const armed = session.pulseArmed;
    this.#stopPulse(session);
    if (session.reattachTimer) { clearTimeout(session.reattachTimer); session.reattachTimer = null; }
    this.detach(session);
    this.sessions.delete(id);
    // Awaited, unlike on shutdown: leaving pipe-pane open with nothing left to
    // truncate the file would grow it on the remote forever.
    if (armed) await this.#teardownPipe(session);
    await this.persist();
    return true;
  }

  async #teardownPipe(session) {
    const target = shellQuote(session.tmuxSession);
    const file = `"$HOME/.garrison/pane-${session.tmuxSession}.bytes"`;
    try {
      // pipe-pane with no command closes the current pipe.
      await this.#exec(session.transport, `tmux pipe-pane -t ${target} 2>/dev/null; rm -f ${file}`, { timeoutMs: 8000 });
    } catch { /* the remote may already be gone; the ceiling guard covers it */ }
  }

  // ── Render-storm detector + recovery ─────────────────────────────────────
  //
  // cursor-agent's inline TUI has a rendering pathology: once its live region
  // (a tall diff, a long reply) exceeds the viewport, its idle animation
  // repaints the ENTIRE screen every frame, forever - megabytes per second of
  // output with zero input, zero clients needed (proven by pipe-pane on a
  // client-less pane). Nothing outside the process can calm it; restarting the
  // TUI and resuming the chat is the cure the user was performing by hand.
  //
  // TWO METERS, because the storm's traffic and the detector's evidence used to
  // be the same bytes: the attach client's onData was the only input, so a
  // storm that saturated the link and dropped the tunnel took the detector's
  // input with it and it could never fire. The remote counter (#pulseCommand)
  // works detached and measures before the bottleneck; the local one is the
  // faster trigger while attached. Either may fire, under the same guards.

  #meter(session, now) {
    return session.stormMeter ??= {
      bucketAt: now,
      bytes: 0,
      localHotSince: 0,
      remoteHotSince: 0,
      cooldownUntil: 0,
      recovering: false,
      lastRemoteRate: 0,
      noResumeLogged: false
    };
  }

  #observeOutput(session, n) {
    const now = Date.now();
    const m = this.#meter(session, now);
    const elapsedMs = now - m.bucketAt;
    if (elapsedMs >= 1000) {
      // Close the bucket as a RATE, exactly like #observeRemote below. A bucket
      // is only closed by the NEXT chunk, so its length is whatever the traffic
      // made it: comparing its byte TOTAL against a per-second threshold reads
      // a quiet trickle after a gap as repaint-level. The far end of that
      // mistake is `respawn-pane -k`, which would kill a working agent.
      const hot = m.bytes / (elapsedMs / 1000) >= STORM_BYTES_PER_SEC;
      // Dated from the close of the bucket that proved it, never its start:
      // back-dating one long bucket satisfies the whole sustain window at once,
      // so a single sample could trigger a destructive recovery.
      m.localHotSince = hot ? (m.localHotSince || now) : 0;
      m.bucketAt = now;
      m.bytes = 0;
      this.#maybeStorm(session, m.localHotSince, now, "attach");
    }
    m.bytes += n;
  }

  #observeRemote(session, bytes, elapsedMs) {
    const now = Date.now();
    const m = this.#meter(session, now);
    const rate = bytes / Math.max(0.5, elapsedMs / 1000);
    m.lastRemoteRate = Math.round(rate);
    // Same unit and same threshold as the local meter, deliberately: a second
    // number to guess would be a second number to get wrong.
    m.remoteHotSince = rate >= STORM_BYTES_PER_SEC ? (m.remoteHotSince || now - elapsedMs) : 0;
    this.#maybeStorm(session, m.remoteHotSince, now, "remote");
  }

  #maybeStorm(session, hotSince, now, source) {
    const m = session.stormMeter;
    if (!hotSince || now - hotSince < STORM_SUSTAIN_MS) return;
    if (m.recovering || now < m.cooldownUntil) return;
    if (!this.#stormArmed(session, now)) return;
    m.recovering = true;
    console.warn(
      `[remote-shell] render storm on ${session.id} (${session.transport.name}) via the ${source} meter` +
      (source === "remote" ? ` (${m.lastRemoteRate} B/s on the pane)` : "")
    );
    const settle = (verdict) => {
      m.recovering = false;
      // A FAILED recovery must not arm the five-minute cooldown. The old
      // `.finally` stamped it on every path including the silent give-up, which
      // suppressed detection for five minutes having recovered nothing.
      m.cooldownUntil = Date.now() + (verdict === "unreachable" ? STORM_RETRY_MS : STORM_COOLDOWN_MS);
      if (verdict !== "unreachable") {
        m.localHotSince = 0;
        m.remoteHotSince = 0;
      }
    };
    void this.#stormRecover(session).then(settle, () => settle("unreachable"));
  }

  /**
   * The guards, and why each one is BOUNDED rather than absolute.
   *
   * A generating agent repaints exactly like a storming one, so the hook-driven
   * state is the discriminator — but both of the old guards could latch shut
   * forever. `state === "running"` comes from a `tail -F` the tunnel carries, so
   * a mid-turn drop means agent-start was seen and agent-stop never arrives;
   * and `!activeTurn` disarmed the detector for the whole of a turn, when the
   * pathology begins exactly where content outgrows the viewport, mid-answer.
   */
  #stormArmed(session, now) {
    const turn = session.activeTurn;
    if (turn) {
      const movedAt = turn.outputRevAt || Date.parse(turn.startedAt) || now;
      return now - movedAt > TURN_STALL_MS;
    }
    if (session.state === "running") {
      const last = session.lastEventAt ? Date.parse(session.lastEventAt) : 0;
      if (Number.isFinite(last) && last > 0 && now - last < RUNNING_TRUST_MS) return false;
    }
    return true;
  }

  /**
   * Restart the agent TUI and resume its chat. Returns a VERDICT, because "it
   * did nothing" and "it recovered" used to be indistinguishable — every give-up
   * path was a silent `return`, and the caller stamped a five-minute cooldown on
   * all of them.
   *
   * DETACHES FIRST. All three commands below ride the same link our own attach
   * client is pulling megabytes a second through; the observed "recovery did
   * nothing" was the pane probe timing out, `cmd` coming back empty, and the
   * agentBin guard then declining to touch anything. Freeing our own share of
   * the bandwidth before asking is the difference between a bandwidth problem
   * and a logic problem.
   */
  async #stormRecover(session) {
    const t = session.transport;
    if (!t.agentResumeCommand) {
      if (!session.stormMeter.noResumeLogged) {
        session.stormMeter.noResumeLogged = true;
        console.warn(`[remote-shell] render storm on ${t.name} but the transport declares no agentResumeCommand - nothing to restart it with`);
      }
      return "no-resume-command";
    }
    if (this.tunnels?.healthy && !this.tunnels.healthy(t)) {
      console.warn(`[remote-shell] render storm on ${t.name} but the tunnel is not carrying - recovery would ride the link it is recovering from`);
      return "unreachable";
    }
    // Armed BEFORE the kill: detach() makes the PTY's onExit fire, and onExit is
    // what schedules the reattach that would reopen the firehose.
    session.attachSuppressedUntil = Date.now() + ATTACH_SUPPRESS_MS;
    this.detach(session);
    this.#push(session, { type: "error", message: "output storm: terminal detached to protect the link; reattach to resume" });

    const target = shellQuote(session.tmuxSession);
    // Only ever bounce the agent we know how to bring back. A pane running
    // anything else (a build, an editor) is not ours to kill.
    let probe = await this.#exec(t, `tmux display-message -p -t ${target} '#{pane_current_command}'`, { timeoutMs: STORM_EXEC_TIMEOUT_MS });
    if (probe.code === null) {
      // We just freed the bandwidth, so a first-attempt timeout is worth
      // exactly one retry.
      await new Promise((r) => setTimeout(r, 5000));
      probe = await this.#exec(t, `tmux display-message -p -t ${target} '#{pane_current_command}'`, { timeoutMs: STORM_EXEC_TIMEOUT_MS });
    }
    if (probe.code === null) {
      console.warn(`[remote-shell] render storm recovery on ${t.name}: the pane probe timed out twice, nothing was restarted`);
      return "unreachable";
    }
    const cmd = String(probe.stdout).trim().split("\n").pop()?.trim() ?? "";
    const agentBin = (t.agentCommand ?? "").trim().split(/\s+/)[0]?.split("/").pop() ?? "";
    if (!agentBin || !cmd.includes(agentBin)) {
      console.warn(`[remote-shell] render storm on ${t.name}: the pane is running ${JSON.stringify(cmd)}, not ${agentBin || "a known agent"} - leaving it alone`);
      return "not-ours";
    }
    console.warn(`[remote-shell] render storm on ${session.id} (${t.name}): respawning ${agentBin} and resuming`);
    // respawn-pane -k to a BARE shell (the pane must outlive the agent's next
    // exit), then type the resume command like start() types agentCommand.
    const r = await this.#exec(t, `tmux respawn-pane -k -t ${target}`, { timeoutMs: STORM_EXEC_TIMEOUT_MS });
    if (r.code !== 0) {
      console.warn(`[remote-shell] render storm recovery on ${t.name}: respawn-pane failed (${r.code}) ${(r.stderr || "").trim().slice(-200)}`);
      return "unreachable";
    }
    await new Promise((res) => setTimeout(res, 800));
    // The kill already happened; THIS is the step that brings the agent back,
    // so it is the one that must not be assumed. Unchecked, a resume lost to a
    // dying link reported success, armed the five-minute cooldown, and left the
    // pane at a bare shell with the conversation gone - the worst end state
    // this function can produce, announced as a recovery.
    const resumed = await this.#exec(
      t,
      `tmux send-keys -t ${target} -l ${shellQuote(t.agentResumeCommand)} && tmux send-keys -t ${target} Enter`,
      { timeoutMs: STORM_EXEC_TIMEOUT_MS }
    );
    if (resumed.code !== 0) {
      console.warn(`[remote-shell] render storm recovery on ${t.name}: the agent was stopped but the resume command did not get through (${resumed.code}) ${(resumed.stderr || "").trim().slice(-200)}`);
      this.#push(session, {
        type: "error",
        message: `render storm: the agent was stopped but the resume did not get through - the pane is at a shell. Run \`${t.agentResumeCommand}\` there, or hit Reconnect.`
      });
      this.notify?.({
        title: "Remote shell needs a hand",
        text: `${t.label ?? t.name}: the storming agent was stopped, but the resume command never reached the pane. It is sitting at a bare shell.`,
        tag: `rsh-storm-${t.name}`
      }).catch?.(() => {});
      return "unreachable";
    }
    this.#push(session, { type: "error", message: "render storm: agent restarted and chat resumed" });
    this.notify?.({
      title: "Remote shell recovered",
      text: `${t.label ?? t.name}: the agent TUI entered a render storm; it was restarted and the chat resumed.`,
      tag: `rsh-storm-${t.name}`
    }).catch?.(() => {});
    return "recovered";
  }

  // ── Standing output budget ───────────────────────────────────────────────
  //
  // The mirror of writeRaw's input breaker, and the only part of the storm work
  // that needs NO remote round trip — which is what makes it the path that
  // still works when every exec is timing out. It needs no theory about why the
  // pane is shouting; it refuses to let one pane eat the link. Nothing is lost:
  // tmux holds the content and a reattach replays it.

  #overOutputBudget(session, n) {
    const now = Date.now();
    const b = session.outputBudget ??= { windowAt: now, bytes: 0 };
    if (now - b.windowAt > OUTPUT_BUDGET_WINDOW_MS) {
      b.windowAt = now;
      b.bytes = 0;
    }
    b.bytes += n;
    if (b.bytes < this.attachBudgetBytes) return false;
    b.rate = Math.round(b.bytes / Math.max(1, (now - b.windowAt) / 1000));
    b.windowAt = now;
    b.bytes = 0;
    return true;
  }

  #shedOutput(session) {
    // Idempotent: the kill is asynchronous, so chunks already queued keep
    // arriving and would otherwise re-trip the budget and re-log every 8 MB.
    if (session.attachSuppressedUntil > Date.now()) return;
    const rate = session.outputBudget?.rate ?? 0;
    console.warn(`[remote-shell] output storm on ${session.id} (${session.transport.name}): ~${rate} B/s through the attach client - detaching to protect the link`);
    session.attachSuppressedUntil = Date.now() + ATTACH_SUPPRESS_MS;
    this.detach(session);
    this.#push(session, {
      type: "error",
      message: "output storm: terminal detached to protect the link; reattach to resume"
    });
  }

  shutdownAll() {
    for (const session of this.sessions.values()) {
      session.eventsStopped = true;
      if (session.eventsChild) { try { session.eventsChild.kill(); } catch {} }
      this.#stopPulse(session);
      if (session.reattachTimer) { clearTimeout(session.reattachTimer); session.reattachTimer = null; }
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
