// Agent-driven Drill Book planning for direct runs: when a project has no
// Book yet (or a feature landed), a headless Claude Code session in the
// project root authors/updates drills/drillbook.yml + drills/pages/*.yml on
// its own judgment - pages, areas, steps (vision vs e2e), and states, the
// same stage-1 "Plan" the garrison-drill duty runs card-side. The Authoring
// UI stays the manual OVERRIDE surface; it is never the required entry path.
//
// Same job discipline as app-runner.mjs: one job per project root at a time,
// in-memory, registered before any await; transcript streams to
// <garrison-home>/drill/plan/<project>-<hash>-<ts>.log; sentinel contract on
// the FINAL line (DRILL_PLAN_OK=<pages> / DRILL_PLAN_FAILED=<reason>, last
// one printed wins). The sentinel is never trusted blind: an OK needs page
// files on disk AND (unless the agent claims OK=0, "already covered") a real
// change under drills/ since the job started (verify-step discipline - a
// pre-existing Book must not vouch for a no-op agent). Each job also writes
// a pid record under <garrison-home>/drill/plan/jobs/ so a restarted server
// can reap an orphaned agent instead of double-spawning into the same repo.
// No model/effort pins - the agent session inherits the user's defaults.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRunSkill } from "./projects.mjs";
import { listPages } from "./store.mjs";
import { drillHomeDir } from "./runs-store.mjs";

const jobs = new Map(); // root -> job

function logDir() {
  return path.join(drillHomeDir(), "plan");
}

