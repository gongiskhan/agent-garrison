// Drill own-port server. Serves the Drill Book + page CRUD REST API + /health,
// registers its status file under ~/.garrison/ui-fittings/, and serves the
// authoring/results UI from dist/ (same shape as automations/browser-default).

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, createReadStream } from "node:fs";
import { access, mkdir, writeFile, unlink, readFile, stat, realpath } from "node:fs/promises";
import { getDrillBook, saveDrillBook, listPages, getPage, savePage, deletePage, drillTargetRoot } from "../lib/store.mjs";
import { listProjects, selectProject, findRunSkill, projectInfo, activeProjectRoot, readDevRoot, canonicalRoot, isValidProjectRoot } from "../lib/projects.mjs";
import { urlReachable, startApp, getJob, publicJob } from "../lib/app-runner.mjs";
import { startPlan, getPlanJob, publicPlanJob, reapOrphanPlanAgents, cancelPlan, planProgress, logTail } from "../lib/planner.mjs";
import {
  openTab, evalJs, observeTab, canvasUrl, fetchScreenshot, browserBaseUrl,
  navigateTab, tabAction, closeTab, tabInfo, readConsole
} from "../lib/browser-fitting-client.mjs";
import { buildPickScript, buildResolveScript, buildResolveManyScript, rectToPercent } from "../lib/picker.mjs";
import { resolveViewport, viewportList } from "../lib/viewports.mjs";
import {
  selectSteps, compileStepAutomation,
  hasAuth, resolveAuthUrl, authSuccess, compileAuthProbe, compileAuthLogin, AUTH_VERIFY_STEP
} from "../lib/compile.mjs";
import { readAuthState, writeAuthState, authFingerprint } from "../lib/auth-state.mjs";
import { graduationPlanFor, graduateStep } from "../lib/graduate.mjs";
import { saveSnapshot, listSnapshots, getSnapshot, drillHomeDir } from "../lib/snapshots.mjs";
import { assessAutomaticStateReference, promoteSnapshotToState } from "../lib/states.mjs";
import { runHeartbeatSweep } from "../lib/heartbeat.mjs";
import { runInline, getRun as getAutomationRun, getStepEvidence, ensureAutomationsUp } from "../lib/automations-client.mjs";
import {
  legacyInfrastructureFailure,
  terminalFromAutomationRun,
  terminalFromTransportError,
  terminalOpensCircuit
} from "../lib/run-outcome.mjs";
import {
  newDrillRun, saveDrillRun, getDrillRun, listDrillRuns, deleteDrillRun,
  addFeedback, setOverride, addObservation, addFinding, addInfraError, setFindingStatus, confirmedFindings,
  undispatchedConfirmedFindings, markFindingsDispatched, isInfraError, publicRunRecord
} from "../lib/runs-store.mjs";
import {
  captureStart, captureStop, captureChunkStart, captureChunkStop, captureScreenshot,
  writeStepsManifest, manifestRow, checkKey, writeEvidenceIndex, spotterRequest,
  evidenceRunDir, evidenceRootRef, resolveEvidencePath, atomicWrite, captureCall,
  classifyForRetention, pruneEvidence, removeRunEvidence
} from "../lib/evidence.mjs";
import { curateRunEvidence, curationConfig } from "../lib/curation.mjs";
import { toTailnetUrl } from "../lib/tailnet-serve.mjs";
import {
  readJsonlLines, parseTranscriptLines, linesInWindow, noteRunSession, sessionSliceName
} from "../lib/session-transcript.mjs";

// Authoring tabs (B1): one live tab per (project root, pageId, viewportId) for
// the duration of the server process - reused across pick/resolve/snapshot
// calls in an authoring session rather than reopened per request.
const authoringTabs = new Map(); // "<root>|<pageId>|<viewportId>" -> tabId

// Live Browser replay (Evidence V2, S6 - experimental): ONE held browser
// session at a time replays a run page's compiled steps up to a selected
// check, then stays open surfaced through the browser canvas iframe.
// Explicit DELETE releases it; the browser fitting's held-session hard TTL
// is the abandoned-session backstop. No DOM-snapshot fakery - state is
// reproduced by executing the same compiled steps the run executed, and
// auth continuity comes from the capture session's default-context
// storageState seed.
let liveReplay = null; // { sessionId, tabId, runId, pageId, stepId, viewportId, startedAt, replayed }

// ── Live run observability (S31) ────────────────────────────────────────────
// In-flight runs are held here so the UI can discover them (GET
// /api/runs/active), stream per-check progress (GET /api/runs/:id/events,
// SSE), and follow the verify sessions live. The disk record is ALSO saved
// incrementally after every check - this registry only adds the push channel
// and the current-check pointer; a poller reading the record sees the same
// state one save behind.
const activeRuns = new Map(); // runId -> { record, events, listeners, done, current, lastActivityAt }
const RUN_EVENT_CAP = 4000;
const FINISHED_RUN_LINGER_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
};

function registerActiveRun(record) {
  const entry = {
    record,
    events: [],
    listeners: new Set(),
    done: false,
    current: null,
    lastActivityAt: new Date().toISOString()
  };
  activeRuns.set(record.id, entry);
  return entry;
}

function publishRunEvent(runId, event) {
  const entry = activeRuns.get(runId);
  if (!entry) return;
  const ev = { at: new Date().toISOString(), ...event };
  entry.events.push(ev);
  if (entry.events.length > RUN_EVENT_CAP) entry.events.splice(0, entry.events.length - RUN_EVENT_CAP);
  entry.lastActivityAt = ev.at;
  const framed = `data: ${JSON.stringify(ev)}\n\n`;
  for (const listener of entry.listeners) {
    try {
      listener.write(framed);
    } catch {
      entry.listeners.delete(listener);
    }
  }
  if (ev.type === "run_finished") {
    entry.done = true;
    for (const listener of entry.listeners) {
      try { listener.end(); } catch { /* already closed */ }
    }
    entry.listeners.clear();
    // Late subscribers can replay the buffer briefly; after that the disk
    // record is the single (and complete) source.
    const timer = setTimeout(() => activeRuns.delete(runId), FINISHED_RUN_LINGER_MS);
    timer.unref?.();
  }
}

// Establish the app's authenticated session ONCE before a run's checks (A-auth).
// Runs in the SHARED browser context (no captureSession) so the login persists
// to the browser fitting's persistent profile and the run's capture session —
// created after this — seeds already-logged-in. A cheap probe reuses the cached
// session; the full login flow runs only on a miss or a Book-configured TTL
// refresh. Auth is infrastructure to reach the tested state, not a spec, so it
// never bypasses its own action/assertion cache even during a blind run.
// Returns { ok: true, via } or { ok: false, terminal, infra }.
async function ensureAuthenticated(book, { contextTag, viewport, root }) {
  const success = authSuccess(book);
  const fingerprint = authFingerprint(book.auth);
  const prior = await readAuthState(root);
  const ttlMin = Number(book.auth?.cacheMinutes);
  const ttlMs = Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin * 60000 : null;
  // A prior record only counts when it was written under THIS auth config — a
  // changed login (different user/flow) must never be satisfied by the old
  // session. loggedInAt is anchored to the last FULL login, so cacheMinutes
  // measures real session age, not time-since-last-probe.
  const priorFresh = prior && prior.fingerprint === fingerprint && prior.loggedInAt;
  const stale = ttlMs && priorFresh ? Date.now() - Date.parse(prior.loggedInAt) > ttlMs : false;
  // Force the full login flow when there is no fresh same-config record (first
  // run, or the login config changed) OR the cached session is past its TTL —
  // only then is the cheap probe trustworthy. This also skips the wasteful
  // probe on the very first run (nothing to reuse yet).
  const mustFlow = stale || !priorFresh;

  const runAuth = async (automation, expectStep) => {
    try {
      const response = await runInline({ automation, contextTag, bypassCache: false, viewport, sync: true });
      const run = response?.run;
      if (expectStep) return terminalFromAutomationRun(run, expectStep);
      // No success signal to verify: a completed run is our only pass evidence.
      return run?.status === "completed"
        ? { kind: "passed", source: "auth", code: "completed", component: "auth" }
        : terminalFromAutomationRun(run, automation.steps.at(-1)?.id);
    } catch (err) {
      return terminalFromTransportError(err);
    }
  };

  // Probe first: cheap reuse of the persistent session (navigate + a cached
  // assertion). A cache hit advances lastProbedAt only — never loggedInAt — so
  // the TTL clock keeps ticking against the last real login.
  if (success && !mustFlow) {
    const probe = await runAuth(compileAuthProbe(book), AUTH_VERIFY_STEP);
    if (probe.kind === "passed") {
      await writeAuthState(root, { ...prior, via: "cache", lastProbedAt: new Date().toISOString(), fingerprint }).catch(() => {});
      return { ok: true, via: "cache" };
    }
    // A transport/infra outage on the probe is NOT an auth failure — surface it
    // so the caller attributes the incident to the down component, not "auth".
    if (probe.kind === "infra-failure") return { ok: false, terminal: probe, authRejected: false };
    // product-failure / blocked / incomplete = inconclusive -> run the flow.
  }

  const flow = await runAuth(compileAuthLogin(book), success ? AUTH_VERIFY_STEP : null);
  if (flow.kind === "passed") {
    await writeAuthState(root, { loggedInAt: new Date().toISOString(), via: "flow", fingerprint }).catch(() => {});
    return { ok: true, via: "flow" };
  }
  // Only a product-level negative — the flow ran but the app did not grant a
  // session / the success signal was not met — is a genuine auth-config problem.
  // Infra / incomplete / blocked (engine down, app down, MFA pause) keep their
  // REAL component so the incident is never misattributed to the auth block.
  return { ok: false, terminal: flow, authRejected: flow.kind === "product-failure" };
}

// Mutating a run record while its background execute() still owns it would
// be silently clobbered by the next incremental save (and a DELETE would be
// resurrected by it). Review starts when the run finishes.
function activeRunMutation(runId) {
  const entry = activeRuns.get(runId);
  return entry && !entry.done ? { error: "run is still executing - review it when it finishes" } : null;
}

function activeRunSnapshot(entry) {
  const record = entry.record;
  return {
    id: record.id,
    startedAt: record.startedAt,
    project: record.project ?? null,
    contextTag: record.contextTag,
    plannedChecks: record.plannedChecks ?? null,
    executedChecks: record.executedChecks ?? 0,
    current: entry.current,
    lastActivityAt: entry.lastActivityAt,
    sessions: (record.sessions ?? []).map((session) => ({ id: session.id, checks: session.checks }))
  };
}

// The wire shape of the live session: always carries canvasUrl (recomputed —
// it is derived state, never stored) so a recovered session re-embeds after a
// page reload, not just within the mount that opened it. canvasTailnetUrl is
// the same embed rehosted at its HTTPS tailnet mapping - the URL a browser on
// ANOTHER device needs, since the loopback canvasUrl only works on this box.
async function liveReplayPublic() {
  if (!liveReplay) return null;
  let url = null;
  try {
    url = liveReplay.tabId ? canvasUrl(liveReplay.tabId, resolveViewport(liveReplay.viewportId)) : null;
  } catch { /* unknown viewport id — no embed URL */ }
  return { ...liveReplay, canvasUrl: url, canvasTailnetUrl: await toTailnetUrl(url) };
}

