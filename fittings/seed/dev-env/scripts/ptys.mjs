// dev-env PTY manager — ported from terminal-armory-default scripts/server.mjs
// (the PTY/session half) with the Dev Env contract changes:
//   - Deterministic ids: <sessionId>-claude / <sessionId>-shell, where
//     sessionId is the state.json session UUID. The session↔PTY mapping
//     therefore needs no separate persistence.
//   - PTYs are PERSISTENT: no detach reap on ws close — a PTY lives until
//     session delete/cleanup or server shutdown.
//   - onExit keeps the record (state:"exited", exitCode, buffer retained)
//     instead of deleting it; only killPty(id, {forget:true}) removes
//     view-state.
//   - Rehydration: shell envelopes respawn fresh at the restored cwd with
//     scrollback replay (donor behavior); claude envelopes are PARKED, not
//     spawned — the UI offers one-tap Resume (claude --continue), which
//     pre-loads the persisted scrollback into the new buffer.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import url from "node:url";
import pty from "node-pty";
import {
  deleteInstance,
  cancelInstanceWrite,
  flushInstanceWrites,
  readAllInstances,
  scheduleInstanceWrite
} from "./view-state.mjs";

const FITTING_ID = "dev-env";
// Big enough to replay a full alt-screen redraw (Claude Code, vim, less etc.)
// on genuine reconnect.
const OUTPUT_BUFFER_BYTES = 512 * 1024;
const PERSIST_SCROLLBACK_BYTES = 128 * 1024;
const CLAUDE_ALIVE_TTL_MS = 5000;
// Grace period after spawn before pgrep verdicts are believed — the claude
// command is only written into the shell 250ms after spawn.
const CLAUDE_ALIVE_GRACE_MS = 3000;

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(HERE, "..", "prompts", "browser-pane.md");

export const PTY_ROLES = ["claude", "shell"];

const ptys = new Map(); // ptyId -> record
const parked = new Map(); // ptyId -> persisted claude envelope state (never spawned)

let shuttingDown = false;
let defaultShell = process.env.SHELL || "/bin/zsh";

export function setDefaultShell(shell) {
  if (shell && typeof shell === "string") defaultShell = shell;
}

export function ptyIdFor(sessionId, role) {
  return `${sessionId}-${role}`;
}

// The append prompt teaches Claude to drive the side-by-side browser pane via
// the garrison-browser CLI. No full system prompt replacement — just append.
export function claudeCommand({ resume = false } = {}) {
  const parts = ["claude", "--dangerously-skip-permissions"];
  if (resume) parts.push("--continue");
  parts.push("--append-system-prompt-file", JSON.stringify(PROMPT_PATH));
  return parts.join(" ");
}

// Live cwd of the shell (the user cds around) — best-effort via lsof, falling
// back to the spawn cwd. Runs only at debounced-persist time, never per-write.
function probeCwd(rec) {
  return new Promise((resolve) => {
    const pid = rec.pty?.pid;
    if (typeof pid !== "number" || rec.state !== "running") return resolve(null);
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split("\n").find((l) => l.startsWith("n"));
      resolve(line ? line.slice(1) : null);
    });
  });
}

function persistPty(rec) {
  // `forgotten` blocks the final onData flush of a killed PTY from
  // re-creating the envelope after killPty's deleteInstance.
  if (shuttingDown || rec.forgotten) return;
  scheduleInstanceWrite(FITTING_ID, rec.id, async () => ({
    role: rec.role,
    sessionId: rec.sessionId,
    cwd: (await probeCwd(rec)) || rec.cwd,
    shell: rec.shell,
    command: rec.command || null,
    createdAt: rec.createdAt,
    scrollbackB64: rec.buffer.slice(-PERSIST_SCROLLBACK_BYTES).toString("base64")
  }));
}

function refreshClaudeAlive(rec) {
  if (rec.role !== "claude" || rec.state !== "running") return;
  const now = Date.now();
  if (now - rec.spawnedAtMs < CLAUDE_ALIVE_GRACE_MS) return;
  if (rec.claudeCheckedAt && now - rec.claudeCheckedAt < CLAUDE_ALIVE_TTL_MS) return;
  rec.claudeCheckedAt = now;
  execFile("pgrep", ["-P", String(rec.pty.pid), "-f", "claude"], { timeout: 1500 }, (err, stdout) => {
    if (rec.state !== "running") return;
    rec.claudeAlive = !err && String(stdout).trim().length > 0;
  });
}

