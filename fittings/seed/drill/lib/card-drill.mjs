// Card-driven drill (the Kanban "Send to Drill" button's engine).
//
// A card that reached `done` describes a change that landed. Testing it is a
// three-step chore nobody does by hand: plan the checks for THAT change,
// run them, and come back hours later to read the verdict. This module is
// those three steps, unattended:
//
//   1. PLAN   — an UPDATE-mode plan agent (planner.mjs) with the card's change
//               brief. It explores the running app and adds/updates exactly the
//               pages, steps and states the change touched.
//   2. SCOPE  — diff drills/pages/ before vs after to learn WHICH pages the
//               plan just touched, and run only those. A card-scoped drill that
//               re-ran the whole Book would cost hours and bury the one thing
//               the card changed under 300 unrelated checks.
//   3. RUN    — the standard run, gate bypassed. "Run it automatically" is the
//               explicit ask of this flow, and the human approval already
//               happened when they pressed the button; a gate here would just
//               park the job waiting for a click that never comes.
//
// Then it notifies (broadcast.mjs) — on success AND on every failure path,
// including its own. A job that dies silently is the one failure mode that
// makes the whole feature untrustworthy, so every terminal path below routes
// through finish(), and finish() always broadcasts.
//
// Job records are durable (<drill-home>/card-drills/<id>.json) so a restart,
// a second device, or the Kanban card itself can read the state of a job this
// process no longer holds in memory.

import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "./ulid.mjs";
import { drillHomeDir, getDrillRun } from "./runs-store.mjs";
import { getDrillBook, listPages } from "./store.mjs";
import { startPlan, getPlanJob } from "./planner.mjs";
import { broadcastOutcome, summarizeReceipts } from "./broadcast.mjs";
import { toTailnetUrl } from "./tailnet-serve.mjs";

const jobs = new Map(); // jobId -> job (in-memory mirror of the durable record)

const POLL_MS = Number(process.env.DRILL_CARD_POLL_MS) > 0 ? Number(process.env.DRILL_CARD_POLL_MS) : 3000;
// A run has no deadline of its own (a full page sweep legitimately takes
// hours), but an unbounded poll would keep a crashed/vanished run "running"
// forever and the card would never hear anything. 6h, overridable.
function runTimeoutMs() {
  const t = Number(process.env.DRILL_CARD_RUN_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 21600000;
}

function jobsDir() {
  return path.join(drillHomeDir(), "card-drills");
}

function safeJobId(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(id)) throw new Error(`invalid job id: ${id}`);
  return safe;
}

function jobPath(id) {
  return path.join(jobsDir(), `${safeJobId(id)}.json`);
}