function send(res, code, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// A step whose fixer aborts (or otherwise runs out of budget before ever
// retrying) never gets its OWN entry in the automation run's `steps[]` - the
// engine just marks the whole run failed. Since each Drill step is compiled
// as its own [navigate, step] automation, a run-level failure with no
// matching step entry unambiguously means THIS step is the one that failed.
function resolveStepOutcome(automationRun, stepId) {
  if (!automationRun) return null;
  const found = (automationRun.steps ?? []).find((s) => s.stepId === stepId);
  if (found) return found;
  if (automationRun.status === "failed") {
    return { stepId, status: "failed", tier: null, error: automationRun.error ?? "run failed before this step completed" };
  }
  return null;
}

// Compatibility export for callers that used the old helper. Keep the
// classifier deliberately narrow: arbitrary prose containing "connection"
// or "vision" can describe a real product defect and must not be hidden from
// triage as infrastructure.
export function isInfrastructureFailure(text) {
  return legacyInfrastructureFailure(text) !== null;
}

function resultFromTerminal(terminal, stepId = null) {
  if (!terminal) return null;
  return {
    stepId,
    status: terminal.kind === "passed" ? "completed" : "failed",
    tier: terminal.tier ?? null,
    ...(terminal.evidencePath ? { evidencePath: terminal.evidencePath } : {}),
    ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
    ...(terminal.kind === "passed"
      ? { result: { passed: true, ...(terminal.reasoning ? { reasoning: terminal.reasoning } : {}) } }
      : { error: terminal.message ?? terminal.code, result: { passed: false, reasoning: terminal.message ?? terminal.code } })
  };
}

function enrichTerminalResult(terminal, stepId, hydrated) {
  const snapshot = resultFromTerminal(terminal, stepId);
  if (!snapshot) return hydrated;
  if (!hydrated) return snapshot;
  const enriched = {
    ...hydrated,
    ...snapshot,
    tier: terminal.tier ?? hydrated.tier ?? null,
    evidencePath: terminal.evidencePath ?? hydrated.evidencePath,
    durationMs: terminal.durationMs ?? hydrated.durationMs,
    result: {
      ...(hydrated.result ?? {}),
      ...(snapshot.result ?? {})
    }
  };
  if (terminal.kind === "passed") delete enriched.error;
  return enriched;
}

// S31 wire hygiene: hydrated automation step records carry the verify
// session's ABSOLUTE transcript path (result.vision / step-level vision).
// The drill wire keeps only the session id - transcripts leave solely
// through the confined /api/runs/:id/session-stream route.
function publicVisionMeta(vision) {
  if (!vision || typeof vision !== "object") return vision;
  const { transcriptPath, ...rest } = vision;
  return rest;
}

function stripTranscriptPaths(result) {
  if (!result || typeof result !== "object") return result;
  let next = result;
  if (next.vision?.transcriptPath) next = { ...next, vision: publicVisionMeta(next.vision) };
  if (next.result?.vision?.transcriptPath) {
    next = { ...next, result: { ...next.result, vision: publicVisionMeta(next.result.vision) } };
  }
  return next;
}

// Merge each (page, step, viewport) entry's own automation-run result (tier,
// evidence, pass/fail) onto the Drill run record for display. Hydration is
// optional enrichment only: the terminal snapshot captured from runInline's
// response is authoritative and remains usable if Automations is down or its
// persistence has not become readable yet.
async function assembleRunView(record, { hydrate = true } = {}) {
  const pages = [];
  for (const pr of record.pages) {
    let result = resultFromTerminal(pr.terminal, pr.stepId);
    if (hydrate && pr.automationRunId) {
      const automationRun = await getAutomationRun(pr.automationRunId).catch(() => null);
      const hydrated = resolveStepOutcome(automationRun, pr.stepId);
      if (hydrated) result = enrichTerminalResult(pr.terminal, pr.stepId, hydrated);
    }
    // Harness failures render apart from real step verdicts - computed here
    // (not stored) so runs recorded before the classifier existed group
    // correctly too.
    pages.push({ ...pr, result: stripTranscriptPaths(result), infra: isInfraError(pr.error || result?.error) });
  }
  return publicRunRecord({ ...record, pages });
}

async function kanbanBaseUrl() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const status = JSON.parse(await readFile(path.join(home, "ui-fittings", "kanban-loop.json"), "utf8"));
    return status.url || null;
  } catch {
    return null;
  }
}

// This server's own base URL — evidence links handed to other surfaces
// (cards) must go through the confined evidence routes, and dispatch can run
// from the heartbeat where no request context exists.
function selfBaseUrl() {
  const host = process.env.GARRISON_DRILL_BIND_HOST || process.env.DRILL_UI_HOST || "127.0.0.1";
  const port = Number(process.env.GARRISON_DRILL_PORT || process.env.DRILL_UI_PORT || DEFAULT_PORT);
  return `http://${host}:${port}`;
}