// Basename + full-root hash, same reasoning as app-runner: distinct roots
// sharing a basename must never share a log file.
function safeName(root) {
  const base = path.basename(root).replace(/[^A-Za-z0-9_-]/g, "") || "project";
  return `${base}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

// A hostile/broken env value must degrade to the default, not to a NaN
// deadline that never trips (a hung agent would stay "planning" forever).
// 30min default: a FULL plan of a real project is a long agent session
// (explore the codebase, probe the live app, author every page file) -
// a live 15min run on a mid-sized monorepo was killed still working.
function defaultTimeoutMs() {
  const t = Number(process.env.DRILL_PLAN_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 1800000;
}

// ── orphan pid records ──────────────────────────────────────────────────────
// The job Map dies with the server process, but the spawned agent does not:
// it reparents and keeps authoring the repo. The pid record is the durable
// trace that lets the next server process reap it - without this, the UI's
// "retry" after a restart double-spawns two agents concurrently rewriting
// the same drills/ tree.

function jobRecordPath(root) {
  return path.join(logDir(), "jobs", `${safeName(root)}.json`);
}

async function writeJobRecord(job) {
  const file = jobRecordPath(job.root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: job.agentPid, root: job.root, startedAt: job.startedAt, logFile: job.logFile }), "utf8");
}

function clearJobRecord(root) {
  return fs.unlink(jobRecordPath(root)).catch(() => {});
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A record from before the last machine boot cannot name a live agent (pids
// do not survive reboot) - never signal a recycled pid.
function recordNamesLiveAgent(rec) {
  const bootTime = Date.now() - os.uptime() * 1000;
  return !!rec.pid && Date.parse(rec.startedAt) > bootTime && pidAlive(rec.pid);
}

// Called once at server boot: kill any plan agent a previous server process
// left running, then clear the records. Returns the reaped records.
export async function reapOrphanPlanAgents() {
  const dir = path.join(logDir(), "jobs");
  let entries;
  try { entries = await fs.readdir(dir); } catch { return []; }
  const reaped = [];
  for (const f of entries.filter((x) => x.endsWith(".json"))) {
    const file = path.join(dir, f);
    try {
      const rec = JSON.parse(await fs.readFile(file, "utf8"));
      if (recordNamesLiveAgent(rec)) {
        try { process.kill(rec.pid, "SIGKILL"); reaped.push(rec); } catch { /* raced its exit */ }
      }
    } catch { /* unreadable record - just clear it */ }
    await fs.unlink(file).catch(() => {});
  }
  return reaped;
}

// ── plan prompt ─────────────────────────────────────────────────────────────
// The Book format spec the agent writes against - kept next to the code that
// parses it (store.mjs/compile.mjs) so drift is a one-file diff. Steps get no
// fabricated `assertion` (graduation sets it later, B8) and ids are filename-
// safe (store.safeId rejects anything else).
function planPrompt(root, { brief, runSkill }) {
  const goal = brief
    ? [
        `Mode: UPDATE. A change landed and the Drill Book must cover it. The change brief:`,
        ``,
        `${brief}`,
        ``,
        `Update the Book for this change: add/update the pages, areas, steps, and states it touches.`,
        `Preserve everything else - existing page files, step ids, manual edits, and the Book's`,
        `settings (autonomy, viewports, fullDrill, globalRules) stay unless the change invalidates them.`
      ]
    : [
        `Mode: FULL PLAN. Author the Drill Book for the ENTIRE project on your best judgment - the works:`,
        `every real user-facing page, what matters on it, how to verify it (functionality, UX quality,`,
        `visual polish, responsive behavior), and the page states worth pinning (logged out, empty,`,
        `populated, error). If a Book already exists, extend and correct it - never discard manual work.`
      ];
  return [
    `You are Drill's planning stage: author the page-level visual QA plan (the Drill Book) for the app in this repo.`,
    `Project root: ${root}`,
    ``,
    ...goal,
    ``,
    `How to work:`,
    `1. Explore the codebase first: the router/pages structure, navigation, and main user flows tell you the real page list. Plan pages a USER visits - not API routes, not build artifacts.`,
    runSkill
      ? `2. Probe the live app when useful: if it is not serving, you may start it through the "${runSkill}" skill (.claude/skills/${runSkill}/SKILL.md - start long-running processes detached with output to a log file). Visiting real pages sharpens the plan, but a code-only plan is acceptable.`
      : `2. Probe the live app when useful; there is no run-* skill in this repo, so only use the app if it is already serving. A code-only plan is acceptable.`,
    `3. Write the plan as YAML files in THIS repo (create the directories if missing):`,
    `   - drills/drillbook.yml - the Book`,
    `   - drills/pages/<pageId>.yml - one file per page`,
    ``,
    `drills/drillbook.yml fields:`,
    `  app: { name: <app name>, url: <base URL the app serves on, from the run skill/dev config, e.g. http://localhost:3000 - if the real URL cannot be determined from the code or run skill, leave url: '' and Drill adopts the true URL when it starts the app through the run skill> }`,
    `  fullDrill: true | false      (keep the existing value; default true for a fresh Book)`,
    `  autonomy: gated | auto       (keep existing; default gated)`,
    `  viewports: [desktop]         (add tablet/mobile ONLY when the app clearly targets them)`,
    `  globalRules: <short prose rules that apply to every page - tone, brand, layout invariants; "" if none>`,
    `  dispatch: manual             (keep existing)`,
    `  pages: [{ id, title, path, mode: steps, selected: true }]   (the ledger: one entry per page FILE, and each entry's id MUST equal that file's id - same charset rule as below)`,
    ``,
    `drills/pages/<pageId>.yml fields (EVERY step field below is REQUIRED on every step - a step missing a field may be skipped or misrouted by the runner):`,
    `  id: <pageId>                 (MUST match the filename and use only [A-Za-z0-9_-])`,
    `  title: <human title>`,
    `  path: </route/path>          (resolved against app.url)`,
    `  mode: steps`,
    `  areas:                       (keep EXACTLY what the page file already has - human-picked on the live screencast, never remove or rewrite them; for a NEW page write areas: [] and use area: 0 steps)`,
    `  steps:                       (the heart of the plan - be thorough, cover the page)`,
    `    - id: <slug, unique in the page, [A-Za-z0-9_-]>`,
    `      area: 0                  (0 = page-level; only reference an area number that already exists)`,
    `      mode: vision | e2e       (vision = needs model judgment: visual quality, generated content, "looks right". e2e = a deterministic locator + assertion is evident from the code. When unsure, vision.)`,
    `      enabled: true`,
    `      viewports: <copy the Book's viewports list here, unless the step is genuinely specific to one viewport>`,
    `      state: default           (most steps belong to state: default - the direct Run executes default-state steps; a state-scoped step runs only in a state-targeted run, so scope a step to a state id from states[] only when it is meaningless outside that state)`,
    `      description: <the check, written as a concrete acceptance criterion an agent can verify on the rendered page>`,
    `      tags: []`,
    `      judgment: true | false   (true when the check needs ONGOING model judgment even after graduation - subjective quality, generative output)`,
    `      (NEVER write an "assertion" field - graduation sets it after a passing run)`,
    `  states:                      (only for pages with meaningfully distinct states)`,
    `    - id: <slug>`,
    `      label: <human label>`,
    `      reachPath: [{ id: <slug>, description: <one natural-language action an agent executes to move toward the state, e.g. "log in as the demo user"> }]`,
    ``,
    `Write valid YAML; after writing, re-read every file you wrote and confirm it parses. Keep descriptions self-contained - the run agent sees the description and the page, nothing else.`,
    ``,
    `Final line contract (exactly one of these, as the LAST line you print):`,
    `- Success: DRILL_PLAN_OK=<number of page files you authored or updated>`,
    `- Already covered (you verified the Book and changed NOTHING): DRILL_PLAN_OK=0`,
    `- Failure: DRILL_PLAN_FAILED=<one-line reason>`
  ].join("\n");
}

