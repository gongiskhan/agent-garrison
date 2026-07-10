// Power Fitting — pure core logic (no IO). Everything here is a pure function of
// its arguments so the busy-signal, countdown, keep-awake, and awake-hours logic
// can be unit-tested with injected clocks and canned inputs. The server (scripts/
// server.mjs) does the actual filesystem / process reads and feeds the results in.
//
// Signal shape (uniform across every busy source):
//   { id, label, blocking: boolean, value, detail? }
// A signal with `blocking: true` (or a truthy `error`) makes the box BUSY. The
// idle watcher only suspends when EVERY signal has been continuously non-blocking
// for `idle_minutes`; ANY evaluation error counts as busy (fail safe → stay awake).

const SESSION_STALE_MS = 10 * 60 * 1000; // a "working" session older than this is stale, not busy

// ── SSH idle parsing (busy signal d) ────────────────────────────────────────
// procps `w` renders the IDLE column in four shapes depending on magnitude:
//   "10.00s"  < 1 min      → seconds.centiseconds
//   "3:20"    < 60 min     → MM:SS
//   "2:01m"   < 48 h       → HH:MM with a trailing "m"
//   "5days"   >= 48 h      → whole days
// Anything unrecognised (including "-") parses to 0 seconds (treated as active).
export function parseIdleSeconds(input) {
  const s = String(input ?? "").trim();
  if (!s || s === "-") return 0;
  let m = s.match(/^(\d+)\s*days?$/i);
  if (m) return Number(m[1]) * 86400;
  m = s.match(/^(\d+):(\d+)m$/i); // HH:MMm
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60;
  m = s.match(/^(\d+(?:\.\d+)?)s$/i); // SS.CCs
  if (m) return Math.round(Number(m[1]));
  m = s.match(/^(\d+):(\d+)$/); // MM:SS
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return 0;
}

// Is a `w` FROM column value a REMOTE (SSH) client rather than the local console?
// Local: "-", an X display (":0"), "localhost", or a tmux/screen wrapper.
export function isRemoteFrom(from) {
  const f = String(from ?? "").trim();
  if (!f || f === "-") return false;
  if (f.startsWith(":")) return false; // local X display, e.g. :0
  if (f === "localhost") return false;
  if (f.startsWith("tmux(") || f.startsWith("screen")) return false;
  return true;
}

// Parse the output of `w -h` (no header row) into structured sessions. The final
// WHAT column can contain spaces, so the first 7 whitespace-delimited fields are
// positional and the remainder is joined back into `what`.
export function parseW(output) {
  const sessions = [];
  for (const raw of String(output ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 7) continue;
    const [user, tty, from, login, idle, jcpu, pcpu] = parts;
    const what = parts.slice(7).join(" ");
    sessions.push({
      user,
      tty,
      from,
      login,
      idle,
      jcpu,
      pcpu,
      what,
      idleSeconds: parseIdleSeconds(idle),
      remote: isRemoteFrom(from)
    });
  }
  return sessions;
}

// ── Individual busy signals (pure) ──────────────────────────────────────────

