// The normalised session index: owned shells (from the live SessionManager)
// plus every external CLI/desktop session the four listers can see on this
// node, in ONE Row shape, with one honest status per row. This is what
// GET /index returns and what gets published to the state service's
// shells.sessions doc.
//
// Status precedence (never claim "working" from liveness alone):
//   1. hooks   - agent-start/agent-stop events in the LOCAL events file
//                (~/.garrison/shells/events.jsonl on this node), matched by
//                session_id then by runtime+cwd.
//   2. pane    - owned shells only: the tmux pane's foreground command.
//   3. transcript - external sessions with no hook event: the lister's own
//                mtime-based baseline (see listers/common.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInternalCwd } from "@garrison/claude-pty/claude-sessions.mjs";
import { nodeName } from "./node-identity.mjs";
import { garrisonHome } from "./transports.mjs";
import { commandLine, RUNTIMES } from "./runtimes.mjs";
import { projectName } from "./listers/common.mjs";
import * as claudeLister from "./listers/claude.mjs";
import * as codexLister from "./listers/codex.mjs";
import * as cursorLister from "./listers/cursor.mjs";
import * as geminiLister from "./listers/gemini.mjs";

const CAP = 2000;
const RUNNING_TRUST_MS = 6 * 60 * 60_000; // how long a hook-driven "running" is trusted
const BARE_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "-bash", "-zsh", ""]);
const PANE_WORKING_WINDOW_MS = 20_000;

function normCwd(raw) {
  if (!raw) return null;
  const home = os.homedir();
  const s = String(raw);
  const expanded = s === "~" ? home : s.startsWith("~/") ? path.join(home, s.slice(2)) : s;
  return expanded.replace(/\/+$/, "") || "/";
}

/** Owned shells, straight from the live SessionManager. Reads its raw
 *  records (not just summary()) for pane evidence - the second precedence
 *  tier for a session whose runtime has no hooks (a plain `shell`, or an
 *  agent whose CLI hooks are not installed on this machine). */
function ownedRows(manager, now) {
  if (!manager) return [];
  const rows = [];
  for (const s of manager.sessions.values()) {
    let status = "idle";
    let statusSource = "pane";
    if (s.state === "running") {
      status = "working";
      statusSource = "hooks";
    } else {
      const pc = s.paneCommand || "";
      if (!BARE_SHELLS.has(pc)) {
        status = s.lastOutputAt && now - s.lastOutputAt <= PANE_WORKING_WINDOW_MS ? "working" : "idle";
      }
    }
    rows.push({
      id: `shell:${s.transport.name}:${s.tmuxSession}`,
      runtime: s.runtime || "shell",
      kind: "shell",
      cwd: s.cwd ?? null,
      project: projectName(s.cwd),
      title: s.label,
      status,
      statusSource,
      startedAt: s.createdAt ?? null,
      lastActivityAt: s.lastEventAt ?? s.createdAt ?? null,
      resumable: false,
      attachable: false,
      resumeRef: s.resumeRef ?? null,
      nativeSessionId: s.nativeSessionId ?? null,
      resumeCommand: s.resumeCommand ?? null,
      shell: { transport: s.transport.name, tmuxSession: s.tmuxSession, label: s.label, sessionId: s.id },
      threadId: null,
      claimedBy: null,
      transcript: null
    });
  }
  return rows;
}

/** Tail of the local events file - bounded, so a long-lived node never pays
 *  for the whole history on every index build. */
function readLocalEvents(home, { tailBytes = 256 * 1024 } = {}) {
  const file = path.join(home, "shells", "events.jsonl");
  let text;
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, stat.size - tailBytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch { /* a torn first line at the tail boundary is expected, not an error */ }
  }
  return out;
}