export function spawnPty({ sessionId, role, cwd, shell, command, restoredScrollbackB64, restoredMarker }) {
  const id = ptyIdFor(sessionId, role);
  const existing = ptys.get(id);
  if (existing && existing.state === "running") return existing;
  if (existing?.ws && existing.ws.readyState === 1) {
    try { existing.ws.close(); } catch {}
  }
  parked.delete(id);

  const finalShell = shell || defaultShell;
  const finalCwd = cwd && existsSync(cwd) ? cwd : process.env.HOME || "/tmp";
  const term = pty.spawn(finalShell, ["-l"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: finalCwd,
    env: { ...process.env, TERM: "xterm-256color" }
  });

  const rec = {
    id,
    sessionId,
    role,
    cwd: finalCwd,
    shell: finalShell,
    command: command && typeof command === "string" ? command : null,
    pty: term,
    ws: null,
    state: "running",
    exitCode: null,
    lastActivity: Date.now(),
    createdAt: new Date().toISOString(),
    spawnedAtMs: Date.now(),
    buffer: Buffer.alloc(0),
    claudeAlive: role === "claude" ? true : undefined,
    claudeCheckedAt: 0
  };

  if (typeof restoredScrollbackB64 === "string" && restoredScrollbackB64) {
    const restored = Buffer.from(restoredScrollbackB64, "base64");
    const marker = Buffer.from(
      restoredMarker ?? `\r\n\x1b[2m[garrison: session restored — fresh shell at ${rec.cwd}]\x1b[0m\r\n`,
      "utf8"
    );
    rec.buffer = Buffer.concat([restored, marker]).slice(-OUTPUT_BUFFER_BYTES);
  }

  term.onData((data) => {
    rec.lastActivity = Date.now();
    const buf = Buffer.from(data, "utf8");
    rec.buffer = Buffer.concat([rec.buffer, buf]).slice(-OUTPUT_BUFFER_BYTES);
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.send(buf); } catch {}
    }
    persistPty(rec);
  });

  term.onExit(({ exitCode, signal }) => {
    rec.state = "exited";
    rec.exitCode = exitCode;
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.send(JSON.stringify({ type: "exit", exitCode, signal })); } catch {}
    }
    // The record and its view-state envelope are retained — only an explicit
    // killPty(id, {forget:true}) (session delete / cleanup) removes them.
  });

  ptys.set(id, rec);
  persistPty(rec);

  if (rec.command && rec.command.trim()) {
    setTimeout(() => {
      try { term.write(rec.command + "\r"); } catch {}
    }, 250);
  }

  return rec;
}

// Ensure a PTY exists (and is healthy) for the session+role. Handles:
//   running shell           -> returned as-is
//   running claude, dead cli-> re-write the claude command into the same shell
//   exited                  -> respawn fresh at cwd, old buffer replayed
//   parked claude envelope  -> spawn fresh with --continue + persisted scrollback
//   none                    -> spawn fresh (claude gets --continue iff resume)
export function ensurePty({ session, role, resume = false }) {
  const id = ptyIdFor(session.id, role);
  const rec = ptys.get(id);

  if (rec && rec.state === "running") {
    if (role === "claude" && rec.claudeAlive === false) {
      const cmd = claudeCommand({ resume: true });
      rec.command = cmd;
      rec.claudeAlive = true;
      rec.claudeCheckedAt = 0;
      rec.spawnedAtMs = Date.now();
      try { rec.pty.write(cmd + "\r"); } catch {}
    }
    return rec;
  }

  if (rec && rec.state === "exited") {
    const old = rec.buffer;
    ptys.delete(id);
    return spawnPty({
      sessionId: session.id,
      role,
      cwd: session.worktreePath,
      command: role === "claude" ? claudeCommand({ resume: true }) : undefined,
      restoredScrollbackB64: old.length ? old.toString("base64") : undefined
    });
  }

  const envelope = parked.get(id);
  if (role === "claude" && envelope) {
    return spawnPty({
      sessionId: session.id,
      role,
      cwd: session.worktreePath,
      command: claudeCommand({ resume: true }),
      restoredScrollbackB64: typeof envelope.scrollbackB64 === "string" ? envelope.scrollbackB64 : undefined,
      restoredMarker: `\r\n\x1b[2m[garrison: resuming claude session — claude --continue]\x1b[0m\r\n`
    });
  }

  return spawnPty({
    sessionId: session.id,
    role,
    cwd: session.worktreePath,
    command: role === "claude" ? claudeCommand({ resume }) : undefined
  });
}