// One batch card carrying the findings report (R10) - a normal `code` duty
// fix card (findings need real code changes + the usual review/test gates),
// distinct from the R14 testing-only card schema (Phase 7), which instead
// enters the roster directly at drill.
async function dispatchBatchFixCard(record, confirmed) {
  const base = await kanbanBaseUrl();
  if (!base) throw new Error("kanban-loop fitting not running (no status file)");
  // Evidence travels as links through Drill's confined evidence routes
  // (Drill Evidence v0.1) — a finding's screenshot plus a time-offset deep
  // link into the run video. Findings without captured evidence keep the
  // plain line.
  const evidenceUrl = (name) =>
    `${selfBaseUrl()}/api/runs/${encodeURIComponent(record.id)}/evidence-file/${encodeURIComponent(name)}`;
  const lines = confirmed.map((f) => {
    const parts = [
      `- [${f.kind}] ${f.pageId}${f.stepId ? "#" + f.stepId : ""}${f.viewportId ? ` [${f.viewportId}]` : ""}: ${f.text}`
    ];
    if (f.evidence?.screenshot) parts.push(`  evidence: ${evidenceUrl(f.evidence.screenshot)}`);
    if (record.evidence?.video && Number.isFinite(f.evidence?.videoMs)) {
      const s = Math.max(0, Math.floor(f.evidence.videoMs / 1000));
      parts.push(`  video @${s}s: ${evidenceUrl(record.evidence.video)}#t=${s}`);
    }
    return parts.join("\n");
  });
  const description = `Drill batch fix (report ${record.id}):\n${lines.join("\n")}`;
  // A human-scannable title: which pages, how many findings, dispatched when.
  // Identical "Drill batch fix (report 01KX...)" titles made the board
  // unreadable - the ulid identifies nothing at a glance.
  const pages = [...new Set(confirmed.map((f) => f.pageId))];
  const when = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const title = `Drill fix: ${pages.join(", ")} - ${confirmed.length} finding${confirmed.length === 1 ? "" : "s"} (${when})`;
  const sequence = ["code"];
  const res = await fetch(`${base}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The run RECORD's project, not the live selection - a heartbeat sweep or
    // a stale Results view can dispatch after the user retargeted Drill, and
    // the fix card must point at the repo the findings came from.
    body: JSON.stringify({
      title, description, duty: "code", level: 2, sequence, origin: "drill",
      project: record.project || drillTargetRoot(),
      ...(record.evidence?.video ? { videoUrl: evidenceUrl(record.evidence.video) } : {})
    })
  });
  if (!res.ok) throw new Error(`kanban-loop ${res.status}: ${await res.text()}`);
  const created = await res.json();
  const card = created.card ?? created;
  if (!card?.id) throw new Error("kanban-loop created a card without an id");
  const cardUrl = `${base}/#/cards/${card.id}`;

  // POST /cards intentionally creates in Backlog. Drill is a reviewed,
  // autonomous dispatch door, so position the card on the first resolved duty
  // list and explicitly hand progression to Kanban. Retry CAS conflicts after
  // re-reading the card. If the move still cannot complete, dispatch remains
  // successful with the card visibly in Backlog and the board's Start action
  // as the fallback.
  const targetList =
    Array.isArray(card.sequence) && card.sequence.length > 0
      ? card.sequence[0]
      : sequence[0];
  let latest = card;
  let entered = card.list === targetList;
  let rev = Number.isInteger(card.rev) ? card.rev : 0;
  for (let attempt = 0; attempt < 3 && !entered; attempt += 1) {
    try {
      const moved = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-garrison-engine": "drill-dispatch",
          "x-garrison-dispatch": "auto"
        },
        body: JSON.stringify({ list: targetList, rev })
      });
      if (moved.ok) {
        const body = await moved.json();
        latest = body.card ?? body;
        entered = true;
        break;
      }
      const fresh = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`);
      if (fresh.ok) {
        const body = await fresh.json();
        latest = body.card ?? body;
        if (latest.list === targetList) {
          entered = true;
          break;
        }
        if (Number.isInteger(latest.rev)) rev = latest.rev;
      }
    } catch { /* retry with the last known revision */ }
  }
  // Attach the board's card URL so the UI (and the finding's `card` stamp)
  // can link straight to it - "did my fixes reach the kanban?" should never
  // require opening the board and hunting.
  return { ...latest, url: cardUrl, entered };
}

// A long-lived client flow (an app start, a plan, a gated-run approval) pins
// the root it started against and passes it back explicitly - the live
// selection can change under a minutes-long wait, and the poll/resume must
// keep following the operation it began, never the newly selected repo.
function pinnedRoot(explicit) {
  return explicit ? canonicalRoot(String(explicit)) : drillTargetRoot();
}

// Every MUTATING route (writes drills/ files, or opens a live authoring
// session against a project) resolves its target through this - never a bare
// drillTargetRoot() call. Dogfood bug this exists to close: a second UI tab
// switched the live selection (active-project.json) while a first tab's
// authoring session was still open; the first tab's next PUT /api/pages had
// no root of its own to fall back on, silently re-resolved through the NOW-
// mutated global, and landed in the wrong repo. Two guards:
//   - an EXPLICIT root pins the write to that identity outright, bypassing
//     the live global entirely - but only if it still names a real project
//     directory (a stale/removed pin is rejected, never silently widened to
//     cwd or the fitting's own install dir).
//   - with NO explicit root, the route still requires SOME selection to
//     exist (matches every existing single-project/env-pin deployment and
//     test) - it just never falls through to cwd when nothing is selected.
// Returns { root } on success or { error } (caller sends 400).
function resolveMutationRoot(explicit) {
  if (explicit) {
    const root = canonicalRoot(String(explicit));
    if (!isValidProjectRoot(root)) {
      return { error: `stale project selection - ${root} is no longer a project directory; reselect a project` };
    }
    return { root };
  }
  if (!activeProjectRoot() && !process.env.GARRISON_DRILL_TARGET_REPO) {
    return { error: "no project selected - choose one in the Project picker first" };
  }
  return { root: drillTargetRoot() };
}

const FITTING_ID = "drill";
const DEFAULT_PORT = 27096;
const GARRISON_DIR = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
const STATUS_ROOT = path.join(GARRISON_DIR, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  // Same-origin CSRF guard as automations/browser-default: this service writes
  // to the target app repo, so only the same-origin viewer may call it.
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin) return send(res, 403, { error: "cross-origin forbidden" });
  }
  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    if (pathname === "/health" || pathname === "/api/health") {
      return send(res, 200, { status: "ok", fittingId: FITTING_ID, pid: process.pid, targetRepo: drillTargetRoot() });
    }
    if (pathname === "/api/drillbook" && req.method === "GET") {
      const root = pinnedRoot(url.searchParams.get("root"));
      return send(res, 200, { book: await getDrillBook(root), root });
    }
    if (pathname === "/api/drillbook" && req.method === "PATCH") {
      const { root: explicitRoot, ...patch } = await readJsonBody(req);
      const resolved = resolveMutationRoot(explicitRoot);
      if (resolved.error) return send(res, 400, { error: resolved.error });
      return send(res, 200, { book: await saveDrillBook(patch, resolved.root), root: resolved.root });
    }
    // Project selection: pick any repo under the dev-root (same discovery
    // contract as the dev-env/Kanban pickers) and Drill retargets live - the
    // Book, pages, and runs all follow drillTargetRoot(). The active target
    // is always included even when it lives outside the dev-root (an env
    // pin or an absolute selection).
    if (pathname === "/api/projects" && req.method === "GET") {
      // "Selected" means an EXPLICIT target: a picker selection or the env
      // pin. The bare cwd fallback (under the composition that is the
      // fitting's own install dir) is NOT a selection - the UI treats it as
      // "pick a project first" instead of quietly QA-ing the drill fitting.
      const selected = !!(activeProjectRoot() || process.env.GARRISON_DRILL_TARGET_REPO);
      const active = drillTargetRoot();
      const projects = listProjects();
      if (selected && !projects.some((p) => p.path === active)) {
        projects.unshift(projectInfo(active));
      }
      return send(res, 200, {
        projects: projects.map((p) => ({ ...p, active: selected && p.path === active })),
        active: selected ? { root: active, name: path.basename(active) } : null,
        selected,
        devRoot: readDevRoot()
      });
    }
    if (pathname === "/api/projects/select" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.path) return send(res, 400, { error: "path required" });
      let selected;
      try {
        selected = await selectProject(body.path);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      // Authoring tabs are keyed by (pageId, viewport) of the PREVIOUS
      // project's pages - stale across a retarget.
      authoringTabs.clear();
      return send(res, 200, { project: { ...selected, active: true } });
    }

    // App-under-test status + start (the "run the tests" doorway): when the
    // Book's app URL is down, POST /api/app/start boots it through the
    // project's run-<project> skill in a headless agent session; callers poll
    // GET /api/app/status until reachable (or the job fails with a reason).
    if (pathname === "/api/app/status" && req.method === "GET") {
      // NOTE: this block declares its own `url` (the app URL) below - the
      // request URL's query must be read via a separate binding, or the
      // block-scoped shadow's TDZ turns the read into a ReferenceError.
      const rootParam = url.searchParams.get("root");
      const root = pinnedRoot(rootParam);
      const book = await getDrillBook(root);
      const appUrl = book.app.url || null;
      return send(res, 200, {
        root,
        url: appUrl,
        configured: !!appUrl,
        reachable: await urlReachable(appUrl),
        runSkill: findRunSkill(root),
        selected: !!(activeProjectRoot() || process.env.GARRISON_DRILL_TARGET_REPO),
        job: publicJob(getJob(root))
      });
    }
    if (pathname === "/api/app/start" && req.method === "POST") {
      if (!activeProjectRoot() && !process.env.GARRISON_DRILL_TARGET_REPO) {
        return send(res, 400, { error: "no project selected - choose one in the Project picker first" });
      }
      const startBody = await readJsonBody(req);
      const root = pinnedRoot(startBody.root);
      const book = await getDrillBook(root);
      const url = book.app.url || null;
      if (await urlReachable(url)) {
        return send(res, 200, { started: false, reachable: true, url, job: publicJob(getJob(root)) });
      }
      const job = await startApp({
        root,
        bookUrl: url,
        // No configured URL: adopt the agent's APP_URL sentinel into the Book
        // so authoring tabs and runs have a base URL from here on. Pinned to
        // the kick-time root - this fires minutes later from the poll loop,
        // and a mid-start project switch must not write the URL into the
        // OTHER project's book.
        onUrl: async (reported) => {
          const current = await getDrillBook(root);
          if (!current.app.url) await saveDrillBook({ app: { ...current.app, url: reported } }, root);
        }
      });
      if (job.status === "failed") {
        return send(res, 502, { error: job.error, started: false, reachable: false, job: publicJob(job) });
      }
      return send(res, 200, { started: true, reachable: false, job: publicJob(job) });
    }

    // Agent-driven planning (the duty's stage 1, card-free): a headless agent
    // session in the project root authors/updates the Book on its own
    // judgment. POST kicks it (optional {brief} scopes an update to a
    // change); callers poll GET /api/plan/status until done or failed. The
    // Authoring UI is the manual override surface, never the required entry.
    if (pathname === "/api/plan/status" && req.method === "GET") {
      const root = pinnedRoot(url.searchParams.get("root"));
      const job = getPlanJob(root);
      // Durable, on-disk evidence of whether a running plan is alive or
      // hung (the transcript, drills/ tree, page count) - a healthy 11min
      // plan and a genuine hang were otherwise indistinguishable behind the
      // same generic "Planning..." message. Computed on demand, cheaply,
      // and only when a job actually exists.
      const publicJobWithProgress = job ? { ...publicPlanJob(job), progress: await planProgress(job) } : null;
      return send(res, 200, {
        root,
        pages: (await listPages(root)).length,
        selected: !!(activeProjectRoot() || process.env.GARRISON_DRILL_TARGET_REPO),
        job: publicJobWithProgress
      });
    }
    if (pathname === "/api/plan/start" && req.method === "POST") {
      if (!activeProjectRoot() && !process.env.GARRISON_DRILL_TARGET_REPO) {
        return send(res, 400, { error: "no project selected - choose one in the Project picker first" });
      }
      const body = await readJsonBody(req);
      const root = pinnedRoot(body.root);
      const brief = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : null;
      // Joining an in-flight plan is fine (started:false says so), but a
      // brief must never be silently swallowed by a join - the caller asked
      // for a DIFFERENT plan than the one running.
      const existing = getPlanJob(root);
      if (existing && existing.status === "planning") {
        if (brief) return send(res, 409, { error: "a plan is already running for this project - wait for it to finish before planning an update", job: publicPlanJob(existing) });
        return send(res, 200, { started: false, job: publicPlanJob(existing) });
      }
      const job = await startPlan({ root, brief });
      if (job.status === "failed") {
        return send(res, 502, { error: job.error, job: publicPlanJob(job) });
      }
      return send(res, 200, { started: true, job: publicPlanJob(job) });
    }
    // Cancel a running plan (the safe stop the dogfood bug found missing): a
    // distinct "canceled" terminal status, never "failed" - a user-requested
    // stop is not an error. Unblocks both a retry (/api/plan/start) and a run
    // (/api/runs) immediately, since both guards key off status==="planning".
    if (pathname === "/api/plan/cancel" && req.method === "POST") {
      if (!activeProjectRoot() && !process.env.GARRISON_DRILL_TARGET_REPO) {
        return send(res, 400, { error: "no project selected - choose one in the Project picker first" });
      }
      const body = await readJsonBody(req);
      const root = pinnedRoot(body.root);
      const { canceled, job } = await cancelPlan(root);
      if (!canceled) {
        return send(res, 409, { canceled: false, error: "no plan is running for this project", job });
      }
      return send(res, 200, { canceled: true, job });
    }
    // Serves the log the UI's own error strings already point at ("see the
    // plan log") - previously a dead end since nothing exposed the file.
    if (pathname === "/api/plan/log" && req.method === "GET") {
      const root = pinnedRoot(url.searchParams.get("root"));
      const job = getPlanJob(root);
      if (!job) return send(res, 404, { error: "no plan job for this project" });
      return send(res, 200, await logTail(job.logFile, 16000), { "content-type": "text/plain; charset=utf-8" });
    }

    if (pathname === "/api/pages" && req.method === "GET") {
      const root = pinnedRoot(url.searchParams.get("root"));
      return send(res, 200, { pages: await listPages(root), root });
    }
    const pageMatch = pathname.match(/^\/api\/pages\/([^/]+)$/);
    if (pageMatch) {
      const id = decodeURIComponent(pageMatch[1]);
      if (req.method === "GET") {
        const root = pinnedRoot(url.searchParams.get("root"));
        const page = await getPage(id, root);
        return page ? send(res, 200, { page, root }) : send(res, 404, { error: "not found" });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const { root: explicitRoot, ...patch } = await readJsonBody(req);
        const resolved = resolveMutationRoot(explicitRoot);
        if (resolved.error) return send(res, 400, { error: resolved.error });
        return send(res, 200, { page: await savePage(id, patch, resolved.root), root: resolved.root });
      }
      if (req.method === "DELETE") {
        const resolved = resolveMutationRoot(url.searchParams.get("root"));
        if (resolved.error) return send(res, 400, { error: resolved.error });
        return send(res, 200, { deleted: await deletePage(id, resolved.root) });
      }
    }

    // Authoring: open/reuse a tab for a page at a given viewport (B1/S19).
    if (pathname === "/api/authoring/tab" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pageId = String(body.pageId ?? "");
      const viewportId = String(body.viewport ?? "desktop");
      if (!pageId) return send(res, 400, { error: "pageId required" });
      const resolved = resolveMutationRoot(body.root);
      if (resolved.error) return send(res, 400, { error: resolved.error });
      const { root } = resolved;
      let viewport;
      try { viewport = resolveViewport(viewportId); } catch (err) { return send(res, 400, { error: err.message }); }
      const book = await getDrillBook(root);
      const page = await getPage(pageId, root);
      const appUrl = book.app.url || "http://localhost:3000";
      let target;
      try {
        // data: fixture URLs (self-test) have no real path hierarchy to
        // resolve against - an empty page path (or a data:/about: base) just
        // means "the app URL itself".
        target = page?.path ? new URL(page.path, appUrl).toString() : appUrl;
      } catch {
        target = appUrl;
      }
      // Keyed by root too - two projects with same-named pages (e.g. both
      // have a "home" page) must never reuse each other's live authoring tab.
      const key = `${root}|${pageId}|${viewportId}`;
      let tabId = authoringTabs.get(key);
      if (!tabId) {
        try {
          tabId = await openTab(target, { viewport });
        } catch (err) {
          return send(res, 502, { error: err.message });
        }
        authoringTabs.set(key, tabId);
      }
      const canvas = canvasUrl(tabId, viewport);
      return send(res, 200, {
        tabId,
        canvasUrl: canvas,
        canvasTailnetUrl: await toTailnetUrl(canvas),
        screenshotUrl: `/api/authoring/screenshot/${encodeURIComponent(tabId)}`,
        viewport,
        url: target,
        root
      });
    }
    // Proxy the exact Browser viewport image through Drill. Besides keeping
    // authoring self-contained, this makes image loading same-origin so the
    // picker can reliably wait for the frozen frame before accepting clicks.
    const authoringShotMatch = pathname.match(/^\/api\/authoring\/screenshot\/([^/]+)$/);
    if (authoringShotMatch && req.method === "GET") {
      const tabId = decodeURIComponent(authoringShotMatch[1]);
      if (![...authoringTabs.values()].includes(tabId)) return send(res, 404, { error: "authoring tab not found" });
      try {
        const png = await fetchScreenshot(tabId);
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", String(png.length));
        res.setHeader("Cache-Control", "no-store");
        return res.end(png);
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // Authoring: pick the element at (x, y) in viewport CSS px (D4/B2/B3).
    if (pathname === "/api/authoring/pick" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.tabId) return send(res, 400, { error: "tabId required" });
      try {
        const anchors = await evalJs(body.tabId, buildPickScript(body.x, body.y));
        const pct = anchors ? rectToPercent(anchors.rect, anchors.viewport) : null;
        return send(res, 200, { anchors: anchors ? { ...anchors, pct } : null });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // Freeze motion while the user targets the viewport-exact screenshot.
    // Without this, an animation can move the live DOM between screenshot
    // capture and hit-test even though the preview itself looks frozen.
    if (pathname === "/api/authoring/freeze" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.tabId) return send(res, 400, { error: "tabId required" });
      try {
        const frozen = body.frozen !== false;
        const result = await evalJs(body.tabId, `(() => {
          const id = "__garrison_drill_freeze__";
          document.getElementById(id)?.remove();
          if (${JSON.stringify(frozen)}) {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = "*,*::before,*::after{animation-play-state:paused!important;transition:none!important;scroll-behavior:auto!important}";
            document.documentElement.appendChild(style);
          }
          return { width: window.innerWidth, height: window.innerHeight };
        })()`);
        return send(res, 200, { frozen, viewport: result });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // Authoring: resolve a stored anchor set to the live element's CURRENT
    // rect, for badge redraw across reload/viewport changes (B3/B4).
    if (pathname === "/api/authoring/resolve" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.tabId) return send(res, 400, { error: "tabId required" });
      try {
        const resolved = await evalJs(body.tabId, buildResolveScript(body.anchors));
        const pct = resolved ? rectToPercent(resolved.rect, resolved.viewport) : null;
        return send(res, 200, { resolved: resolved ? { ...resolved, pct } : null });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // Authoring manual-testing controls (the browser toolbar): navigate,
    // back/forward/reload, restart the pooled tab fresh, and read the live
    // URL/title + console buffer - thin proxies over browser-default's tab
    // endpoints so a manual test session can be driven from the authoring
    // surface itself.
    if (pathname === "/api/authoring/nav" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.tabId || !body.url) return send(res, 400, { error: "tabId and url required" });
      try {
        return send(res, 200, await navigateTab(body.tabId, String(body.url)));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    if (pathname === "/api/authoring/tab-action" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.tabId) return send(res, 400, { error: "tabId required" });
      try {
        return send(res, 200, await tabAction(body.tabId, String(body.action ?? "")));
      } catch (err) {
        return send(res, err.message.startsWith("invalid tab action") ? 400 : 502, { error: err.message });
      }
    }
    if (pathname === "/api/authoring/restart" && req.method === "POST") {
      // Close the pooled tab and open a fresh one at the page's URL - the
      // reset for a manual session that wandered off (auth state, SPA state).
      const body = await readJsonBody(req);
      const pageId = String(body.pageId ?? "");
      const viewportId = String(body.viewport ?? "desktop");
      if (!pageId) return send(res, 400, { error: "pageId required" });
      const resolved = resolveMutationRoot(body.root);
      if (resolved.error) return send(res, 400, { error: resolved.error });
      const { root } = resolved;
      let viewport;
      try { viewport = resolveViewport(viewportId); } catch (err) { return send(res, 400, { error: err.message }); }
      const book = await getDrillBook(root);
      const page = await getPage(pageId, root);
      const appUrl = book.app.url || "http://localhost:3000";
      let target;
      try { target = page?.path ? new URL(page.path, appUrl).toString() : appUrl; } catch { target = appUrl; }
      const key = `${root}|${pageId}|${viewportId}`;
      const old = authoringTabs.get(key);
      if (old) {
        await closeTab(old).catch(() => {});
        authoringTabs.delete(key);
      }
      let tabId;
      try {
        tabId = await openTab(target, { viewport });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
      authoringTabs.set(key, tabId);
      const canvas = canvasUrl(tabId, viewport);
      return send(res, 200, {
        tabId,
        canvasUrl: canvas,
        canvasTailnetUrl: await toTailnetUrl(canvas),
        screenshotUrl: `/api/authoring/screenshot/${encodeURIComponent(tabId)}`,
        viewport,
        url: target,
        root
      });
    }
    if (pathname === "/api/authoring/tab-info" && req.method === "GET") {
      const tabId = url.searchParams.get("tabId");
      if (!tabId) return send(res, 400, { error: "tabId required" });
      try {
        return send(res, 200, { tab: await tabInfo(tabId) });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    // Resolve all visible area anchors in one Browser eval. The UI polls this
    // lightly to keep badges current as responsive layouts move, without
    // multiplying Browser traffic by the number of authored areas.
    if (pathname === "/api/authoring/resolve-many" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.tabId) return send(res, 400, { error: "tabId required" });
      if (!Array.isArray(body.items)) return send(res, 400, { error: "items required" });
      if (body.items.length > 200) return send(res, 400, { error: "too many areas" });
      try {
        const evaluated = await evalJs(body.tabId, buildResolveManyScript(body.items));
        const resolved = Object.fromEntries((Array.isArray(evaluated) ? evaluated : []).map((item) => [
          String(item.id),
          item.resolved ? rectToPercent(item.resolved.rect, item.resolved.viewport) : null
        ]));
        return send(res, 200, { resolved });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    if (pathname === "/api/authoring/console" && req.method === "GET") {
      const tabId = url.searchParams.get("tabId");
      if (!tabId) return send(res, 400, { error: "tabId required" });
      try {
        const limit = Number(url.searchParams.get("limit")) || 120;
        return send(res, 200, await readConsole(tabId, { limit }));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    // States (C3/C4): capture a snapshot from the authoring tab (reuses the
    // Phase 3 tab-per-page-viewport pool), list snapshots, promote one to a
    // named state, and serve a state's reference screenshot.
    const snapMatch = pathname.match(/^\/api\/states\/([^/]+)\/snapshot$/);
    if (snapMatch && req.method === "POST") {
      const pageId = decodeURIComponent(snapMatch[1]);
      const body = await readJsonBody(req);
      const viewportId = body.viewport || "desktop";
      const resolved = resolveMutationRoot(body.root);
      if (resolved.error) return send(res, 400, { error: resolved.error });
      const { root } = resolved;
      const key = `${root}|${pageId}|${viewportId}`;
      let tabId = authoringTabs.get(key);
      if (!tabId) {
        const book = await getDrillBook(root);
        const page = await getPage(pageId, root);
        const appUrl = book.app.url || "http://localhost:3000";
        let tabUrl;
        try { tabUrl = page?.path ? new URL(page.path, appUrl).toString() : appUrl; } catch { tabUrl = appUrl; }
        let viewport;
        try { viewport = resolveViewport(viewportId); } catch (err) { return send(res, 400, { error: err.message }); }
        try {
          tabId = await openTab(tabUrl, { viewport });
        } catch (err) {
          return send(res, 502, { error: err.message });
        }
        authoringTabs.set(key, tabId);
      }
      try {
        const obs = await observeTab(tabId, { screenshot: true });
        const saved = await saveSnapshot(pageId, {
          url: obs.url, title: obs.title, headingText: obs.headingText, shapeSketch: obs.shapeSketch,
          viewport: obs.viewport, screenshotB64: obs.screenshotB64
        });
        return send(res, 200, { snapshot: saved });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    const snapListMatch = pathname.match(/^\/api\/states\/([^/]+)\/snapshots$/);
    if (snapListMatch && req.method === "GET") {
      return send(res, 200, { snapshots: await listSnapshots(decodeURIComponent(snapListMatch[1])) });
    }
    const snapshotShotMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)\/image$/);
    if (snapshotShotMatch && req.method === "GET") {
      const pageId = decodeURIComponent(snapshotShotMatch[1]);
      const snapshotId = decodeURIComponent(snapshotShotMatch[2]);
      const snapshot = await getSnapshot(pageId, snapshotId);
      if (!snapshot?.screenshotPath) return send(res, 404, { error: "no screenshot for this snapshot" });
      try {
        const bytes = await readFile(snapshot.screenshotPath);
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
        return res.end(bytes);
      } catch {
        return send(res, 404, { error: "snapshot screenshot file missing" });
      }
    }
    const promoteMatch = pathname.match(/^\/api\/states\/([^/]+)\/promote$/);
    if (promoteMatch && req.method === "POST") {
      const pageId = decodeURIComponent(promoteMatch[1]);
      const body = await readJsonBody(req);
      if (!body.snapshotId) return send(res, 400, { error: "snapshotId required" });
      try {
        const state = await promoteSnapshotToState(pageId, body.snapshotId, { label: body.label, reachPath: body.reachPath ?? [] });
        return send(res, 200, { state });
      } catch (err) {
        return send(res, 404, { error: err.message });
      }
    }
    // A snapshot's own screenshot (the States gallery) - distinct from a
    // promoted STATE's reference screenshot below.
    const snapShotFileMatch = pathname.match(/^\/api\/states\/([^/]+)\/snapshots\/([^/]+)\/screenshot$/);
    if (snapShotFileMatch && req.method === "GET") {
      const snap = await getSnapshot(decodeURIComponent(snapShotFileMatch[1]), decodeURIComponent(snapShotFileMatch[2]));
      if (!snap?.screenshotPath) return send(res, 404, { error: "no screenshot for this snapshot" });
      try {
        const bytes = await readFile(snap.screenshotPath);
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(bytes);
      } catch {
        return send(res, 404, { error: "screenshot file missing" });
      }
    }
    // Let the UI distinguish a state that has never acquired a reference
    // from one whose machine-local evidence file has gone missing.
    const stateShotStatusMatch = pathname.match(/^\/api\/states\/([^/]+)\/([^/]+)\/screenshot-status$/);
    if (stateShotStatusMatch && req.method === "GET") {
      const pageId = decodeURIComponent(stateShotStatusMatch[1]);
      const stateId = decodeURIComponent(stateShotStatusMatch[2]);
      const page = await getPage(pageId);
      const state = page?.states?.find((candidate) => candidate.id === stateId);
      if (!state?.screenshotPath) return send(res, 200, { available: false, reason: "not-recorded" });
      try {
        // Root-relative (Drill Evidence v0.1) or legacy absolute — both resolve.
        await access(resolveEvidencePath(state.screenshotPath));
        return send(res, 200, { available: true });
      } catch {
        return send(res, 200, { available: false, reason: "file-missing" });
      }
    }
    const stateShotMatch = pathname.match(/^\/api\/states\/([^/]+)\/([^/]+)\/screenshot$/);
    if (stateShotMatch && req.method === "GET") {
      const pageId = decodeURIComponent(stateShotMatch[1]);
      const stateId = decodeURIComponent(stateShotMatch[2]);
      const page = await getPage(pageId);
      const state = page?.states?.find((s) => s.id === stateId);
      if (!state?.screenshotPath) return send(res, 404, { error: "no screenshot for this state" });
      try {
        const bytes = await readFile(resolveEvidencePath(state.screenshotPath));
        const type = state.screenshotPath.endsWith(".png") ? "image/png" : "image/jpeg";
        res.writeHead(200, { "content-type": type });
        return res.end(bytes);
      } catch {
        return send(res, 404, { error: "screenshot file missing" });
      }
    }

    if (pathname === "/api/authoring/browser-status" && req.method === "GET") {
      const base = browserBaseUrl();
      return send(res, 200, { running: !!base, url: base });
    }
    if (pathname === "/api/viewports" && req.method === "GET") {
      return send(res, 200, { viewports: viewportList() });
    }

    // Start a run (B6/R3/S19): compile EACH enabled step to its OWN inline
    // ephemeral automation (navigate + that step, stable id `drill-<page>-
    // <step>` so its cache persists run to run) and run it, once per selected
    // viewport (a matrix when more than one, delta 6). One automation run per
    // Drill step, deliberately - see compile.mjs's compileStepAutomation doc
    // - so one step's failure never hides the verdict of its siblings on the
    // same page. Failed steps auto-pool as proposed findings (D10).
    if (pathname === "/api/runs" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pageIds = Array.isArray(body.pageIds) ? body.pageIds : [];
      const viewportIds = Array.isArray(body.viewports) && body.viewports.length ? body.viewports : ["desktop"];
      const state = body.state || "default";
      // Blind adversarial pass (R12/F8): a second run, forced vision-only
      // (bypassCache also skips any cachedAssertion - see compile.mjs's
      // blind mode), tagged so a composition's routing config can route its
      // vision calls to a different model (see the vision route's
      // contextKind threading). No drill-specific naming leaks into the
      // automations engine itself - `blind` and `contextTag` are generic.
      const blind = body.blind === true;
      const contextTag = blind ? "drill-adversarial" : (body.contextTag || "drill");
      const bypassCache = blind || body.bypassCache === true;
      if (pageIds.length === 0) return send(res, 400, { error: "pageIds required" });

      // Resolved ONCE for the whole run: this handler lives for minutes
      // (sync inline automations per step), and a project switch mid-run
      // must not swing later page reads or graduation spec writes into the
      // newly selected repo. A gated-run approval passes the root it was
      // HELD against (body.project) - the approval must execute the plan the
      // user saw, not whatever repo is selected at approval time.
      const rootResolved = resolveMutationRoot(body.project);
      if (rootResolved.error) return send(res, 400, { error: rootResolved.error });
      const root = rootResolved.root;
      // A plan agent may be rewriting this repo's drills/ tree right now -
      // compiling half-written YAML produces a run over a phantom book.
      const planJob = getPlanJob(root);
      if (planJob && planJob.status === "planning") {
        return send(res, 409, { error: "a plan is authoring this project's Drill Book right now - wait for it to finish, then run" });
      }
      // S31: one run per project at a time. Two concurrent runs would drive
      // the same app under test and the same Browser-fitting capture
      // sessions into each other; with background runs this is one
      // double-click away, so the server owns the guard.
      const activeForRoot = [...activeRuns.values()].find(
        (entry) => !entry.done && (entry.record.project ?? null) === root
      );
      if (activeForRoot) {
        return send(res, 409, {
          error: `a run is already executing for this project - wait for it to finish (run ${activeForRoot.record.id})`,
          runId: activeForRoot.record.id
        });
      }
      const book = await getDrillBook(root);

      // Configurable autonomy gate (A5/R7/S22): "gated" pauses with a plan
      // preview before running; the caller re-POSTs the returned `resume`
      // object (with confirmed:true) to actually execute. "auto" proceeds
      // straight through. The blind adversarial pass is never itself
      // gated - a decorrelated check re-litigating the SAME approval would
      // defeat its purpose. The gate lives here, in the duty layer (A5),
      // not in a subagent or the Kanban engine.
      if (!blind && book.autonomy === "gated" && body.confirmed !== true) {
        const plan = [];
        for (const pageId of pageIds) {
          const page = await getPage(pageId, root);
          if (!page) continue;
          for (const viewportId of viewportIds) {
            const steps = selectSteps(page, { state, viewport: viewportId });
            plan.push({ pageId, viewportId, steps: steps.map((s) => ({ id: s.id, description: s.description, mode: s.mode })) });
          }
        }
        return send(res, 200, {
          held: true,
          reason: "gated",
          plan,
          resume: { pageIds, viewports: viewportIds, state, contextTag: body.contextTag, bypassCache: body.bypassCache === true, confirmed: true, project: root }
        });
      }

      // Materialize the whole check plan before touching Automations. This
      // lets a circuit report exactly how much work it skipped and turns one
      // systemic outage into one grouped incident instead of N near-identical
      // product findings.
      const jobs = [];
      for (const pageId of pageIds) {
        const page = await getPage(pageId, root);
        if (!page) continue;
        for (const viewportId of viewportIds) {
          const steps = selectSteps(page, { state, viewport: viewportId });
          for (const step of steps) {
            jobs.push({
              pageId,
              viewportId,
              page,
              step,
              viewport: resolveViewport(viewportId),
              automation: compileStepAutomation(book, page, step, { blind })
            });
          }
        }
      }
      const record = newDrillRun({ contextTag, state, dispatch: blind ? "manual" : (body.dispatch || book.dispatch || "manual"), project: root });
      // Keep the user's requested scope even when a preflight circuit opens
      // before any page entry can exist. History can then say what was
      // selected instead of misleadingly rendering this as a zero-page run.
      record.selection = {
        pageIds: [...pageIds],
        viewportIds: [...viewportIds]
      };
      record.plannedChecks = jobs.length;
      record.executedChecks = 0;

      const addSystemicIncident = (job, terminal) => addInfraError(record, {
        pageId: job?.pageId ?? null,
        stepId: job?.step?.id ?? null,
        viewportId: job?.viewportId ?? null,
        text: terminal.message ?? terminal.code,
        code: terminal.code,
        component: terminal.component ?? "automations"
      });
      const openCircuit = (terminal, job = null) => {
        const skippedChecks = Math.max(0, jobs.length - record.executedChecks);
        record.circuit = {
          component: terminal.component ?? "automations",
          code: terminal.code,
          message: terminal.message ?? terminal.code,
          kind: terminal.kind,
          openedAt: new Date().toISOString(),
          afterCheck: record.executedChecks,
          skippedChecks,
          ...(job ? { trigger: { pageId: job.pageId, stepId: job.step.id, viewportId: job.viewportId } } : {})
        };
      };

      if (jobs.length === 0) {
        const terminal = {
          kind: "incomplete",
          source: "drill-plan",
          code: "no-matching-checks",
          component: "drill",
          message: `No enabled ${state === "default" ? "default-state " : `${state} `}checks match the selected pages and viewports.`
        };
        addSystemicIncident(null, terminal);
        openCircuit(terminal);
        record.endedAt = new Date().toISOString();
        await saveDrillRun(record);
        return send(res, 200, { run: await assembleRunView(record, { hydrate: false }) });
      }

      // S31: persist and claim the record BEFORE the engine preflight (endedAt
      // null = running) so the history table, /api/runs/active, a poller and a
      // second-device Results view all see in-flight state even while the
      // self-heal below is still bringing the engine up - and so the
      // one-run-per-project guard has no multi-second blind window to race
      // through. The re-check + registerActiveRun pair is synchronous (no
      // await between them): a duplicate POST that slipped past the earlier
      // guard during the book/jobs awaits lands here on the claimed entry.
      const claimed = [...activeRuns.values()].find(
        (entry) => !entry.done && (entry.record.project ?? null) === root
      );
      if (claimed) {
        return send(res, 409, {
          error: `a run is already executing for this project - wait for it to finish (run ${claimed.record.id})`,
          runId: claimed.record.id
        });
      }
      const live = registerActiveRun(record);
      await saveDrillRun(record);
      publishRunEvent(record.id, {
        type: "run_started",
        runId: record.id,
        startedAt: record.startedAt,
        plannedChecks: jobs.length,
        selection: record.selection,
        project: root,
        contextTag
      });

      const execute = async () => {
      try {
      // One run-level preflight prevents a missing Automations fitting from
      // being retried once per Book step. Every planned coordinate is still
      // attached to the single grouped incident so the report is honest
      // about the affected coverage. ensureAutomationsUp first self-heals a
      // redeploy-killed engine via Garrison's on-demand lifecycle start; it
      // runs inside execute() so a background caller gets its response and
      // live panel immediately while the heal proceeds, instead of a request
      // pending for the whole engine boot.
      try {
        await ensureAutomationsUp();
      } catch (err) {
        const terminal = terminalFromTransportError(err);
        if (jobs.length === 0) addSystemicIncident(null, terminal);
        else for (const job of jobs) addSystemicIncident(job, terminal);
        openCircuit(terminal);
        record.endedAt = new Date().toISOString();
        record.summary = {
          steps: record.pages.length,
          failed: 0,
          infra: (record.infraErrors ?? []).reduce((total, incident) => total + (incident.count ?? 1), 0)
        };
        await saveDrillRun(record);
        return; // the finally below publishes run_finished
      }
      // Evidence capture (Drill Evidence v0.1, D1/D5): one browser capture
      // session per run — video for multi-check (Full Drill) runs unless the
      // caller toggles it, per-check offset manifest whenever the session came
      // up. Every helper is warn-never-throw: a missing browser fitting or a
      // failed recording degrades evidence, never the run.
      const wantVideo = body.evidence?.video ?? jobs.length > 1;
      const sessionViewport = jobs
        .map((job) => job.viewport)
        .filter((vp) => vp && vp.width && vp.height)
        .reduce((best, vp) => (!best || vp.width * vp.height > best.width * best.height ? vp : best), null);

      // Authenticated runs (A-auth): log in ONCE before any check so every
      // check's fresh navigate lands on the real page, not the login screen.
      // This runs in the shared browser context BEFORE captureStart, so the
      // session persists to the persistent profile and the run's capture
      // session seeds already-logged-in. A login failure collapses into ONE
      // grouped incident + circuit (checks skipped) instead of N product
      // failures for one auth problem. The blind adversarial pass authenticates
      // too — it is blind to specs, not to the login.
      if (hasAuth(book)) {
        publishRunEvent(record.id, { type: "auth_started", runId: record.id, loginUrl: resolveAuthUrl(book) });
        const auth = await ensureAuthenticated(book, { contextTag, viewport: sessionViewport || jobs[0]?.viewport, root });
        if (!auth.ok) {
          // Only a genuine login rejection (auth.authRejected — the flow ran but
          // the app did not grant a session) is blamed on the auth block. An
          // engine/app/harness failure during login keeps its REAL component
          // (auth.terminal) so the incident is not misattributed to "auth" and
          // the user is not misdirected to drills/drillbook.yml. Both "blocked"
          // and the passed-through infra/incomplete kinds render in the
          // harness-degraded banner and open the circuit.
          const terminal = auth.authRejected
            ? {
                kind: "blocked",
                source: "auth",
                code: "auth-failed",
                component: "auth",
                message: `Login did not reach the authenticated state before any check ran: ${auth.terminal?.message ?? "the success signal was not met"} — ${jobs.length} check(s) skipped. Check the app is running and the auth block (steps/success) in drills/drillbook.yml.`
              }
            : auth.terminal;
          for (const job of jobs) addSystemicIncident(job, terminal);
          openCircuit(terminal);
          record.endedAt = new Date().toISOString();
          record.summary = {
            steps: record.pages.length,
            failed: 0,
            infra: (record.infraErrors ?? []).reduce((total, incident) => total + (incident.count ?? 1), 0)
          };
          await saveDrillRun(record);
          publishRunEvent(record.id, { type: "circuit_opened", runId: record.id, ...record.circuit });
          publishRunEvent(record.id, { type: "auth_failed", runId: record.id, component: terminal.component, message: terminal.message });
          return; // the finally below publishes run_finished
        }
        publishRunEvent(record.id, { type: "auth_ok", runId: record.id, via: auth.via });
      }

      const capture = await captureStart({
        runId: record.id,
        root,
        video: wantVideo,
        viewport: sessionViewport,
        // Spotter (Evidence V2): deterministic trigger-driven frames, on by
        // default for every run; Book config + per-run body overrides.
        spotter: spotterRequest(book, body.evidence)
      });
      const manifestRows = [];
      const checkArtifacts = [];

      for (const job of jobs) {
        record.executedChecks += 1;
        const jobStartedAt = Date.now();
        live.current = {
          index: record.executedChecks,
          total: jobs.length,
          pageId: job.pageId,
          stepId: job.step.id,
          viewportId: job.viewportId,
          description: job.step.description || job.step.id,
          startedAt: new Date().toISOString()
        };
        publishRunEvent(record.id, { type: "check_started", runId: record.id, ...live.current });
        const jobKey = checkKey({ pageId: job.pageId, stepId: job.step.id, viewportId: job.viewportId });
        // Per-check trace chunk (D2): bracket the engine run so the zip holds
        // exactly this check's actions/snapshots.
        const chunkOpen = await captureChunkStart(capture, `${job.pageId} · ${job.step.id} · ${job.viewportId}`, { key: jobKey });
        let automationRun;
        let terminal;
        try {
          const response = await runInline({
            automation: job.automation,
            contextTag,
            bypassCache,
            viewport: job.viewport,
            captureSession: capture?.sessionId,
            sync: true
          });
          automationRun = response?.run;
          terminal = terminalFromAutomationRun(automationRun, job.step.id);
        } catch (err) {
          terminal = terminalFromTransportError(err);
        }

        const pr = {
          pageId: job.pageId,
          stepId: job.step.id,
          viewportId: job.viewportId,
          automationRunId: automationRun?.id ?? null,
          status: automationRun?.status ?? "error",
          terminal
        };
        record.pages.push(pr);
        if (capture) {
          const trace = chunkOpen ? await captureChunkStop(capture, jobKey) : null;
          // Step-end full-page screenshot always; an additional one on failure
          // (D3) — the session tab still shows the failure state, and the
          // engine's own at-failure viewport shot rides evidencePath as before.
          const screenshot = await captureScreenshot(capture, `step-${jobKey}`);
          const failureScreenshot = pr.status === "completed"
            ? null
            : await captureScreenshot(capture, `fail-${jobKey}`);
          checkArtifacts.push({
            key: jobKey,
            pageId: job.pageId,
            stepId: job.step.id,
            viewportId: job.viewportId,
            trace,
            screenshot,
            failureScreenshot
          });
          manifestRows.push(manifestRow({
            job,
            automationRun,
            status: pr.status,
            session: capture,
            fallbackStartMs: jobStartedAt - capture.startedAt,
            fallbackEndMs: Date.now() - capture.startedAt
          }));
        }

        // Recovery infrastructure is a secondary incident. Keep the page
        // defect as the authoritative terminal result and finding, but record
        // the failed fixer/observer independently so infra cleanup can group it
        // without swallowing the product failure or opening the run circuit.
        if (terminal.recoveryFailure?.kind === "infra-failure") {
          addSystemicIncident(job, terminal.recoveryFailure);
        }

        // S31: link the verify session, push the check result to live
        // subscribers, and persist the record incrementally - findings added
        // below reach disk with the next check's save (or the final one).
        noteRunSession(record, terminal);
        const checkArt = capture ? checkArtifacts.at(-1) : null;
        publishRunEvent(record.id, {
          type: "check_finished",
          runId: record.id,
          index: record.executedChecks,
          total: jobs.length,
          pageId: pr.pageId,
          stepId: pr.stepId,
          viewportId: pr.viewportId,
          kind: terminal.kind,
          code: terminal.code,
          ...(terminal.message ? { message: terminal.message } : {}),
          ...(terminal.reasoning ? { reasoning: terminal.reasoning } : {}),
          ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
          ...(terminal.tier !== undefined ? { tier: terminal.tier } : {}),
          ...(terminal.session?.id ? { sessionId: terminal.session.id } : {}),
          ...(checkArt?.screenshot ? { screenshot: checkArt.screenshot } : {}),
          ...(checkArt?.failureScreenshot ? { failureScreenshot: checkArt.failureScreenshot } : {})
        });
        live.current = null;
        await saveDrillRun(record);

        if (terminal.kind === "product-failure") {
          const art = capture ? checkArtifacts.at(-1) : null;
          const timing = capture ? manifestRows.at(-1) : null;
          addFinding(record, {
            kind: "step-fail",
            pageId: pr.pageId,
            stepId: pr.stepId,
            viewportId: pr.viewportId,
            text: terminal.message ?? `${pr.stepId} failed`,
            evidence: art && (art.screenshot || art.failureScreenshot || art.trace)
              ? {
                  screenshot: art.failureScreenshot ?? art.screenshot ?? null,
                  trace: art.trace ?? null,
                  videoMs: timing?.startMs ?? null
                }
              : null
          });
          continue;
        }

        if (terminalOpensCircuit(terminal)) {
          addSystemicIncident(job, terminal);
          openCircuit(terminal, job);
          publishRunEvent(record.id, { type: "circuit_opened", runId: record.id, ...record.circuit });
          break;
        }

        // The returned run is the execution result. Use it immediately for
        // state references and graduation as well; neither correctness nor
        // side effects depend on a racy follow-up GET.
        const outcome = resolveStepOutcome(automationRun, pr.stepId);
        if (!outcome) {
          const incomplete = terminalFromAutomationRun(automationRun, pr.stepId);
          pr.terminal = incomplete;
          addSystemicIncident(job, incomplete);
          openCircuit(incomplete, job);
          publishRunEvent(record.id, { type: "circuit_opened", runId: record.id, ...record.circuit });
          break;
        }

        // A successful named-state run is the agent-produced visual reference
        // for that state. Seed the first reference only; later runs retain
        // evidence in their own records but never silently rewrite the Book's
        // accepted state image.
        if (state !== "default" && outcome.evidencePath) {
          const statePage = await getPage(pr.pageId, root);
          const stateIndex = statePage?.states?.findIndex((candidate) => candidate.id === state) ?? -1;
          if (statePage && stateIndex >= 0 && !statePage.states[stateIndex].screenshotPath) {
            const assessment = assessAutomaticStateReference(outcome);
            if (assessment.eligible) {
              const nextStates = statePage.states.map((candidate, index) =>
                index === stateIndex
                  ? {
                      ...candidate,
                      ...(!candidate.matcher?.assertion && outcome.result?.assertion
                        ? { matcher: { assertion: outcome.result.assertion } }
                        : {}),
                      // Prefer drill's own step-end capture as a ROOT-RELATIVE
                      // reference (D4: Book entries reference evidence by
                      // relative path only); legacy absolute engine paths stay
                      // readable via resolveEvidencePath.
                      screenshotPath: capture && checkArtifacts.at(-1)?.screenshot
                        ? evidenceRootRef(record.id, root, checkArtifacts.at(-1).screenshot)
                        : outcome.evidencePath,
                      referenceSource: {
                        runId: record.id,
                        stepId: pr.stepId,
                        viewportId: pr.viewportId,
                        at: new Date().toISOString()
                      }
                    }
                  : candidate
              );
              await savePage(pr.pageId, { states: nextStates }, root);
              pr.stateReferenceSeeded = state;
            } else if (assessment.reason === "unexpected-page-error") {
              pr.stateReferenceRejected = {
                state,
                reason: assessment.reason,
                warnings: assessment.warnings
              };
            }
          }
        }

        // Graduation (B8/B12, and the B7 healer path re-emitting on a stale
        // graduated assertion): a vision/recovered pass that resolved a
        // deterministic assertion (or is author-marked judgment) flips the
        // step to e2e and (re-)writes the page's committed spec. Never during
        // a blind adversarial pass (R12) - it must not silently rewrite the
        // plan it was supposed to be independently checking.
        if (!blind) {
          const page = await getPage(pr.pageId, root);
          const step = page?.steps.find((candidate) => candidate.id === pr.stepId);
          if (step) {
            const plan = graduationPlanFor(step, outcome);
            if (plan) {
              try {
                const { specFile } = await graduateStep(book, pr.pageId, pr.stepId, plan, root);
                pr.graduated = { specFile, judgment: !!plan.judgment };
              } catch (err) {
                pr.graduationError = err.message;
              }
            }
          }
        }
      }

      if (capture) {
        const stopped = await captureStop(capture);
        const stepsFile = await writeStepsManifest(capture, manifestRows);
        // Relative names only (portability constraint): the run's evidence
        // dir is derivable from (project, runId); bytes go through confined
        // HTTP routes, never host paths.
        const checks = manifestRows.map((row, i) => ({ ...row, ...checkArtifacts[i] }));
        const indexFile = await writeEvidenceIndex(capture, {
          project: root,
          runId: record.id,
          video: stopped?.video ?? null,
          checks,
          spotter: stopped?.spotter ?? null
        });
        record.evidence = {
          video: stopped?.video ?? null,
          steps: stepsFile ?? null,
          index: indexFile ?? null,
          spotter: stopped?.spotter?.manifest
            ? { manifest: stopped.spotter.manifest, frames: stopped.spotter.frames ?? stopped.spotter.counts?.kept ?? 0 }
            : null
        };
      }

      record.endedAt = new Date().toISOString();
      record.summary = {
        steps: record.pages.length,
        failed: record.pages.filter((entry) => entry.terminal?.kind === "product-failure").length,
        infra: (record.infraErrors ?? []).reduce((total, incident) => total + (incident.count ?? 1), 0)
      };
      // Session transcript slices (S31): store each verify session's
      // run-window lines with the run's other evidence, so the debrief can
      // replay the session after the live transcript file moves on (the
      // gateway reuses delegate sessions across runs) or disappears.
      for (const session of record.sessions ?? []) {
        if (!session.transcriptPath) continue;
        try {
          const { lines } = await readJsonlLines(session.transcriptPath, 0);
          const windowed = linesInWindow(lines, record.startedAt, record.endedAt);
          if (!windowed.length) continue;
          const name = sessionSliceName(session.id);
          await atomicWrite(path.join(evidenceRunDir(record.id, root), name), `${windowed.join("\n")}\n`);
          session.slice = name;
          session.events = parseTranscriptLines(windowed).events.length;
        } catch (err) {
          console.warn(`[drill] session slice for ${session.id} failed: ${err.message}`);
        }
      }
      await saveDrillRun(record);
      // Retention (D6): applied on run completion, fire-and-forget — pruning
      // must never delay or fail the run response.
      void (async () => {
        const runs = await listDrillRuns();
        const scoped = runs.filter((r) => (r.project || null) === (root || null));
        const pruned = await pruneEvidence({ root, classified: classifyForRetention(scoped) });
        for (const p of pruned) console.log(`[drill] evidence retention: pruned ${p.removed.join(", ")} from run ${p.runId}`);
      })().catch((err) => console.warn(`[drill] evidence: retention sweep failed: ${err.message}`));
      // Curation (Evidence V2, S2/D4): batch vision judging of the Spotter
      // frames into the Debrief reel — fire-and-forget, and it writes ONLY
      // evidence files (reel.json + sidecars), never the run record, so a
      // slow model turn can't clobber concurrent triage.
      if (record.evidence?.spotter) {
        void curateRunEvidence({
          record,
          root,
          config: curationConfig(book, body.evidence),
          app: book.app?.name
        })
          .then((reel) => {
            if (reel) console.log(`[drill] curation: reel ${reel.counts.reel}/${reel.counts.frames} frames for run ${record.id} via ${reel.routedVia ?? "?"}`);
          })
          .catch((err) => console.warn(`[drill] curation: ${err.message}`));
      }
      } catch (err) {
        // A crash must still land a terminal record: background mode has no
        // HTTP response to carry the error, and sync callers deserve the
        // partial record over a 500 with in-flight state stranded on disk.
        console.error(`[drill] run ${record.id} crashed: ${err.message}`);
        addInfraError(record, { text: `drill run crashed: ${err.message}`, code: "drill-run-crashed", component: "drill" });
        if (!record.endedAt) {
          record.endedAt = new Date().toISOString();
          record.summary = {
            steps: record.pages.length,
            failed: record.pages.filter((entry) => entry.terminal?.kind === "product-failure").length,
            infra: (record.infraErrors ?? []).reduce((total, incident) => total + (incident.count ?? 1), 0)
          };
        }
        await saveDrillRun(record).catch((saveErr) => console.error(`[drill] crash save failed: ${saveErr.message}`));
      } finally {
        publishRunEvent(record.id, {
          type: "run_finished",
          runId: record.id,
          endedAt: record.endedAt,
          summary: record.summary ?? null,
          ...(record.circuit ? { circuit: record.circuit } : {})
        });
      }
      };

      // background:true (the UI's mode): kick the run and return the
      // in-flight record immediately - progress rides GET /api/runs/:id/events
      // and the incremental disk record. The DEFAULT stays synchronous: skill
      // and heartbeat callers await the finished run through this one POST.
      if (body.background === true) {
        void execute().catch((err) => console.error(`[drill] background run ${record.id} failed: ${err.message}`));
        return send(res, 200, { run: await assembleRunView(record, { hydrate: false }), background: true });
      }
      await execute();
      return send(res, 200, { run: await assembleRunView(record, { hydrate: false }) });
    }
    if (pathname === "/api/runs" && req.method === "GET") {
      // Scoped to the selected project by default; pre-project records (no
      // `project` field) always show. ?all=1 lifts the scope.
      const all = url.searchParams.get("all") === "1";
      const active = drillTargetRoot();
      const runs = await listDrillRuns();
      const scoped = all ? runs : runs.filter((r) => !r.project || r.project === active);
      return send(res, 200, { runs: scoped.map(publicRunRecord) });
    }
    // S31: in-flight run discovery - a reloaded (or second-device) Results
    // view finds the running drill here and re-attaches to its event stream.
    // Scoped to the selected project like GET /api/runs, so a skill-driven
    // run against ANOTHER repo never hijacks this project's Results view;
    // ?all=1 lifts the scope.
    if (pathname === "/api/runs/active" && req.method === "GET") {
      const all = url.searchParams.get("all") === "1";
      const activeRoot = drillTargetRoot();
      const entries = [...activeRuns.values()].filter((entry) => !entry.done);
      const scoped = all
        ? entries
        : entries.filter((entry) => !entry.record.project || entry.record.project === activeRoot);
      return send(res, 200, { runs: scoped.map(activeRunSnapshot) });
    }
    // S31: per-run progress stream. Replays the buffered events, then stays
    // live until run_finished. For a run not active in this process the
    // stream reports the terminal state and closes - the client falls back
    // to the disk record.
    const runEventsGet = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (runEventsGet && req.method === "GET") {
      const runId = decodeURIComponent(runEventsGet[1]);
      const entry = activeRuns.get(runId);
      if (!entry) {
        let record = null;
        try { record = await getDrillRun(runId); } catch { record = null; }
        res.writeHead(200, SSE_HEADERS);
        res.write(`data: ${JSON.stringify({
          type: record?.endedAt ? "run_finished" : "run_unknown",
          runId,
          at: new Date().toISOString(),
          ...(record?.endedAt ? { endedAt: record.endedAt, summary: record.summary ?? null } : {})
        })}\n\n`);
        return void res.end();
      }
      res.writeHead(200, SSE_HEADERS);
      for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (entry.done) return void res.end();
      entry.listeners.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(": keep-alive\n\n"); } catch { /* closed */ }
      }, 15_000);
      keepAlive.unref?.();
      req.on("close", () => {
        clearInterval(keepAlive);
        entry.listeners.delete(res);
      });
      return;
    }
    // S31: the verify-session transcript stream. One endpoint serves both
    // shapes: `init` (everything so far - the stored per-run slice when it
    // exists, else the live transcript filtered to the run window) followed
    // by live `events` batches while the run is still executing, then `end`.
    const runSessionStreamGet = pathname.match(/^\/api\/runs\/([^/]+)\/session-stream$/);
    if (runSessionStreamGet && req.method === "GET") {
      const runId = decodeURIComponent(runSessionStreamGet[1]);
      const sessionId = String(url.searchParams.get("session") ?? "");
      const entry = activeRuns.get(runId);
      let record = entry?.record ?? null;
      if (!record) {
        try { record = await getDrillRun(runId); } catch { record = null; }
      }
      if (!record) return send(res, 404, { error: "not found" });
      const session = (record.sessions ?? []).find((candidate) => candidate.id === sessionId);
      if (!session) return send(res, 404, { error: "unknown session for this run" });
      const sliceFile = session.slice
        ? path.join(evidenceRunDir(record.id, record.project || drillTargetRoot()), session.slice)
        : null;
      const liveEntry = entry && !entry.done ? entry : null;

      res.writeHead(200, SSE_HEADERS);
      let closed = false;
      req.on("close", () => { closed = true; });
      const emit = (payload) => {
        if (closed) return;
        try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { closed = true; }
      };
      const keepAlive = setInterval(() => {
        if (closed) return;
        try { res.write(": keep-alive\n\n"); } catch { closed = true; }
      }, 15_000);
      keepAlive.unref?.();
      try {
        let offset = 0;
        let tailPath = null;
        let initLines = [];
        if (sliceFile) {
          try { initLines = (await readJsonlLines(sliceFile, 0)).lines; } catch { initLines = []; }
        }
        if (!initLines.length && session.transcriptPath) {
          try {
            const read = await readJsonlLines(session.transcriptPath, 0);
            initLines = linesInWindow(read.lines, record.startedAt, record.endedAt);
            offset = read.offset;
            tailPath = session.transcriptPath;
          } catch { tailPath = null; }
        }
        const parsed = parseTranscriptLines(initLines);
        emit({
          type: "init",
          sessionId,
          title: parsed.title,
          events: parsed.events,
          live: !!liveEntry,
          available: initLines.length > 0 || !!tailPath
        });
        // Live tail: new complete transcript lines while the run executes.
        while (!closed && liveEntry && !liveEntry.done && tailPath) {
          await sleep(800);
          try {
            const read = await readJsonlLines(tailPath, offset);
            if (read.lines.length) {
              offset = read.offset;
              const chunk = parseTranscriptLines(read.lines);
              if (chunk.events.length || chunk.title) {
                emit({ type: "events", sessionId, title: chunk.title, events: chunk.events });
              }
            }
          } catch { /* transient read failure - keep polling */ }
        }
        emit({ type: "end", sessionId });
      } finally {
        clearInterval(keepAlive);
        try { res.end(); } catch { /* already closed */ }
      }
      return;
    }
    const runGet = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runGet && req.method === "GET") {
      const record = await getDrillRun(decodeURIComponent(runGet[1]));
      return record ? send(res, 200, { run: await assembleRunView(record) }) : send(res, 404, { error: "not found" });
    }
    if (runGet && req.method === "DELETE") {
      const runId = decodeURIComponent(runGet[1]);
      const busy = activeRunMutation(runId);
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(runId);
      const deleted = await deleteDrillRun(runId);
      if (deleted && record) await removeRunEvidence(runId, record.project || drillTargetRoot());
      return send(res, 200, { deleted });
    }
    // Drill Evidence v0.1 (D4): the per-run index + confined artifact serving.
    // Artifact bytes only ever leave through these routes — records carry
    // relative names, never host paths.
    const runEvidenceIndexGet = pathname.match(/^\/api\/runs\/([^/]+)\/evidence-index$/);
    if (runEvidenceIndexGet && req.method === "GET") {
      const record = await getDrillRun(decodeURIComponent(runEvidenceIndexGet[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const dir = evidenceRunDir(record.id, record.project || drillTargetRoot());
      try {
        const index = JSON.parse(await readFile(path.join(dir, "evidence.json"), "utf8"));
        let steps = null;
        try { steps = JSON.parse(await readFile(path.join(dir, "steps.json"), "utf8")); } catch { /* pre-index run */ }
        return send(res, 200, { index, steps });
      } catch {
        return send(res, 404, { error: "no evidence index for this run" });
      }
    }
    const runEvidenceFileGet = pathname.match(/^\/api\/runs\/([^/]+)\/evidence-file\/([^/]+)$/);
    if (runEvidenceFileGet && req.method === "GET") {
      const record = await getDrillRun(decodeURIComponent(runEvidenceFileGet[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const name = decodeURIComponent(runEvidenceFileGet[2]);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(name)) return send(res, 400, { error: "invalid evidence name" });
      const dir = evidenceRunDir(record.id, record.project || drillTargetRoot());
      const file = path.join(dir, name);
      let fileInfo;
      try {
        // Realpath containment: the name regex already forbids separators and
        // dotfiles; this guards symlinked run dirs the same way the
        // automations evidence serve does.
        const real = await realpath(file);
        const realDir = await realpath(dir);
        if (real !== path.join(realDir, name)) return send(res, 404, { error: "not found" });
        fileInfo = await stat(real);
        if (!fileInfo.isFile()) return send(res, 404, { error: "not found" });
      } catch {
        return send(res, 404, { error: "not found" });
      }
      const types = {
        ".webm": "video/webm",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".zip": "application/zip",
        ".json": "application/json"
      };
      const ext = path.extname(name).toLowerCase();
      const type = types[ext] ?? "application/octet-stream";
      const headers = {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(ext === ".zip" ? { "content-disposition": `attachment; filename="${name}"` } : {})
      };
      // Range support: webm scrubbing and #t= media-fragment deep links need
      // 206 responses; everything else streams whole.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2]) && ext === ".webm") {
        const size = fileInfo.size;
        let start = range[1] ? Number(range[1]) : size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
          return send(res, 416, { error: "range not satisfiable" }, { "content-range": `bytes */${size}` });
        }
        res.writeHead(206, {
          ...headers,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-length": String(end - start + 1)
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, "accept-ranges": "bytes", "content-length": String(fileInfo.size) });
      createReadStream(file).pipe(res);
      return;
    }
    if (pathname === "/api/live-replay" && req.method === "GET") {
      return send(res, 200, { live: await liveReplayPublic() });
    }
    if (pathname === "/api/live-replay" && req.method === "DELETE") {
      if (!liveReplay) return send(res, 200, { ok: true, released: false });
      const sessionId = liveReplay.sessionId;
      liveReplay = null;
      try {
        await captureCall("/capture/stop", { sessionId });
      } catch (err) {
        console.warn(`[drill] live-replay stop: ${err.message}`);
      }
      return send(res, 200, { ok: true, released: true });
    }
    const liveReplayPost = pathname.match(/^\/api\/runs\/([^/]+)\/live-replay$/);
    if (liveReplayPost && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(liveReplayPost[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(liveReplayPost[1]));
      if (!record) return send(res, 404, { error: "not found" });
      if (liveReplay) {
        return send(res, 409, { error: "a live session is already open - close it first", live: await liveReplayPublic() });
      }
      const body = await readJsonBody(req);
      const pageId = String(body.pageId ?? "");
      const stepId = String(body.stepId ?? "");
      const viewportId = String(body.viewportId ?? "desktop");
      const root = record.project || drillTargetRoot();
      const book = await getDrillBook(root);
      const page = await getPage(pageId, root);
      if (!page) return send(res, 404, { error: "page not found" });
      const steps = selectSteps(page, { state: record.state || "default", viewport: viewportId });
      const idx = steps.findIndex((s) => s.id === stepId);
      if (idx === -1) return send(res, 404, { error: "step not part of this page/viewport selection" });
      let viewport;
      try { viewport = resolveViewport(viewportId); } catch (err) { return send(res, 400, { error: err.message }); }
      const sessionId = `live-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const dir = path.join(drillHomeDir(), "live", sessionId);
      // Same self-heal as the run preflight; on failure the replay loop
      // surfaces the per-step transport error as a warning.
      await ensureAutomationsUp().catch(() => {});
      // Authenticated apps: establish the session in the shared context before
      // the held capture session is created, so the replay tab seeds
      // logged-in (best-effort — the replay loop reports per-step issues).
      if (hasAuth(book)) {
        await ensureAuthenticated(book, { contextTag: "drill", viewport, root }).catch(() => {});
      }
      let session;
      try {
        session = await captureCall("/capture/start", {
          sessionId,
          dir,
          video: false,
          hold: true,
          viewport: viewport?.width ? { width: viewport.width, height: viewport.height } : undefined
        });
      } catch (err) {
        return send(res, 502, { error: `browser session failed: ${err.message}` });
      }
      liveReplay = {
        sessionId,
        tabId: session.tabId ?? null,
        runId: record.id,
        pageId,
        stepId,
        viewportId,
        startedAt: new Date().toISOString(),
        replayed: 0,
        of: idx + 1
      };
      // Replay steps 0..idx sequentially in the held session - the exact
      // compiled automations a run would execute, one shared tab so state
      // accumulates the same way it does during a drill run.
      const warnings = [];
      for (let i = 0; i <= idx; i++) {
        const step = steps[i];
        try {
          const response = await runInline({
            automation: compileStepAutomation(book, page, step, { blind: false }),
            contextTag: "drill",
            bypassCache: false,
            viewport,
            captureSession: sessionId,
            sync: true
          });
          if (response?.run?.status !== "completed") warnings.push(`${step.id}: ${response?.run?.status ?? "no run"}`);
        } catch (err) {
          warnings.push(`${step.id}: ${err.message}`);
          break;
        }
        if (!liveReplay || liveReplay.sessionId !== sessionId) {
          return send(res, 409, { error: "live session was closed during replay" });
        }
        liveReplay.replayed = i + 1;
      }
      const url = liveReplay.tabId ? canvasUrl(liveReplay.tabId, viewport) : null;
      return send(res, 200, { ok: true, live: { ...liveReplay, canvasUrl: url, canvasTailnetUrl: await toTailnetUrl(url) }, warnings });
    }
    // Debrief operator feedback (Evidence V2, D6): lightweight view events —
    // long dwells, show-all expansions, explicit frame flags — appended next
    // to the run's evidence. v1 only RECORDS them; nothing consumes them to
    // reweight rules yet. Never pruned (the name matches no retention rule).
    const debriefFeedbackPost = pathname.match(/^\/api\/runs\/([^/]+)\/debrief-feedback$/);
    if (debriefFeedbackPost && req.method === "POST") {
      const record = await getDrillRun(decodeURIComponent(debriefFeedbackPost[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      const incoming = (Array.isArray(body.events) ? body.events : [])
        .filter((e) => e && typeof e === "object" && typeof e.type === "string")
        .slice(0, 100)
        .map((e) => ({
          type: e.type.slice(0, 32),
          frame: typeof e.frame === "string" ? e.frame.slice(0, 200) : undefined,
          ms: Number.isFinite(Number(e.ms)) ? Math.round(Number(e.ms)) : undefined,
          scope: typeof e.scope === "string" ? e.scope.slice(0, 200) : undefined,
          at: new Date().toISOString()
        }));
      if (incoming.length === 0) return send(res, 400, { error: "events required" });
      const dir = evidenceRunDir(record.id, record.project || drillTargetRoot());
      const file = path.join(dir, "debrief-feedback.json");
      let events = [];
      try { events = JSON.parse(await readFile(file, "utf8")).events ?? []; } catch { /* first write */ }
      events.push(...incoming);
      if (events.length > 5000) events = events.slice(events.length - 5000);
      try {
        await atomicWrite(file, JSON.stringify({ runId: record.id, events }, null, 2));
      } catch (err) {
        return send(res, 500, { error: `feedback write failed: ${err.message}` });
      }
      return send(res, 200, { ok: true, recorded: incoming.length, total: events.length });
    }
    const runEvidenceGet = pathname.match(/^\/api\/runs\/([^/]+)\/evidence\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (runEvidenceGet && req.method === "GET") {
      const [runId, pageId, stepId, viewportId] = runEvidenceGet.slice(1).map(decodeURIComponent);
      const record = await getDrillRun(runId);
      if (!record) return send(res, 404, { error: "run not found" });
      const entry = record.pages.find((candidate) =>
        candidate.pageId === pageId &&
        candidate.stepId === stepId &&
        candidate.viewportId === viewportId
      );
      if (!entry?.automationRunId) return send(res, 404, { error: "evidence not found" });
      try {
        // Evidence bytes live engine-side, so a finished run's thumbnails
        // 502 whenever the engine is down (every redeploy) - self-heal it
        // here too, with a shorter bound since a debrief render fans out
        // many parallel evidence requests that would each hold a socket.
        await ensureAutomationsUp({ timeoutMs: 15000 });
        const bytes = await getStepEvidence(entry.automationRunId, stepId);
        if (!bytes) return send(res, 404, { error: "evidence not found" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Content-Length", String(bytes.length));
        res.setHeader("Cache-Control", "no-store");
        return res.end(bytes);
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    const feedbackMatch = pathname.match(/^\/api\/runs\/([^/]+)\/feedback$/);
    if (feedbackMatch && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(feedbackMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(feedbackMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      if (body.viewportId && !record.pages.some((entry) =>
        entry.pageId === body.pageId &&
        entry.stepId === body.stepId &&
        entry.viewportId === body.viewportId
      )) return send(res, 400, { error: "run check not found for viewport" });
      addFeedback(record, body.pageId, body.stepId, body.note, body.viewportId ?? null);
      await saveDrillRun(record);
      return send(res, 200, { run: await assembleRunView(record) });
    }

    // D5: a verdict override in either direction. Flipping TO failed pools a
    // finding - "a pass you know is wrong becomes a failed finding."
    const overrideMatch = pathname.match(/^\/api\/runs\/([^/]+)\/override$/);
    if (overrideMatch && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(overrideMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(overrideMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      if (body.viewportId && !record.pages.some((entry) =>
        entry.pageId === body.pageId &&
        entry.stepId === body.stepId &&
        entry.viewportId === body.viewportId
      )) return send(res, 400, { error: "run check not found for viewport" });
      setOverride(record, body.pageId, body.stepId, body.verdict, body.note, body.viewportId ?? null);
      if (body.verdict === "failed") {
        addFinding(record, {
          kind: "verdict-flip",
          pageId: body.pageId,
          stepId: body.stepId,
          viewportId: body.viewportId ?? null,
          text: body.note || `${body.stepId} flagged failed by override${body.viewportId ? ` at ${body.viewportId}` : ""}`
        });
      }
      await saveDrillRun(record);
      return send(res, 200, { run: await assembleRunView(record) });
    }

    // D9: a run-level observation - recording it never requires a re-run.
    const obsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/observation$/);
    if (obsMatch && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(obsMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(obsMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      const observation = addObservation(record, body.text);
      await saveDrillRun(record);
      return send(res, 200, { observation, run: await assembleRunView(record) });
    }
    // Convert an observation into a draft step on its page.
    const obsStepMatch = pathname.match(/^\/api\/runs\/([^/]+)\/observation\/([^/]+)\/convert-step$/);
    if (obsStepMatch && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(obsStepMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(obsStepMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const observation = record.observations.find((o) => o.id === decodeURIComponent(obsStepMatch[2]));
      if (!observation) return send(res, 404, { error: "observation not found" });
      const body = await readJsonBody(req);
      const page = await getPage(body.pageId);
      if (!page) return send(res, 404, { error: "page not found" });
      const step = {
        id: `obs-${observation.id}`, area: body.area ?? 0, mode: "vision", enabled: true,
        viewports: body.viewports ?? ["desktop"], state: record.state, description: observation.text, tags: ["from-observation"]
      };
      await savePage(body.pageId, { steps: [...page.steps, step] });
      observation.convertedToStep = step.id;
      await saveDrillRun(record);
      return send(res, 200, { step, run: await assembleRunView(record) });
    }
    // Convert an observation into a finding.
    const obsFindingMatch = pathname.match(/^\/api\/runs\/([^/]+)\/observation\/([^/]+)\/convert-finding$/);
    if (obsFindingMatch && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(obsFindingMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(obsFindingMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const observation = record.observations.find((o) => o.id === decodeURIComponent(obsFindingMatch[2]));
      if (!observation) return send(res, 404, { error: "observation not found" });
      const body = await readJsonBody(req);
      if (!body.pageId || typeof body.pageId !== "string") {
        return send(res, 400, { error: "pageId required: choose the page this observation belongs to" });
      }
      const page = await getPage(body.pageId);
      if (!page) return send(res, 404, { error: "page not found" });
      const finding = addFinding(record, { kind: "observation", pageId: body.pageId, text: observation.text });
      observation.convertedToFinding = finding.id;
      await saveDrillRun(record);
      return send(res, 200, { finding, run: await assembleRunView(record) });
    }

    // D10: triage a finding (proposed -> confirmed | dismissed).
    const findingMatch = pathname.match(/^\/api\/runs\/([^/]+)\/findings\/([^/]+)$/);
    if (findingMatch && req.method === "PATCH") {
      const busy = activeRunMutation(decodeURIComponent(findingMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(findingMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      try {
        setFindingStatus(record, decodeURIComponent(findingMatch[2]), body.status);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      await saveDrillRun(record);
      return send(res, 200, { run: await assembleRunView(record) });
    }

    // R14/S27: a testing-only task - a card carrying a `drill` block that
    // enters the roster directly at the `drill` list (skips plan/implement/
    // review). A manual PATCH to an existing list needs no engine header
    // (kanban-loop's handlePatchCard only rejects moves off an ENGINE-OWNED
    // list); "drill" must exist as a real list on the live board (Phase 7's
    // roster registration) for the move to succeed.
    if (pathname === "/api/testing-task" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pageIds = Array.isArray(body.pageIds) ? body.pageIds : [];
      if (pageIds.length === 0) return send(res, 400, { error: "pageIds required" });
      const root = drillTargetRoot();
      const book = await getDrillBook(root);
      const drillBlock = {
        book: book.app.name || root,
        select: { pages: pageIds, "steps-or-tags": body.tags ?? [], states: body.states ?? [] },
        viewports: body.viewports ?? ["desktop"],
        autonomy: body.autonomy || book.autonomy || "gated",
        dispatch: body.dispatch || book.dispatch || "manual"
      };
      const base = await kanbanBaseUrl();
      if (!base) return send(res, 502, { error: "kanban-loop fitting not running (no status file)" });
      try {
        const createRes = await fetch(`${base}/cards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            description: body.description || `Test: ${pageIds.join(", ")}`,
            drill: drillBlock,
            origin: "drill",
            project: root
          })
        });
        if (!createRes.ok) return send(res, 502, { error: `kanban-loop ${createRes.status}: ${await createRes.text()}` });
        const created = (await createRes.json()).card;
        const moveRes = await fetch(`${base}/cards/${encodeURIComponent(created.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ list: "drill", rev: created.rev ?? 0 })
        });
        if (!moveRes.ok) return send(res, 502, { error: `kanban-loop move ${moveRes.status}: ${await moveRes.text()}` });
        const card = (await moveRes.json()).card;
        return send(res, 200, { card });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }

    // R10: dispatch the confirmed findings as ONE batch fix card. Manual
    // (the button) and Immediate dispatch now; Heartbeat records intent -
    // the actual periodic pickup is a self-contained sweep (heartbeat.mjs)
    // over runs whose OWN dispatch mode is "heartbeat", triggered by the
    // timer in startServer() or on demand via POST /api/heartbeat/run-once.
    // Only findings NOT already on a card go out - dispatch is idempotent.
    const dispatchMatch = pathname.match(/^\/api\/runs\/([^/]+)\/dispatch$/);
    if (dispatchMatch && req.method === "POST") {
      const busy = activeRunMutation(decodeURIComponent(dispatchMatch[1]));
      if (busy) return send(res, 409, busy);
      const record = await getDrillRun(decodeURIComponent(dispatchMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      const mode = body.mode || "manual";
      if (!["manual", "heartbeat", "immediate"].includes(mode)) {
        return send(res, 400, { error: `invalid dispatch mode: ${mode}` });
      }
      const eligibleFindings = confirmedFindings(record);
      const confirmed = undispatchedConfirmedFindings(record);
      if (confirmed.length === 0) {
        if (eligibleFindings.length === 0) {
          return send(res, 400, { error: "no confirmed findings to dispatch" });
        }
        const existingCardIds = [...new Set([
          ...eligibleFindings.map((finding) => finding.card?.id).filter(Boolean),
          record.dispatchedCard?.id
        ].filter(Boolean))];
        const cardSuffix = existingCardIds.length > 0
          ? ` (${existingCardIds.map((id) => `card ${id}`).join(", ")})`
          : "";
        // A pure retry conflicts with the existing dispatch. This preserves
        // the whole-report API's explicit duplicate signal while per-finding
        // stamps still allow a later newly-confirmed finding through.
        return send(res, 409, {
          error: `every confirmed finding is already on a fix card${cardSuffix} - nothing new to dispatch`
        });
      }
      if (mode === "heartbeat") {
        record.dispatch = "heartbeat";
        await saveDrillRun(record);
        return send(res, 200, {
          dispatched: false,
          mode: "heartbeat",
          pending: confirmed.length,
          run: await assembleRunView(record, { hydrate: false })
        });
      }
      try {
        const card = await dispatchBatchFixCard(record, confirmed);
        // Re-load before stamping (same as the heartbeat sweep): the kanban
        // POST is a long await, and a concurrent triage/feedback write on
        // this run must not be clobbered by saving the pre-fetch snapshot.
        const fresh = (await getDrillRun(record.id)) ?? record;
        markFindingsDispatched(fresh, confirmed.map((f) => f.id), card);
        fresh.dispatch = mode;
        fresh.dispatchedAt = new Date().toISOString();
        fresh.dispatchedCard = { id: card.id, list: card.list ?? "code" };
        await saveDrillRun(fresh);
        return send(res, 200, {
          dispatched: true,
          mode,
          card,
          run: await assembleRunView(fresh, { hydrate: false })
        });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // On-demand heartbeat sweep (also run periodically - see startServer()).
    if (pathname === "/api/heartbeat/run-once" && req.method === "POST") {
      const results = await runHeartbeatSweep(dispatchBatchFixCard);
      return send(res, 200, { results });
    }

    // Static UI - SPA fallback, confined to DIST (no path escape).
    if (!pathname.startsWith("/api/")) {
      const rel = pathname === "/" ? "index.html" : pathname.slice(1);
      const resolved = path.resolve(DIST, rel);
      if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) {
        return send(res, 403, { error: "forbidden" });
      }
      try {
        const body = await readFile(resolved, "utf8");
        const type = rel.endsWith(".js") ? "application/javascript" : rel.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
        return send(res, 200, body, { "content-type": type });
      } catch {
        try {
          const index = await readFile(path.join(DIST, "index.html"), "utf8");
          return send(res, 200, index, { "content-type": "text/html; charset=utf-8" });
        } catch {
          return send(res, 500, `<!doctype html><title>Drill</title><body>Drill UI asset missing: ${DIST}/index.html not found. Reinstall the fitting (apm install).</body>`);
        }
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function assertStatusSlotFree() {
  let recorded;
  try { recorded = JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return; }
  const pid = Number(recorded?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
    console.error(`[drill] ${STATUS_FILE} is held by live pid ${pid} - refusing to overwrite another instance's status file`);
    process.exit(1);
  }
}

async function writeStatusFile(port, host) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port,
        url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        route: "/",
        views: [{ id: "drill", title: "Drill", route: "/" }]
      },
      null,
      2
    )
  );
}