// (a) dev-env session badges: any session whose lastStatus === "working" and
// whose lastStatusAt is within the 10-minute freshness window.
export function sessionsSignal(stateJson, { now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  let working = 0;
  const projects = stateJson && typeof stateJson === "object" ? stateJson.projects ?? {} : {};
  for (const project of Object.values(projects)) {
    for (const session of Object.values(project?.sessions ?? {})) {
      if (session?.lastStatus !== "working") continue;
      const at = Date.parse(session?.lastStatusAt ?? "");
      if (Number.isFinite(at) && t - at <= SESSION_STALE_MS) working++;
    }
  }
  return { id: "sessions", label: "Working sessions", blocking: working > 0, value: working };
}

// (b) kanban in-flight lanes: a card is in-flight when its status === "running"
// OR it sits in an AGENT list (an in-flight lane) while status is "ok". A card in
// an agent list with status "needs-attention" is parked, not in-flight.
export function kanbanSignal(cards, board) {
  const agentListIds = new Set(
    (board?.lists ?? [])
      .filter((l) => String(l?.kind ?? "").startsWith("agent"))
      .map((l) => l.id)
  );
  let inFlight = 0;
  for (const card of cards ?? []) {
    if (card?.status === "running") {
      inFlight++;
      continue;
    }
    if (agentListIds.has(card?.list) && (card?.status ?? "ok") === "ok") inFlight++;
  }
  return { id: "kanban", label: "In-flight cards", blocking: inFlight > 0, value: inFlight };
}

// (c) presence heartbeats: any recorded {source, at} within the idle window.
export function presenceSignal(records, { now, idleMinutes } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const windowMs = (idleMinutes ?? 30) * 60 * 1000;
  const list = Array.isArray(records) ? records : [];
  const withinWindow = [];
  let lastAt = null;
  const sources = new Map();
  for (const r of list) {
    const at = Date.parse(r?.at ?? "");
    if (!Number.isFinite(at)) continue;
    if (lastAt === null || at > lastAt) lastAt = at;
    const prev = sources.get(r?.source);
    if (prev === undefined || at > prev) sources.set(r?.source, at);
    if (t - at <= windowMs) withinWindow.push(r);
  }
  return {
    id: "presence",
    label: "Presence heartbeat",
    blocking: withinWindow.length > 0,
    value: lastAt ? new Date(lastAt).toISOString() : null,
    detail: {
      withinWindow: withinWindow.length,
      sources: [...sources.entries()].map(([source, at]) => ({ source, at: new Date(at).toISOString() }))
    }
  };
}

// (d) SSH sessions: an ATTACHED but idle session (idle >= window) does NOT block;
// only a session idle for LESS than the window blocks.
export function sshSignal(sessions, { idleMinutes } = {}) {
  const windowSec = (idleMinutes ?? 30) * 60;
  const list = Array.isArray(sessions) ? sessions : [];
  const remote = list.filter((s) => s?.remote || isRemoteFrom(s?.from));
  const active = remote.filter((s) => {
    const idleSeconds = Number.isFinite(s?.idleSeconds) ? s.idleSeconds : parseIdleSeconds(s?.idle);
    return idleSeconds < windowSec;
  });
  return {
    id: "ssh",
    label: "SSH sessions",
    blocking: active.length > 0,
    value: active.length,
    detail: { attached: remote.length }
  };
}

// (e) 1-minute load average over the threshold.
export function loadSignal(load1, threshold) {
  const l = Number(load1);
  const th = Number.isFinite(threshold) ? threshold : 1.0;
  const blocking = Number.isFinite(l) && l > th;
  return { id: "load", label: "Load average (1m)", blocking, value: Number.isFinite(l) ? l : null, detail: { threshold: th } };
}

// (f) Keep Awake pin: active while now < until.
export function keepAwakeSignal(keepAwake, { now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const until = Date.parse(keepAwake?.until ?? "");
  const active = Number.isFinite(until) && t < until;
  return {
    id: "keepAwake",
    label: "Keep Awake",
    blocking: active,
    value: active ? new Date(until).toISOString() : null
  };
}

// Fold every signal into a single verdict. A signal blocks when `blocking` is
// true OR it carries a truthy `error` (evaluation failure → fail safe → busy).
export function aggregateSignals(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const busy = list.some((s) => Boolean(s?.blocking) || Boolean(s?.error));
  return { busy, signals: list };
}

// ── Continuous-clear countdown (drives self-suspend) ────────────────────────
// Pure reducer. `prev.clearSince` is the wall-clock ms at which the box first
// became continuously clear (null while busy). When it has been clear for
// `idle_minutes`, `suspend` flips true. A busy tick resets the timer.
export function tickCountdown(prev, { busy, now, idleMinutes } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const idleMs = (idleMinutes ?? 30) * 60 * 1000;
  if (busy) {
    return { clearSince: null, remainingMs: idleMs, suspend: false };
  }
  const clearSince = Number.isFinite(prev?.clearSince) ? prev.clearSince : t;
  const elapsed = Math.max(0, t - clearSince);
  const remainingMs = Math.max(0, idleMs - elapsed);
  return { clearSince, remainingMs, suspend: elapsed >= idleMs };
}

// ── Awake-hours (approximation, honestly documented) ────────────────────────
// We treat the box as awake for the whole [windowStart, now] span EXCEPT for the
// sleep gaps we actually measured: every `resume-detected` log entry carries a
// `gapSeconds` (wall-vs-monotonic divergence across a real suspend), so the box
// was asleep for [resume.at - gapSeconds, resume.at]. We subtract those clamped
// intervals. Caveat: if the watcher process itself was down (Garrison stopped),
// we cannot observe that gap, so such downtime is counted as awake — this is an
// over-estimate of awake time, not an under-estimate.
export function awakeMillis(log, windowStart, now) {
  const total = Math.max(0, now - windowStart);
  let sleep = 0;
  for (const e of Array.isArray(log) ? log : []) {
    if (e?.kind !== "resume-detected") continue;
    const end = Date.parse(e.at);
    const gap = Number(e.gapSeconds);
    if (!Number.isFinite(end) || !Number.isFinite(gap) || gap <= 0) continue;
    const start = end - gap * 1000;
    const s = Math.max(start, windowStart);
    const en = Math.min(end, now);
    if (en > s) sleep += en - s;
  }
  return Math.max(0, total - sleep);
}

export function awakeHoursSummary(log, { now, dayStartMs } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const dayStart = Number.isFinite(dayStartMs) ? dayStartMs : t - 24 * 3600 * 1000;
  const weekStart = t - 7 * 86400 * 1000;
  return {
    today: awakeMillis(log, dayStart, t) / 3600000,
    last7d: awakeMillis(log, weekStart, t) / 3600000
  };
}

// Local midnight (ms) for the day containing `now`. Kept here so the server and
// tests agree on the day boundary.
export function startOfLocalDay(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