export function getPty(id) {
  return ptys.get(id) ?? null;
}

export function listPtys() {
  return [...ptys.values()];
}

export function listParked() {
  return [...parked.keys()];
}

export function ptySummary(sessionId, role) {
  const id = ptyIdFor(sessionId, role);
  const rec = ptys.get(id);
  if (rec) {
    refreshClaudeAlive(rec);
    const out = { id, state: rec.state, exitCode: rec.exitCode, createdAt: rec.createdAt };
    if (rec.role === "claude") out.claudeAlive = rec.claudeAlive !== false;
    return out;
  }
  if (parked.has(id)) return { id, state: "persisted" };
  return { state: "none" };
}

export function killPty(id, { forget = false } = {}) {
  const rec = ptys.get(id);
  if (rec) {
    if (forget) rec.forgotten = true;
    if (rec.state === "running") {
      try { rec.pty.kill(); } catch {}
    }
    if (rec.ws && rec.ws.readyState === 1) {
      try { rec.ws.close(); } catch {}
    }
    rec.state = "exited";
    ptys.delete(id);
  }
  if (forget) {
    parked.delete(id);
    cancelInstanceWrite(FITTING_ID, id);
    void deleteInstance(FITTING_ID, id).catch(() => {});
  }
  return Boolean(rec);
}

export function killSessionPtys(sessionId, { forget = false } = {}) {
  for (const role of PTY_ROLES) killPty(ptyIdFor(sessionId, role), { forget });
}

// Boot-time rehydration. `liveSessionIds` is the set of session UUIDs present
// in the RAW state file — envelopes for vanished sessions are orphans and get
// deleted. Shell envelopes respawn (fresh shell + scrollback replay); claude
// envelopes are parked for an explicit user Resume.
export async function rehydratePtys(liveSessionIds) {
  let envelopes = [];
  try {
    envelopes = await readAllInstances(FITTING_ID);
  } catch (err) {
    console.error("[dev-env] view-state rehydrate scan failed:", err);
    return 0;
  }
  let restored = 0;
  for (const envelope of envelopes) {
    const st = envelope.state && typeof envelope.state === "object" ? envelope.state : {};
    const m = envelope.instanceId.match(/^(.+)-(claude|shell)$/);
    const sessionId = m ? m[1] : (typeof st.sessionId === "string" ? st.sessionId : null);
    const role = m ? m[2] : (typeof st.role === "string" ? st.role : null);
    if (!sessionId || !role || !liveSessionIds.has(sessionId)) {
      void deleteInstance(FITTING_ID, envelope.instanceId).catch(() => {});
      continue;
    }
    if (role === "claude") {
      parked.set(envelope.instanceId, st);
      restored++;
      continue;
    }
    try {
      spawnPty({
        sessionId,
        role: "shell",
        cwd: typeof st.cwd === "string" ? st.cwd : undefined,
        shell: typeof st.shell === "string" ? st.shell : undefined,
        restoredScrollbackB64: typeof st.scrollbackB64 === "string" ? st.scrollbackB64 : undefined
      });
      restored++;
    } catch (err) {
      console.error(`[dev-env] rehydrate failed for ${envelope.instanceId}:`, err);
    }
  }
  return restored;
}

// Shutdown path: land pending view-state writes while the ptys (and their
// buffers) are still alive — this is what makes sessions survive the restart.
export async function shutdownPtys() {
  shuttingDown = true;
  try { await flushInstanceWrites(); } catch {}
  for (const rec of ptys.values()) {
    if (rec.state === "running") {
      try { rec.pty.kill(); } catch {}
    }
  }
  ptys.clear();
}