async function persist(job) {
  const file = jobPath(job.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function getCardDrillJob(id) {
  const live = jobs.get(id);
  if (live) return live;
  try {
    return JSON.parse(await fs.readFile(jobPath(id), "utf8"));
  } catch {
    return null;
  }
}

export async function listCardDrillJobs({ cardId = null } = {}) {
  let files = [];
  try {
    files = (await fs.readdir(jobsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(jobsDir(), f), "utf8"));
      const live = jobs.get(rec.id);
      const job = live ?? rec;
      if (!cardId || job.card?.id === cardId) out.push(job);
    } catch {
      /* skip a torn record */
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/**
 * Close out jobs left mid-flight by a previous server process. The chain lives in
 * memory (a detached async driver), so a restart kills it silently — and the CARD
 * would then sit at "planning" forever with its Send-to-Drill button disabled,
 * waiting on a job nobody is running. Every non-terminal record at boot is an
 * orphan by construction (this process has started nothing yet), so each one is
 * finished honestly AND notified: an interrupted drill is exactly the case where
 * a silent record leaves you believing a test is still coming.
 *
 * Returns the ids it closed.
 */
export async function reapOrphanCardDrills({ fetchImpl = fetch } = {}) {
  let files = [];
  try {
    files = (await fs.readdir(jobsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const closed = [];
  for (const f of files) {
    let rec;
    try {
      rec = JSON.parse(await fs.readFile(path.join(jobsDir(), f), "utf8"));
    } catch {
      continue; // torn record
    }
    if (!rec?.id || TERMINAL_STATES.has(rec.state)) continue;
    jobs.set(rec.id, rec);
    await finish(
      rec,
      { state: "error", error: "the Drill fitting restarted while this card's drill was in flight - nothing finished it" },
      { fetchImpl }
    );
    closed.push(rec.id);
  }
  return closed;
}

/** The in-flight job for a card, if any — the guard against double-dispatch. */
export function activeJobForCard(cardId) {
  for (const job of jobs.values()) {
    if (job.card?.id === cardId && !TERMINAL_STATES.has(job.state)) return job;
  }
  return null;
}

const TERMINAL_STATES = new Set(["passed", "partial", "failed", "error"]);

// ── page-scope diff ─────────────────────────────────────────────────────────
// mtime+size per page file, same evidence shape planner.mjs uses to prove an
// agent actually did something. Here it answers a different question: which
// pages did this change's plan touch? An untouched page is not evidence about
// this card, so running it would cost model calls to re-assert what the card
// never affected.

export async function snapshotPages(root) {
  const dir = path.join(root, "drills", "pages");
  const out = new Map();
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !/\.ya?ml$/i.test(e.name)) continue;
    try {
      const s = await fs.stat(path.join(dir, e.name));
      out.set(e.name.replace(/\.ya?ml$/i, ""), `${s.mtimeMs}:${s.size}`);
    } catch {
      /* raced a delete */
    }
  }
  return out;
}

/** Page ids added or modified between two snapshots. Pure. */
export function changedPageIds(before, after) {
  const out = [];
  for (const [id, sig] of after) if (before.get(id) !== sig) out.push(id);
  return out.sort();
}

/**
 * The pages the card's drill should run, and WHY that set was chosen. Pure, so
 * the fallback rule is testable: a plan that changed nothing ("already
 * covered") still has to run something, or the card gets a verdict that proves
 * nothing — and the honest fallback is the Book's own selected pages.
 */
export function resolveRunScope({ changed, book, allPageIds }) {
  if (changed.length) return { pageIds: changed, scope: "changed-pages" };
  const selected = (book?.pages ?? [])
    .filter((p) => p && p.selected !== false && typeof p.id === "string")
    .map((p) => p.id);
  if (selected.length) return { pageIds: selected, scope: "book-selection" };
  return { pageIds: [...allPageIds], scope: "all-pages" };
}

// A plan may finish authoring after its integrity guard quarantines a finding,
// restores a poisoned rewrite, or downgrades an unreceipted assertion. Keep the
// Book for review, but do not let the unattended card flow run it immediately.
export function planNeedsAttentionError(planJob) {
  if (!planJob?.needsAttention) return null;
  const count = Array.isArray(planJob.warnings) ? planJob.warnings.length : 0;
  return `planning finished with integrity warnings${count ? ` (${count})` : ""}; review the Drill Book before running it`;
}

// ── the job ─────────────────────────────────────────────────────────────────

function newJob({ card, brief, project, boardUrl }) {
  return {
    id: ulid(),
    kind: "card-drill",
    state: "planning", // planning | running | passed | partial | failed | error
    card: {
      id: card.id,
      title: card.title ?? null,
      project: card.project ?? project ?? null,
      originChannel: card.originChannel ?? null
    },
    project,
    brief,
    boardUrl: boardUrl ?? null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    planLogFile: null,
    scope: null,
    pageIds: [],
    runId: null,
    runUrl: null,
    outcome: null,
    notified: null,
    error: null
  };
}

/** Public projection — the brief can be long, so it never rides the wire. */
export function publicCardDrillJob(job) {
  if (!job) return null;
  const { brief, ...rest } = job;
  return { ...rest, briefChars: typeof brief === "string" ? brief.length : 0 };
}

/**
 * Kick the whole plan → run → notify chain for a card. Returns the registered
 * job immediately; the chain runs detached and reports through the job record
 * plus the broadcast. Never throws for a downstream failure — a job that
 * cannot even start still lands a terminal record and still notifies.
 */
export async function startCardDrill({ card, brief, project, boardUrl, drillBaseUrl, fetchImpl = fetch }) {
  const existing = activeJobForCard(card.id);
  if (existing) return { job: existing, started: false };

  const job = newJob({ card, brief, project, boardUrl });
  jobs.set(job.id, job);
  await persist(job).catch(() => {});

  void drive(job, { drillBaseUrl, fetchImpl }).catch(async (err) => {
    // The chain's own catch-all: drive() guards each stage, so reaching here
    // means something outside them threw. Still terminal, still notified.
    await finish(job, { state: "error", error: err?.message || String(err) }, { fetchImpl });
  });

  return { job, started: true };
}

async function setState(job, patch) {
  Object.assign(job, patch);
  await persist(job).catch(() => {});
}

// Every terminal path funnels here: stamp the record, then broadcast. The
// broadcast is AWAITED (unlike the usual fire-and-forget) so the job record's
// `notified` receipts are truthful when the job reads terminal.
async function finish(job, { state, error = null, outcome = null }, { fetchImpl = fetch } = {}) {
  // The card link is opened from a phone on the tailnet, so it must carry the
  // tailnet host, not the loopback address `kanbanBaseUrl()` reads out of the
  // status file (127.0.0.1 resolves to the phone itself). Rehost the board URL
  // through `tailscale serve` when it is mapped; fall back to loopback when
  // there is no tailnet. new URL().toString() appends a trailing slash, so trim
  // it before joining the hash route or the link doubles the slash.
  let cardLink = null;
  if (job.boardUrl && job.card?.id) {
    const board = ((await toTailnetUrl(job.boardUrl).catch(() => null)) || job.boardUrl).replace(/\/+$/, "");
    cardLink = `${board}/#/cards/${job.card.id}`;
  }
  const links = {
    ...(job.runUrl ? { run: job.runUrl } : {}),
    ...(cardLink ? { card: cardLink } : {})
  };
  const finalOutcome = outcome ?? { state, headline: error ?? null, runId: job.runId ?? null, findings: 0 };
  finalOutcome.state = state;
  finalOutcome.runId = finalOutcome.runId ?? job.runId ?? null;
  await setState(job, { state, error, outcome: finalOutcome, endedAt: new Date().toISOString() });
  let receipts = [];
  try {
    receipts = await broadcastOutcome({
      card: { ...job.card, title: job.card?.title },
      outcome: finalOutcome,
      links,
      jobId: job.id,
      fetchImpl
    });
  } catch (err) {
    receipts = [{ means: "broadcast", ok: false, error: err?.message || String(err) }];
  }
  await setState(job, { notified: receipts });
  console.log(`[drill] card-drill ${job.id} (${job.card?.id}) -> ${state}: ${summarizeReceipts(receipts)}`);
  jobs.delete(job.id);
  return job;
}

async function drive(job, { drillBaseUrl, fetchImpl }) {
  const root = job.project;

  // ── 1. plan ───────────────────────────────────────────────────────────────
  const before = await snapshotPages(root);
  let planJob;
  try {
    planJob = await startPlan({ root, brief: job.brief, drillBaseUrl });
  } catch (err) {
    return finish(job, { state: "error", error: `plan could not start: ${err?.message || err}` }, { fetchImpl });
  }
  await setState(job, { planLogFile: planJob.logFile ?? null });
  // planner owns its own timeout + failure states; poll until it leaves
  // "planning" rather than imposing a second, competing deadline.
  while (getPlanJob(root)?.status === "planning") {
    await sleep(POLL_MS);
  }
  const settled = getPlanJob(root);
  if (!settled || settled.status !== "done") {
    return finish(
      job,
      { state: "error", error: `planning ${settled?.status ?? "vanished"}: ${settled?.error ?? "no plan job"}` },
      { fetchImpl }
    );
  }

  // ── 2. scope ──────────────────────────────────────────────────────────────
  const integrityError = planNeedsAttentionError(settled);
  if (integrityError) {
    return finish(job, { state: "error", error: integrityError }, { fetchImpl });
  }

  const after = await snapshotPages(root);
  const changed = changedPageIds(before, after);
  const book = await getDrillBook(root).catch(() => null);
  const allPages = (await listPages(root).catch(() => [])).map((p) => p.id);
  const { pageIds, scope } = resolveRunScope({ changed, book, allPageIds: allPages });
  if (!pageIds.length) {
    return finish(job, { state: "error", error: "the plan produced no pages to run" }, { fetchImpl });
  }
  await setState(job, { state: "running", scope, pageIds });

  // ── 3. run ────────────────────────────────────────────────────────────────
  // background:true + poll the record: the alternative (a synchronous POST)
  // holds one HTTP response open for the whole run, and undici's 5-minute
  // headers timeout would abort it long before a real run finishes.
  let runId;
  try {
    const res = await fetchImpl(`${drillBaseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageIds,
        viewports: Array.isArray(book?.viewports) && book.viewports.length ? book.viewports : ["desktop"],
        project: root,
        confirmed: true, // the human approval was the button; see the header note
        background: true,
        contextTag: "drill-card"
      })
    });
    if (!res.ok) {
      const body = await res.text();
      return finish(job, { state: "error", error: `run could not start (HTTP ${res.status}): ${body.slice(0, 300)}` }, { fetchImpl });
    }
    runId = (await res.json())?.run?.id ?? null;
  } catch (err) {
    return finish(job, { state: "error", error: `run could not start: ${err?.message || err}` }, { fetchImpl });
  }
  if (!runId) return finish(job, { state: "error", error: "the run started without an id" }, { fetchImpl });
  // Drill's UI routes on query params (?view=results&run=<id>), not a hash — a
  // hash link would silently land on the Book view and look like the run vanished.
  await setState(job, { runId, runUrl: `${drillBaseUrl}/?view=results&run=${encodeURIComponent(runId)}` });

  const deadline = Date.now() + runTimeoutMs();
  let record = null;
  for (;;) {
    await sleep(POLL_MS);
    record = await getDrillRun(runId).catch(() => null);
    if (record?.endedAt) break;
    if (Date.now() > deadline) {
      return finish(job, { state: "error", error: `the run did not finish within ${Math.round(runTimeoutMs() / 3600000)}h` }, { fetchImpl });
    }
  }

  return finish(job, { state: verdictOf(record), outcome: outcomeFrom(record, job) }, { fetchImpl });
}

/**
 * passed | partial | failed | error. Pure.
 *
 * Two things this deliberately refuses to call a pass:
 *   - a CIRCUIT (the harness broke). Reporting a dead engine as "your change is
 *     broken" sends you debugging code that was never exercised, so it is
 *     `error` with the circuit reason.
 *   - an UNPROVEN check. The engine's own verdict for "I could not tell either
 *     way" — a narrower harness gap, but a gap. Folding it into `passed` makes
 *     the notification claim the change was verified when part of it was not,
 *     which is the exact failure `unproven` exists to prevent. (Caught on the
 *     first live run: 11 passed, 1 unproven, reported as "every check passed".)
 */
export function verdictOf(record) {
  if (!record) return "error";
  if (record.canceled) return "error";
  if (record.circuit) return "error";
  const failed = record.summary?.failed ?? 0;
  const findings = (record.findings ?? []).length;
  if (failed > 0 || findings > 0) return "failed";
  return (record.summary?.unproven ?? 0) > 0 ? "partial" : "passed";
}

/** The notification payload distilled from a finished run record. Pure. */
export function outcomeFrom(record, job = null) {
  const failed = record?.summary?.failed ?? 0;
  const unproven = record?.summary?.unproven ?? 0;
  const findings = (record?.findings ?? []).length;
  const state = verdictOf(record);
  let headline;
  if (state === "error") {
    headline = record?.canceled
      ? "The run was cancelled."
      : `The run could not complete: ${record?.circuit?.message ?? "unknown harness failure"}`;
  } else if (state === "failed") {
    const top = (record?.findings ?? []).slice(0, 3).map((f) => `- ${f.pageId}${f.stepId ? `#${f.stepId}` : ""}: ${f.text}`);
    headline = top.length ? top.join("\n") : `${failed} check${failed === 1 ? "" : "s"} failed.`;
  } else if (state === "partial") {
    // Name the gap rather than rounding it up to a pass: these checks were not
    // answered, so the change is not fully verified.
    const names = (record?.pages ?? [])
      .filter((p) => p.terminal?.kind === "unproven")
      .map((p) => `${p.pageId}${p.stepId ? `#${p.stepId}` : ""}`);
    const which = [...new Set(names)].slice(0, 3);
    headline = `Nothing failed, but ${unproven} check${unproven === 1 ? "" : "s"} could not be proven either way${which.length ? ` (${which.join(", ")})` : ""} - this change is not fully verified.`;
  } else {
    headline = job?.scope === "changed-pages"
      ? "Every check on the pages this card changed passed."
      : "Every check passed.";
  }
  return {
    state,
    headline,
    runId: record?.id ?? null,
    findings,
    failed,
    unproven,
    checks: record?.executedChecks ?? record?.plannedChecks ?? null,
    pages: new Set((record?.pages ?? []).map((p) => p.pageId)).size || (job?.pageIds?.length ?? null)
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