export function createServer() {
  return http.createServer((req, res) => void handle(req, res));
}

export async function startServer() {
  // Port precedence (house convention, same as improver/ports-default): the
  // runner-projected composition config first (GARRISON_DRILL_* — the
  // per-instance source of truth, e.g. main=7096 while codex=27096), then
  // the legacy explicit env (tests), then the hardcoded default.
  const host = process.env.GARRISON_DRILL_BIND_HOST || process.env.DRILL_UI_HOST || "127.0.0.1";
  const port = Number(process.env.GARRISON_DRILL_PORT || process.env.DRILL_UI_PORT || DEFAULT_PORT);
  assertStatusSlotFree();
  const server = createServer();
  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[drill] port ${port} is already in use - refusing to start on a shifted port (the configured port is canonical)`);
      process.exit(1);
    }
    throw err;
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  await writeStatusFile(port, host);
  // Plan agents spawned by a PREVIOUS server process survive its death and
  // keep authoring their repos; reap them before this process accepts a
  // retry, or two agents end up rewriting the same drills/ tree.
  try {
    const reaped = await reapOrphanPlanAgents();
    for (const rec of reaped) console.log(`[drill] reaped orphaned plan agent pid=${rec.pid} root=${rec.root}`);
  } catch (err) {
    console.error(`[drill] orphan plan-agent sweep failed: ${err.message}`);
  }
  // S31: run records persist incrementally while executing (endedAt null =
  // running). A record still open at boot belonged to a previous server
  // process - close it honestly so the history table never shows a phantom
  // "Running" row. This process has no active runs yet, so every open record
  // is an orphan by construction.
  try {
    const orphans = (await listDrillRuns()).filter((record) => !record.endedAt);
    for (const record of orphans) {
      addInfraError(record, {
        text: "drill server restarted mid-run - remaining checks never executed",
        code: "drill-restarted-mid-run",
        component: "drill"
      });
      record.circuit ??= {
        component: "drill",
        code: "drill-restarted-mid-run",
        message: "drill server restarted mid-run",
        kind: "infra-failure",
        openedAt: new Date().toISOString(),
        afterCheck: record.executedChecks ?? (record.pages ?? []).length,
        skippedChecks: Math.max(0, (record.plannedChecks ?? 0) - (record.executedChecks ?? 0))
      };
      record.endedAt = new Date().toISOString();
      record.summary = {
        steps: (record.pages ?? []).length,
        failed: (record.pages ?? []).filter((entry) => entry.terminal?.kind === "product-failure").length,
        infra: (record.infraErrors ?? []).reduce((total, incident) => total + (incident.count ?? 1), 0)
      };
      await saveDrillRun(record);
      console.log(`[drill] closed orphaned in-flight run ${record.id}`);
    }
  } catch (err) {
    console.error(`[drill] orphan run sweep failed: ${err.message}`);
  }
  // Heartbeat dispatch pickup (D10/S29): best-effort periodic sweep - a
  // transient kanban-loop outage must never crash the Drill server.
  const heartbeatMs = Number(process.env.DRILL_HEARTBEAT_INTERVAL_MS || 60000);
  const heartbeatTimer = setInterval(() => {
    runHeartbeatSweep(dispatchBatchFixCard).catch((err) => console.error(`[drill] heartbeat sweep failed: ${err.message}`));
  }, heartbeatMs);
  heartbeatTimer.unref?.();
  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    try { await unlink(STATUS_FILE); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log(`drill server on http://${host}:${port}`);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--probe")) {
    console.log("ok");
    process.exit(0);
  }
  startServer().catch((err) => { console.error(err); process.exit(1); });
}