// Final-line contract: when both sentinels appear (an early failure the agent
// then recovered from, or the reverse), the one printed LAST wins.
function parseSentinel(logText) {
  let ok = null, okIdx = -1, failed = null, failIdx = -1;
  for (const m of logText.matchAll(/^DRILL_PLAN_OK=(\S+)\s*$/gm)) { ok = m[1]; okIdx = m.index; }
  for (const m of logText.matchAll(/^DRILL_PLAN_FAILED=(.+)$/gm)) { failed = m[1].trim(); failIdx = m.index; }
  if (ok !== null && failed !== null) {
    if (okIdx > failIdx) failed = null;
    else ok = null;
  }
  return { ok, failed };
}

// Exported so the server can serve a job's log tail directly - the error
// strings elsewhere in this app already point the user at "the plan log";
// this is what finally lets that be a real link instead of a dead end.
export async function logTail(file, bytes = 64000) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.length > bytes ? text.slice(-bytes) : text;
  } catch {
    return "";
  }
}

// ── disk-evidence snapshot ──────────────────────────────────────────────────
// mtime+size of every file under drills/, taken before the agent spawns. An
// OK sentinel claiming n>0 authored pages must be backed by at least one
// changed/added/removed file - a pre-existing Book satisfying the pages>0
// check is NOT evidence the agent did anything (the UPDATE-mode no-op hole).

async function snapshotDrills(root) {
  const out = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { const s = await fs.stat(p); out.set(p, `${s.mtimeMs}:${s.size}`); } catch { /* raced a delete */ }
      }
    }
  }
  await walk(path.join(root, "drills"));
  return out;
}

async function drillsChangedSince(root, before) {
  const after = await snapshotDrills(root);
  if (after.size !== before.size) return true;
  for (const [file, sig] of after) {
    if (before.get(file) !== sig) return true;
  }
  return false;
}

export function publicPlanJob(job) {
  if (!job) return null;
  // proc (the live ChildProcess) and snapshot (a Map - JSON.stringify would
  // silently emit "{}") never belong in the wire payload.
  const { proc, snapshot, ...rest } = job;
  return rest;
}

export function getPlanJob(root) {
  return jobs.get(root) ?? null;
}