export function applyHookStatus(row, events, now, contextCount = 1) {
  let best = null;
  let bestTs = -Infinity;
  for (const e of events) {
    if (!e || typeof e.event !== "string") continue;
    const matchesId = typeof e.session_id === "string" && e.session_id === row.id && (!e.runtime || e.runtime === row.runtime);
    const hasId = typeof e.session_id === "string" && e.session_id && e.session_id !== "unknown";
    const matchesCtx = !hasId && contextCount === 1 && e.runtime === row.runtime && e.cwd && normCwd(e.cwd) === normCwd(row.cwd);
    if (!matchesId && !matchesCtx) continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || ts < bestTs) continue;
    best = e;
    bestTs = ts;
  }
  if (!best) return row;
  // A later journal completion outranks an earlier start hook (including a
  // Stop hook that was never delivered after a client disconnect).
  const explicitStartOutranksInference = row.statusInferred && best.event === "agent-start"
    && now - bestTs < RUNNING_TRUST_MS;
  if (Date.parse(row.statusAt) > bestTs && !explicitStartOutranksInference) return row;
  if (best.event === "agent-start" && now - bestTs < RUNNING_TRUST_MS) {
    return { ...row, status: "working", statusSource: "hooks", lastActivityAt: new Date(Math.max(bestTs, Date.parse(row.lastActivityAt) || 0)).toISOString() };
  }
  if (best.event === "agent-stop") return { ...row, status: "idle", statusSource: "hooks", lastActivityAt: new Date(Math.max(bestTs, Date.parse(row.lastActivityAt) || 0)).toISOString() };
  if (best.event === "session-end") return { ...row, status: "ended", statusSource: "hooks" };
  return row;
}

/** Which thread (or, via `cardSessionIds`, which kanban card) already owns a
 *  session id or an owned-shell (transport, tmuxSession) pair. File-based and
 *  cheap: one directory of small JSON files, read fresh every index build (no
 *  mtime cache yet - see the plan's G2 note if this becomes a hot path). */
function readThreadClaims(home, localNode) {
  const dir = path.join(home, "web-channel", "threads");
  const bySessionId = new Map();
  const byShellKey = new Map();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { bySessionId, byShellKey };
  }
  for (const f of files) {
    let t;
    try {
      t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const threadId = typeof t?.id === "string" ? t.id : f.replace(/\.json$/, "");
    if (typeof t?.claudeSessionId === "string") bySessionId.set(t.claudeSessionId, threadId);
    for (const sid of Array.isArray(t?.sessionIds) ? t.sessionIds : []) {
      if (typeof sid === "string") bySessionId.set(sid, threadId);
    }
    for (const ctxKey of ["remoteShell", "shell"]) {
      const ctx = t?.context?.[ctxKey];
      if (ctxKey === "shell" && ctx?.node && ctx.node !== localNode) continue;
      if (ctx?.transport && ctx?.tmuxSession) byShellKey.set(`${ctx.transport}\0${ctx.tmuxSession}`, threadId);
    }
  }
  return { bySessionId, byShellKey };
}

/**
 * @param {object} opts
 * @param {import("./sessions.mjs").SessionManager} [opts.manager]
 * @param {number} [opts.windowDays]
 * @param {number} [opts.now]
 * @param {string} [opts.garrisonHomeDir]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {Map<string,string>} [opts.cardSessionIds] sessionId -> cardId (the
 *   caller resolves this from the state service; buildIndex stays
 *   synchronous and state-service-free).
 * @param {Array} [opts.claudeBackgroundAgents] pre-fetched `claude agents
 *   --json` rows, forwarded to the claude lister - see its own doc comment
 *   (that read is a live CLI call, not sandboxable by env; pass `[]` in
 *   tests).
 */
