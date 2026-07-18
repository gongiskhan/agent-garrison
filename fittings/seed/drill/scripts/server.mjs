// Drill own-port server. Serves the Drill Book + page CRUD REST API + /health,
// registers its status file under ~/.garrison/ui-fittings/, and serves the
// authoring/results UI from dist/ (same shape as automations/browser-default).

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { getDrillBook, saveDrillBook, listPages, getPage, savePage, deletePage, drillTargetRoot } from "../lib/store.mjs";
import { listProjects, selectProject, findRunSkill, projectInfo, activeProjectRoot, readDevRoot, canonicalRoot } from "../lib/projects.mjs";
import { urlReachable, startApp, getJob, publicJob } from "../lib/app-runner.mjs";
import { startPlan, getPlanJob, publicPlanJob, reapOrphanPlanAgents } from "../lib/planner.mjs";
import { openTab, evalJs, observeTab, canvasUrl, browserBaseUrl, navigateTab, tabAction, closeTab, tabInfo, readConsole } from "../lib/browser-fitting-client.mjs";
import { buildPickScript, buildResolveScript, rectToPercent } from "../lib/picker.mjs";
import { resolveViewport, viewportList } from "../lib/viewports.mjs";
import { selectSteps, compileStepAutomation } from "../lib/compile.mjs";
import { graduationPlanFor, graduateStep } from "../lib/graduate.mjs";
import { saveSnapshot, listSnapshots, getSnapshot } from "../lib/snapshots.mjs";
import { promoteSnapshotToState } from "../lib/states.mjs";
import { runHeartbeatSweep } from "../lib/heartbeat.mjs";
import { runInline, getRun as getAutomationRun } from "../lib/automations-client.mjs";
import {
  newDrillRun, saveDrillRun, getDrillRun, listDrillRuns, deleteDrillRun,
  addFeedback, setOverride, addObservation, addFinding, setFindingStatus, confirmedFindings,
  undispatchedConfirmedFindings, markFindingsDispatched, isInfraError, runListingRow
} from "../lib/runs-store.mjs";

// Authoring tabs (B1): one live tab per (pageId, viewportId) for the duration
// of the server process - reused across pick/resolve calls in an authoring
// session rather than reopened per request.
const authoringTabs = new Map(); // "<pageId>|<viewportId>" -> tabId

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

// Merge each (page, step, viewport) entry's own automation-run result (tier,
// evidence, pass/fail) onto the Drill run record for display - the record
// itself only stores the reference (A8: runs stay engine-owned; the Book
// links to them, never duplicates them).
async function assembleRunView(record) {
  const pages = [];
  for (const pr of record.pages) {
    let result = null;
    if (pr.automationRunId) {
      const automationRun = await getAutomationRun(pr.automationRunId).catch(() => null);
      result = resolveStepOutcome(automationRun, pr.stepId);
    }
    // Harness failures render apart from real step verdicts - computed here
    // (not stored) so runs recorded before the classifier existed group
    // correctly too.
    pages.push({ ...pr, result, infra: isInfraError(pr.error || result?.error) });
  }
  return { ...record, pages };
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

// One batch card carrying the findings report (R10) - a normal `code` duty
// fix card (findings need real code changes + the usual review/test gates),
// distinct from the R14 testing-only card schema (Phase 7), which instead
// enters the roster directly at drill.
async function dispatchBatchFixCard(record, confirmed) {
  const base = await kanbanBaseUrl();
  if (!base) throw new Error("kanban-loop fitting not running (no status file)");
  const lines = confirmed.map((f) => `- [${f.kind}] ${f.pageId}${f.stepId ? "#" + f.stepId : ""}: ${f.text}`);
  const description = `Drill batch fix (report ${record.id}):\n${lines.join("\n")}`;
  // A human-scannable title: which pages, how many findings, dispatched when.
  // Identical "Drill batch fix (report 01KX...)" titles made the board
  // unreadable - the ulid identifies nothing at a glance.
  const pages = [...new Set(confirmed.map((f) => f.pageId))];
  const when = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const title = `Drill fix: ${pages.join(", ")} - ${confirmed.length} finding${confirmed.length === 1 ? "" : "s"} (${when})`;
  const res = await fetch(`${base}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The run RECORD's project, not the live selection - a heartbeat sweep or
    // a stale Results view can dispatch after the user retargeted Drill, and
    // the fix card must point at the repo the findings came from.
    body: JSON.stringify({ title, description, duty: "code", level: 2, sequence: ["code"], origin: "drill", project: record.project || drillTargetRoot() })
  });
  if (!res.ok) throw new Error(`kanban-loop ${res.status}: ${await res.text()}`);
  const card = (await res.json()).card;
  // Enter the card at its first phase so the loop actually RUNS it - a card
  // parked invisibly in backlog reads as "my fixes went nowhere" (observed
  // live 2026-07-18). The engine header marks this as an engine move; a
  // failure leaves the card in backlog rather than failing the dispatch.
  let entered = false;
  try {
    const first = Array.isArray(card.sequence) && card.sequence.length > 0 ? card.sequence[0] : "code";
    const moveRes = await fetch(`${base}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "drill-dispatch" },
      body: JSON.stringify({ list: first, rev: card.rev })
    });
    entered = moveRes.ok;
  } catch {
    /* card stays in backlog; the board's Start button remains the fallback */
  }
  // Attach the board's card URL so the UI (and the finding's `card` stamp)
  // can link straight to it - "did my fixes reach the kanban?" should never
  // require opening the board and hunting.
  return { ...card, url: `${base}/#/cards/${card.id}`, entered };
}