// Kick (or return the already-running) plan job for `root`. Resolution
// happens in a detached poll loop; callers watch GET /api/plan/status.
export async function startPlan({ root, brief = null, timeoutMs = defaultTimeoutMs() }) {
  const existing = jobs.get(root);
  if (existing && existing.status === "planning") return existing;

  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  // A pinned session id (accepted by `-p`, not banned by the headless-purge
  // policy) is what lets progress be derived from the session's OWN
  // transcript JSONL - see planProgress - without adding any banned flag
  // (--output-format stream-json) to the model-call surface.
  const sessionId = randomUUID();
  // Registered BEFORE any await: two concurrent kicks for the same root must
  // not both pass the in-flight guard and spawn two agent sessions.
  const job = {
    root, mode: brief ? "update" : "full", brief, status: "planning",
    startedAt, endedAt: null, deadlineAt, canceledAt: null, sessionId, logFile: null, error: null,
    pages: null, noop: false, agentPid: null, agentExited: null, proc: null, snapshot: null
  };
  jobs.set(root, job);
  const finish = (status, patch = {}) => {
    Object.assign(job, patch, { status, endedAt: new Date().toISOString() });
    clearJobRecord(root);
  };

  let logStream;
  try {
    // If a pid record survived (a previous server process died mid-plan and
    // the boot reap has not run for this root), reap that agent NOW - never
    // let two sessions author the same drills/ tree concurrently.
    try {
      const rec = JSON.parse(await fs.readFile(jobRecordPath(root), "utf8"));
      if (recordNamesLiveAgent(rec)) { try { process.kill(rec.pid, "SIGKILL"); } catch { /* raced its exit */ } }
      await clearJobRecord(root);
    } catch { /* no record - the normal case */ }

    job.snapshot = await snapshotDrills(root);
    await fs.mkdir(logDir(), { recursive: true });
    job.logFile = path.join(logDir(), `${safeName(root)}-${Date.now()}.log`);
    await fs.writeFile(job.logFile, `[drill plan] ${startedAt} mode=${job.mode} root=${root} session=${sessionId}\n`, "utf8");
    logStream = await fs.open(job.logFile, "a");
  } catch (err) {
    // Must not leave the placeholder stuck in "planning" - it would block
    // every future kick for this root.
    finish("failed", { error: err.message });
    return job;
  }
  const closeLog = () => logStream.close().catch(() => {});

  // A cancel can land in the window between registering the job and actually
  // spawning (the awaits above) - never spawn an agent for a job that is no
  // longer "planning" by the time setup finished.
  if (job.status !== "planning") {
    closeLog();
    return job;
  }

  const bin = process.env.DRILL_AGENT_CMD || "claude";
  const proc = spawn(bin, [
    "-p", planPrompt(root, { brief, runSkill: findRunSkill(root) }),
    "--permission-mode", "bypassPermissions",
    "--session-id", sessionId
  ], {
    cwd: root,
    stdio: ["ignore", logStream.fd, logStream.fd],
    env: process.env
  });
  job.proc = proc;
  job.agentPid = proc.pid;
  // 'error' (e.g. binary not on PATH) never fires 'exit', so both handlers
  // close the log handle (close is idempotent-guarded by the catch). A
  // signal death passes code=null - record it as "signal:<name>" so the poll
  // loop's exited check still trips (an OOM-killed agent must fail fast, not
  // sit "planning" until the deadline while blocking every re-kick).
  proc.on("error", (err) => { closeLog(); finish("failed", { error: `${bin}: ${err.message}` }); });
  proc.on("exit", (code, signal) => { job.agentExited = code ?? `signal:${signal}`; closeLog(); });
  // The record must be durable BEFORE the kick response goes out: a server
  // that dies right after spawning (crash, OOM, restart) with the write
  // still queued leaves an unreapable orphan - the double-spawn this record
  // exists to prevent. A record-write failure still must not kill the plan.
  await writeJobRecord(job).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  (async () => {
    while (job.status === "planning") {
      // Sentinels are judged ONLY after the agent exits. The contract is
      // "the LAST line you print" and a -p session exits right after it -
      // parsing mid-run would race an early FAILED line the agent then
      // recovers from (or a half-flushed OK) into a wrong terminal state.
      // The exit flag is captured BEFORE the read, so the log is complete
      // when parsed and last-sentinel-wins is deterministic. Costs at most
      // one 2s poll of extra latency after exit.
      const exitedAtRead = job.agentExited;
      if (exitedAtRead !== null) {
        const sentinel = parseSentinel(await logTail(job.logFile));
        if (sentinel.failed) {
          finish("failed", { error: sentinel.failed });
        } else if (sentinel.ok) {
          // Verify-step discipline: the sentinel claims a Book exists -
          // check the disk (pinned root) before believing it. OK=0 is the
          // agent's explicit "already covered, changed nothing" claim; any
          // other OK must be backed by an actual change under drills/.
          const pages = await listPages(root).catch(() => []);
          const claimedNoop = Number(sentinel.ok) === 0;
          if (pages.length === 0) {
            finish("failed", { error: "agent reported DRILL_PLAN_OK but no readable page files exist under drills/pages/ (see log)" });
          } else if (!claimedNoop && !(await drillsChangedSince(root, job.snapshot))) {
            finish("failed", { error: `agent reported DRILL_PLAN_OK=${sentinel.ok} but nothing under drills/ changed (see log)` });
          } else {
            finish("done", { pages: pages.length, noop: claimedNoop });
          }
        } else {
          finish("failed", { error: `agent session ended (exit ${exitedAtRead}) without printing a DRILL_PLAN_OK/DRILL_PLAN_FAILED line (see log)` });
        }
        break;
      }
      if (Date.now() > deadline) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish("failed", { error: `planning did not finish within ${Math.round(timeoutMs / 1000)}s (see log)` });
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })().catch((err) => finish("failed", { error: err.message }));

  return job;
}

// ── cancel ───────────────────────────────────────────────────────────────
// A distinct terminal status, never "failed" - a user-requested stop is not
// an error, and the UI/API must say so honestly. Unlike the deadline timeout
// (which also SIGKILLs), this is reachable at any point in a live plan, so a
// pre-spawn race (see the guard in startPlan) is the only other place a plan
// job can end without ever running an agent.
export async function cancelPlan(root) {
  const job = jobs.get(root);
  if (!job || job.status !== "planning") return { canceled: false, job: publicPlanJob(job) };
  try { job.proc?.kill("SIGKILL"); } catch { /* already gone */ }
  Object.assign(job, { status: "canceled", error: null, canceledAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  await clearJobRecord(root);
  return { canceled: true, job: publicPlanJob(job) };
}

// ── progress ─────────────────────────────────────────────────────────────
// Durable, on-disk evidence of whether a running plan is alive or hung - a
// healthy 11-minute plan and a genuine hang were otherwise indistinguishable
// (the dogfood bug this exists to close). Every field degrades to null/0
// rather than throwing: progress is a nice-to-have overlay on the job, never
// a reason the status route itself can fail.

function transcriptProjectsDir() {
  return process.env.DRILL_PLAN_TRANSCRIPT_DIR
    || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// The CLI slugs cwd into the transcript directory name; rather than
// reimplementing that rule, glob one level down for the pinned session id -
// exactly one project directory holds any given session's transcript.
async function findTranscriptFile(sessionId) {
  const base = transcriptProjectsDir();
  let dirs;
  try { dirs = await fs.readdir(base, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(base, d.name, `${sessionId}.jsonl`);
    try { await fs.access(candidate); return candidate; } catch { /* not here */ }
  }
  return null;
}

// A short human-readable description of the most recent transcript event -
// the latest assistant tool_use (rendered as "<ToolName>: <input hint>") or
// assistant text. Tolerates a half-written last line (the transcript is
// being appended to live) by scanning backward and skipping parse failures.
function summarizeLastActivity(tailText) {
  const lines = tailText.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt;
    try { evt = JSON.parse(lines[i]); } catch { continue; }
    const content = evt?.message?.content;
    if (!Array.isArray(content)) continue;
    const toolUse = content.find((b) => b?.type === "tool_use");
    if (toolUse) {
      const input = toolUse.input ?? {};
      const hint = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? "";
      return hint ? `${toolUse.name}: ${String(hint).slice(0, 120)}` : String(toolUse.name);
    }
    const text = content.find((b) => b?.type === "text")?.text;
    if (text) return String(text).trim().slice(0, 160) || null;
  }
  return null;
}

export async function planProgress(job) {
  const out = {
    transcriptBytes: 0, transcriptEvents: 0, lastActivityAt: null, lastActivity: null,
    drillsFilesChanged: 0, pagesAuthored: 0
  };
  if (!job) return out;
  try {
    const pages = await listPages(job.root);
    out.pagesAuthored = pages.length;
  } catch { /* no readable pages yet - stays 0 */ }
  try {
    if (job.snapshot) {
      const after = await snapshotDrills(job.root);
      let changed = 0;
      for (const [file, sig] of after) if (job.snapshot.get(file) !== sig) changed++; // added or modified
      for (const file of job.snapshot.keys()) if (!after.has(file)) changed++; // removed
      out.drillsFilesChanged = changed;
    }
  } catch { /* best-effort */ }
  try {
    const file = job.sessionId && await findTranscriptFile(job.sessionId);
    if (file) {
      const stat = await fs.stat(file);
      out.transcriptBytes = stat.size;
      out.lastActivityAt = stat.mtime.toISOString();
      const tail = await logTail(file, 32000);
      out.transcriptEvents = tail.split("\n").filter(Boolean).length;
      out.lastActivity = summarizeLastActivity(tail);
    }
  } catch { /* transcript absent/unreadable - progress stays at defaults */ }
  return out;
}