export function buildIndex({
  manager = null,
  windowDays = 5,
  now = Date.now(),
  garrisonHomeDir = garrisonHome(),
  env = process.env,
  cardSessionIds = new Map(),
  claudeBackgroundAgents = undefined
} = {}) {
  const owned = ownedRows(manager, now);
  const { bySessionId, byShellKey } = readThreadClaims(garrisonHomeDir, nodeName({ ...env, GARRISON_HOME: garrisonHomeDir }));
  const ownedIds = new Set(owned.flatMap((r) => [r.nativeSessionId, r.resumeRef].filter((id) => typeof id === "string").map((id) => `${r.runtime}\0${id}`)));
  const events = readLocalEvents(garrisonHomeDir);

  const rows = [];
  for (const r of owned) {
    rows.push({ ...r, threadId: byShellKey.get(`${r.shell.transport}\0${r.shell.tmuxSession}`) ?? null });
  }

  const listerRows = [
    ...claudeLister.list({ windowDays, now, backgroundAgents: claudeBackgroundAgents }),
    ...codexLister.list({ windowDays, now, env }),
    ...cursorLister.list({ windowDays, now, env }),
    ...geminiLister.list({ windowDays, now, env })
  ];
  // Some native clients emit lifecycle metadata before creating their journal.
  // Keep that session visible immediately; a later lister row supplies its title
  // and transcript without changing the identity.
  // IDEs can execute compatibility hooks from another client's configuration.
  // A journal/registry identifies the actual runtime; a hook-only alias must
  // not manufacture another session with the same native identity.
  const ids = new Set([...listerRows.map((r) => r.id), ...owned.flatMap((r) => [r.nativeSessionId, r.resumeRef].filter((id) => typeof id === "string"))]);
  const hookSessions = new Map();
  const cutoff = now - windowDays * 86_400_000;
  for (const e of events) {
    if (!e.session_id || e.session_id === "unknown" || !RUNTIMES[e.runtime] ||
        Date.parse(e.ts) < cutoff || !Number.isFinite(Date.parse(e.ts))) continue;
    if (ids.has(e.session_id)) continue;
    const previous = hookSessions.get(e.session_id);
    // Older observers wrote both native Cursor and Claude-compatible events.
    // Before a journal exists, Cursor's native event resolves that alias.
    if (!previous || (previous.runtime === "claude" && e.runtime === "cursor")) hookSessions.set(e.session_id, e);
  }
  for (const e of hookSessions.values()) {
    listerRows.push({ id: e.session_id, runtime: e.runtime, kind: "cli", cwd: e.cwd ?? null,
      project: projectName(e.cwd), title: null, status: "unknown", statusSource: "hooks",
      startedAt: e.ts, lastActivityAt: e.ts, resumable: e.runtime !== "cursor", attachable: false,
      // A Cursor hook alone does not prove a CLI resume target rather than an
      // IDE composer. Its lister can enable resume once CLI metadata exists.
      resumeRef: e.runtime === "cursor" ? null : e.session_id, transcript: null });
  }
  const contextCounts = new Map();
  for (const r of listerRows) {
    const key = `${r.runtime}\0${normCwd(r.cwd)}`;
    contextCounts.set(key, (contextCounts.get(key) ?? 0) + 1);
  }
  for (const raw of listerRows) {
    if (raw.cwd && isInternalCwd(raw.cwd)) continue;
    // Suppress only a proven session identity. A separate native client in
    // the same project is its own session and must keep its own row.
    if (ownedIds.has(`${raw.runtime}\0${raw.id}`)) continue;
    const row = applyHookStatus(raw, events, now, contextCounts.get(`${raw.runtime}\0${normCwd(raw.cwd)}`));
    const rt = RUNTIMES[row.runtime];
    const resumeCommand = rt && (row.resumable || row.attachable) && row.resumeRef != null
      ? commandLine((row.kind === "bg" ? rt.attachArgv : rt.resumeArgv)(row.resumeRef))
      : null;
    const claimedBy = bySessionId.has(row.id)
      ? { kind: "thread", id: bySessionId.get(row.id) }
      : cardSessionIds.has(row.id)
        ? { kind: "card", id: cardSessionIds.get(row.id) }
        : null;
    rows.push({ ...row, resumeCommand, claimedBy });
  }

  const rank = (status) => (status === "working" ? 0 : status === "idle" ? 1 : status === "unknown" ? 2 : 3);
  rows.sort((a, b) => {
    const d = rank(a.status) - rank(b.status);
    if (d !== 0) return d;
    return (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0);
  });
  return rows.slice(0, CAP);
}