// A long-lived client flow (an app start, a plan, a gated-run approval) pins
// the root it started against and passes it back explicitly - the live
// selection can change under a minutes-long wait, and the poll/resume must
// keep following the operation it began, never the newly selected repo.
function pinnedRoot(explicit) {
  return explicit ? canonicalRoot(String(explicit)) : drillTargetRoot();
}

const FITTING_ID = "drill";
const DEFAULT_PORT = 7096;
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
      return send(res, 200, { book: await getDrillBook() });
    }
    if (pathname === "/api/drillbook" && req.method === "PATCH") {
      const body = await readJsonBody(req);
      return send(res, 200, { book: await saveDrillBook(body) });
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
      return send(res, 200, {
        root,
        pages: (await listPages(root)).length,
        selected: !!(activeProjectRoot() || process.env.GARRISON_DRILL_TARGET_REPO),
        job: publicPlanJob(getPlanJob(root))
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

    if (pathname === "/api/pages" && req.method === "GET") {
      return send(res, 200, { pages: await listPages() });
    }
    const pageMatch = pathname.match(/^\/api\/pages\/([^/]+)$/);
    if (pageMatch) {
      const id = decodeURIComponent(pageMatch[1]);
      if (req.method === "GET") {
        const page = await getPage(id);
        return page ? send(res, 200, { page }) : send(res, 404, { error: "not found" });
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const body = await readJsonBody(req);
        return send(res, 200, { page: await savePage(id, body) });
      }
      if (req.method === "DELETE") {
        return send(res, 200, { deleted: await deletePage(id) });
      }
    }

    // Authoring: open/reuse a tab for a page at a given viewport (B1/S19).
    if (pathname === "/api/authoring/tab" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pageId = String(body.pageId ?? "");
      const viewportId = String(body.viewport ?? "desktop");
      if (!pageId) return send(res, 400, { error: "pageId required" });
      let viewport;
      try { viewport = resolveViewport(viewportId); } catch (err) { return send(res, 400, { error: err.message }); }
      const book = await getDrillBook();
      const page = await getPage(pageId);
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
      const key = `${pageId}|${viewportId}`;
      let tabId = authoringTabs.get(key);
      if (!tabId) {
        try {
          tabId = await openTab(target, { viewport });
        } catch (err) {
          return send(res, 502, { error: err.message });
        }
        authoringTabs.set(key, tabId);
      }
      return send(res, 200, { tabId, canvasUrl: canvasUrl(tabId), viewport, url: target });
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
      let viewport;
      try { viewport = resolveViewport(viewportId); } catch (err) { return send(res, 400, { error: err.message }); }
      const book = await getDrillBook();
      const page = await getPage(pageId);
      const appUrl = book.app.url || "http://localhost:3000";
      let target;
      try { target = page?.path ? new URL(page.path, appUrl).toString() : appUrl; } catch { target = appUrl; }
      const key = `${pageId}|${viewportId}`;
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
      return send(res, 200, { tabId, canvasUrl: canvasUrl(tabId), viewport, url: target });
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
      const key = `${pageId}|${viewportId}`;
      let tabId = authoringTabs.get(key);
      if (!tabId) {
        const book = await getDrillBook();
        const page = await getPage(pageId);
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
    const stateShotMatch = pathname.match(/^\/api\/states\/([^/]+)\/([^/]+)\/screenshot$/);
    if (stateShotMatch && req.method === "GET") {
      const pageId = decodeURIComponent(stateShotMatch[1]);
      const stateId = decodeURIComponent(stateShotMatch[2]);
      const page = await getPage(pageId);
      const state = page?.states?.find((s) => s.id === stateId);
      if (!state?.screenshotPath) return send(res, 404, { error: "no screenshot for this state" });
      try {
        const bytes = await readFile(state.screenshotPath);
        res.writeHead(200, { "content-type": "image/jpeg" });
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
      const root = pinnedRoot(body.project);
      // A plan agent may be rewriting this repo's drills/ tree right now -
      // compiling half-written YAML produces a run over a phantom book.
      const planJob = getPlanJob(root);
      if (planJob && planJob.status === "planning") {
        return send(res, 409, { error: "a plan is authoring this project's Drill Book right now - wait for it to finish, then run" });
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

      const record = newDrillRun({ contextTag, state, dispatch: blind ? "manual" : (body.dispatch || book.dispatch || "manual"), project: root });
      for (const pageId of pageIds) {
        const page = await getPage(pageId, root);
        if (!page) continue;
        for (const viewportId of viewportIds) {
          const steps = selectSteps(page, { state, viewport: viewportId });
          for (const step of steps) {
            const automation = compileStepAutomation(book, page, step, { blind });
            try {
              const vp = resolveViewport(viewportId);
              const { run } = await runInline({ automation, contextTag, bypassCache, viewport: vp, sync: true });
              record.pages.push({ pageId, stepId: step.id, viewportId, automationRunId: run.id, status: run.status });
            } catch (err) {
              record.pages.push({ pageId, stepId: step.id, viewportId, automationRunId: null, status: "error", error: err.message });
            }
          }
        }
      }
      record.endedAt = new Date().toISOString();

      // Failed steps pool as findings ONLY when the failure is about the app.
      // Infra errors (vision route / gateway / browser fitting down) are
      // counted in the run summary instead - a harness outage must never
      // read as thirty app bugs.
      const summary = { steps: record.pages.length, failed: 0, infra: 0 };
      for (const pr of record.pages) {
        if (pr.status === "error") {
          if (isInfraError(pr.error)) { summary.infra += 1; continue; }
          summary.failed += 1;
          addFinding(record, { kind: "step-fail", pageId: pr.pageId, stepId: pr.stepId, text: pr.error });
          continue;
        }
        if (!pr.automationRunId) continue;
        const automationRun = await getAutomationRun(pr.automationRunId).catch(() => null);
        const outcome = resolveStepOutcome(automationRun, pr.stepId);
        if (outcome && (outcome.status === "failed" || outcome.result?.passed === false)) {
          const text = outcome.error || outcome.result?.reasoning || `${pr.stepId} failed`;
          if (isInfraError(text)) { summary.infra += 1; continue; }
          summary.failed += 1;
          addFinding(record, { kind: "step-fail", pageId: pr.pageId, stepId: pr.stepId, text });
          continue;
        }
        // Graduation (B8/B12, and the B7 healer path re-emitting on a stale
        // graduated assertion): a vision/recovered pass that resolved a
        // deterministic assertion (or is author-marked judgment) flips the
        // step to e2e and (re-)writes the page's committed spec. Never during
        // a blind adversarial pass (R12) - it must not silently rewrite the
        // plan it was supposed to be independently checking.
        if (blind) continue;
        const page = await getPage(pr.pageId, root);
        const step = page?.steps.find((s) => s.id === pr.stepId);
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

      record.summary = summary;
      await saveDrillRun(record);
      return send(res, 200, { run: await assembleRunView(record) });
    }
    if (pathname === "/api/runs" && req.method === "GET") {
      // Scoped to the selected project by default; pre-project records (no
      // `project` field) always show. ?all=1 lifts the scope.
      const all = url.searchParams.get("all") === "1";
      const active = drillTargetRoot();
      const runs = await listDrillRuns();
      const scoped = all ? runs : runs.filter((r) => !r.project || r.project === active);
      return send(res, 200, { runs: scoped.map(runListingRow) });
    }
    const runGet = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runGet && req.method === "GET") {
      const record = await getDrillRun(decodeURIComponent(runGet[1]));
      return record ? send(res, 200, { run: await assembleRunView(record) }) : send(res, 404, { error: "not found" });
    }
    if (runGet && req.method === "DELETE") {
      return send(res, 200, { deleted: await deleteDrillRun(decodeURIComponent(runGet[1])) });
    }

    const feedbackMatch = pathname.match(/^\/api\/runs\/([^/]+)\/feedback$/);
    if (feedbackMatch && req.method === "POST") {
      const record = await getDrillRun(decodeURIComponent(feedbackMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      addFeedback(record, body.pageId, body.stepId, body.note);
      await saveDrillRun(record);
      return send(res, 200, { run: await assembleRunView(record) });
    }

    // D5: a verdict override in either direction. Flipping TO failed pools a
    // finding - "a pass you know is wrong becomes a failed finding."
    const overrideMatch = pathname.match(/^\/api\/runs\/([^/]+)\/override$/);
    if (overrideMatch && req.method === "POST") {
      const record = await getDrillRun(decodeURIComponent(overrideMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      setOverride(record, body.pageId, body.stepId, body.verdict, body.note);
      if (body.verdict === "failed") {
        addFinding(record, { kind: "verdict-flip", pageId: body.pageId, stepId: body.stepId, text: body.note || `${body.stepId} flagged failed by override` });
      }
      await saveDrillRun(record);
      return send(res, 200, { run: await assembleRunView(record) });
    }

    // D9: a run-level observation - recording it never requires a re-run.
    const obsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/observation$/);
    if (obsMatch && req.method === "POST") {
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
      const record = await getDrillRun(decodeURIComponent(obsFindingMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const observation = record.observations.find((o) => o.id === decodeURIComponent(obsFindingMatch[2]));
      if (!observation) return send(res, 404, { error: "observation not found" });
      const body = await readJsonBody(req);
      const finding = addFinding(record, { kind: "observation", pageId: body.pageId, text: observation.text });
      observation.convertedToFinding = finding.id;
      await saveDrillRun(record);
      return send(res, 200, { finding, run: await assembleRunView(record) });
    }

    // D10: triage a finding (proposed -> confirmed | dismissed).
    const findingMatch = pathname.match(/^\/api\/runs\/([^/]+)\/findings\/([^/]+)$/);
    if (findingMatch && req.method === "PATCH") {
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
      const record = await getDrillRun(decodeURIComponent(dispatchMatch[1]));
      if (!record) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      const mode = body.mode || "manual";
      const confirmed = undispatchedConfirmedFindings(record);
      if (confirmed.length === 0) {
        return send(res, 400, {
          error: confirmedFindings(record).length > 0
            ? "every confirmed finding is already on a fix card - nothing new to dispatch"
            : "no confirmed findings to dispatch"
        });
      }
      if (mode === "heartbeat") {
        return send(res, 200, { dispatched: false, mode: "heartbeat", pending: confirmed.length });
      }
      try {
        const card = await dispatchBatchFixCard(record, confirmed);
        // Re-load before stamping (same as the heartbeat sweep): the kanban
        // POST is a long await, and a concurrent triage/feedback write on
        // this run must not be clobbered by saving the pre-fetch snapshot.
        const fresh = (await getDrillRun(record.id)) ?? record;
        markFindingsDispatched(fresh, confirmed.map((f) => f.id), card);
        fresh.dispatchedAt = new Date().toISOString();
        await saveDrillRun(fresh);
        return send(res, 200, { dispatched: true, mode, card, run: await assembleRunView(fresh) });
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
  const host = process.env.DRILL_UI_HOST || "127.0.0.1";
  const port = Number(process.env.DRILL_UI_PORT || DEFAULT_PORT);
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
