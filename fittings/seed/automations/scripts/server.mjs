// Automations own-port server. Serves the automation CRUD REST API + /health,
// registers its status file under ~/.garrison/ui-fittings/, and serves the
// run-viewer UI from dist/. The run engine + SSE stream (E2/E3) extend this.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, unlink, readFile, readdir } from "node:fs/promises";
import { listAutomations, getAutomation, saveAutomation, deleteAutomation, listRuns, getRun, automationsDir } from "../lib/store.mjs";
import { runAutomation } from "../lib/engine.mjs";
import { planFromBrief } from "../lib/planner.mjs";
import { buildAutomationDiscussUrl, buildDiscussParams } from "../lib/discuss.mjs";
import { ulid } from "../lib/ulid.mjs";
import { readFile as readFileAsync } from "node:fs/promises";

// Discover the connector catalog (service + actions) from the backend library so
// the planner knows what connector actions are available. Best-effort: an empty
// catalog still lets the planner use api_call/local_command/browser steps.
async function discoverCatalog() {
  try {
    const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777";
    const res = await fetch(`${base}/api/library`);
    if (!res.ok) return [];
    const data = await res.json();
    const entries = data.fittings ?? data.library ?? data.entries ?? data;
    const list = Array.isArray(entries) ? entries : [];
    return list
      .filter((e) => e?.metadata?.connector && (e.metadata.provides ?? []).some((p) => p.kind === "connector"))
      .map((e) => ({
        service: (e.metadata.provides.find((p) => p.kind === "connector") || {}).name,
        auth: e.metadata.connector.auth,
        actions: e.metadata.connector.actions ?? []
      }));
  } catch {
    return [];
  }
}

// In-memory run event bus: runId -> { events:[], listeners:Set, done }. Lets the
// run viewer subscribe over SSE and replay any events it missed (the engine
// already emits redacted events — no secret reaches the stream).
const runBus = new Map();

// Pending human-in-the-loop resumes: runId -> resolver. When the engine pauses it
// awaits a promise registered here; POST /api/runs/:id/resume resolves it.
const pendingResumes = new Map();

function waitForResumeFor(runId) {
  return (pauseInfo) =>
    new Promise((resolve) => {
      // Store the per-pause nonce so /resume must present the matching one.
      pendingResumes.set(runId, { resolve, nonce: pauseInfo.nonce });
    });
}

const MAX_RETAINED_RUNS = 50;

function busFor(runId) {
  let b = runBus.get(runId);
  if (!b) {
    b = { events: [], listeners: new Set(), done: false };
    runBus.set(runId, b);
    // Prune oldest finished runs (with no live listeners) so the bus doesn't
    // grow unbounded; the persisted run record remains on disk regardless.
    if (runBus.size > MAX_RETAINED_RUNS) {
      for (const [rid, rb] of runBus) {
        if (runBus.size <= MAX_RETAINED_RUNS) break;
        if (rb.done && rb.listeners.size === 0 && rid !== runId) runBus.delete(rid);
      }
    }
  }
  return b;
}

function publishEvent(runId, event) {
  const b = busFor(runId);
  b.events.push(event);
  // Only completion/error end the stream. Pauses (awaiting_connector/consent/
  // pause_for_user) keep it open — the run continues after the user resumes.
  if (event.type === "run_complete" || event.type === "run_error") {
    b.done = true;
  }
  for (const l of b.listeners) {
    try { l(event); } catch { /* listener detached */ }
  }
  // Cap retained events so a long run doesn't grow unbounded in memory.
  if (b.events.length > 5000) b.events.splice(0, b.events.length - 5000);
}

const FITTING_ID = "automations";
const DEFAULT_PORT = 7090;
const GARRISON_DIR = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
const STATUS_ROOT = path.join(GARRISON_DIR, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

// Resolve the running web-channel fitting id (the channel id is NOT hardcoded —
// `web-channel-default` is just the seed name). Scan the ui-fittings status dir
// for the first fitting whose id starts with `web-channel`. Mirrors kanban-loop's
// readWebChannelStatus so Discuss links the composition's actual channel.
async function readWebChannelStatus(statusDir = STATUS_ROOT) {
  try {
    const names = await readdir(statusDir);
    const preferred = "web-channel-default.json";
    const sorted = names
      .filter((n) => n.endsWith(".json") && n.startsWith("web-channel"))
      .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)));
    for (const name of sorted) {
      try {
        const parsed = JSON.parse(await readFile(path.join(statusDir, name), "utf8"));
        const fittingId = typeof parsed?.fittingId === "string" ? parsed.fittingId : null;
        if (fittingId && fittingId.startsWith("web-channel")) {
          return { id: fittingId, url: typeof parsed?.url === "string" ? parsed.url : null };
        }
      } catch { /* skip one bad file */ }
    }
  } catch { /* no status dir */ }
  return { id: null, url: null };
}

function send(res, code, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  // No wildcard CORS — the same-origin guard in handle() is the access control;
  // cross-origin reads (e.g. the SSE nonce) must NOT be allowed.
  res.writeHead(code, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  // CSRF defense: this localhost service runs automations + approves commands
  // (consent resume), so only the viewer (SAME origin) may call it. Strict
  // same-origin check — host:port must match this server's Host — so another
  // local app (localhost:other-port) can't drive it. Server-to-server callers
  // send no Origin and pass.
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin) return send(res, 403, { error: "cross-origin forbidden" });
  }
  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    if (pathname === "/health" || pathname === "/api/health") {
      return send(res, 200, { status: "ok", fittingId: FITTING_ID, pid: process.pid });
    }
    if (pathname === "/api/automations" && req.method === "GET") {
      return send(res, 200, { automations: await listAutomations() });
    }
    if (pathname === "/api/automations" && req.method === "POST") {
      const body = await readJsonBody(req);
      return send(res, 200, { automation: await saveAutomation(body) });
    }
    // Run an automation. Default: start async + return {runId}; the viewer
    // subscribes to /api/runs/:id/stream. `?sync=1` runs to completion and
    // returns the record (used by tests/CLI).
    const runMatch = pathname.match(/^\/api\/automations\/([^/]+)\/run$/);
    if (runMatch && req.method === "POST") {
      const id = decodeURIComponent(runMatch[1]);
      const auto = await getAutomation(id);
      if (!auto) return send(res, 404, { error: "not found" });
      const body = await readJsonBody(req);
      const runId = ulid();
      const runPromise = runAutomation({
        automation: auto,
        inputs: body.inputs ?? {},
        triggeredBy: body.triggeredBy ?? "user",
        runId,
        emit: (ev) => publishEvent(runId, ev),
        deps: { runSubAutomation: makeSubRunner(), waitForResume: waitForResumeFor(runId) }
      }).finally(() => pendingResumes.delete(runId));
      if (url.searchParams.get("sync") === "1") {
        return send(res, 200, { run: await runPromise });
      }
      runPromise.catch((err) => publishEvent(runId, { type: "run_error", runId, error: err.message }));
      return send(res, 202, { runId });
    }
    // Live SSE stream of a run's events (replays buffered events first).
    const streamMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      const runId = decodeURIComponent(streamMatch[1]);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const b = busFor(runId);
      const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      for (const ev of b.events) write(ev);
      if (b.done) { res.end(); return; }
      const listener = (ev) => {
        write(ev);
        if (ev.type === "run_complete" || ev.type === "run_error") {
          b.listeners.delete(listener);
          res.end();
        }
      };
      b.listeners.add(listener);
      req.on("close", () => b.listeners.delete(listener));
      return;
    }
    // The "Discuss an automation" target (chat-to-build authoring). Returns the
    // running web-channel fitting id + the query params; the embedded UI posts
    // these to Garrison's top window so it navigates to /embed/<channel> (a
    // relative/own-port URL would resolve against THIS server, not Garrison). The
    // absolute `url` is a standalone fallback. 409 when no web channel runs.
    if (pathname === "/api/automations/discuss-url" && req.method === "GET") {
      const name = url.searchParams.get("name") || undefined;
      const channel = await readWebChannelStatus();
      if (!channel.id) {
        return send(res, 409, { error: "no web channel installed/running — add a web-channel fitting" });
      }
      const params = buildDiscussParams({ name });
      const qs = new URLSearchParams(params).toString();
      const base = (process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
      return send(res, 200, { fittingId: channel.id, params, url: `${base}/embed/${channel.id}?${qs}` });
    }
    // Plan an automation from a Discuss brief, routed through the Model Router.
    if (pathname === "/api/automations/plan-from-brief" && req.method === "POST") {
      const body = await readJsonBody(req);
      let brief = body.brief;
      if (!brief && body.briefSlug) {
        const safe = String(body.briefSlug).replace(/[^A-Za-z0-9_-]/g, "");
        try {
          brief = await readFileAsync(path.join(automationsDir(), "briefs", `${safe}.md`), "utf8");
        } catch {
          return send(res, 404, { error: `brief not found: ${safe}` });
        }
      }
      if (!brief) return send(res, 400, { error: "brief or briefSlug required" });
      const catalog = await discoverCatalog();
      const automation = await planFromBrief({ brief, catalog, automationName: body.name });
      const saved = await saveAutomation(automation);
      return send(res, 200, { automation: saved });
    }
    // Resume a paused run (pause_for_user / awaiting_connector / awaiting_consent).
    // body: { decision?: "once"|"always" } (consent), or {} (just continue).
    const resumeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/resume$/);
    if (resumeMatch && req.method === "POST") {
      const runId = decodeURIComponent(resumeMatch[1]);
      const pending = pendingResumes.get(runId);
      if (!pending) return send(res, 404, { error: "no paused run with that id" });
      const body = await readJsonBody(req);
      // The nonce must match THIS pause (anti stale/duplicate-resume).
      if (pending.nonce && body.nonce !== pending.nonce) {
        return send(res, 409, { error: "stale or invalid resume nonce" });
      }
      pendingResumes.delete(runId);
      pending.resolve({ resumed: true, decision: body.decision });
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/runs" && req.method === "GET") {
      return send(res, 200, { runs: await listRuns(url.searchParams.get("automationId") || undefined) });
    }
    const runGet = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runGet && req.method === "GET") {
      const rec = await getRun(decodeURIComponent(runGet[1]));
      return rec ? send(res, 200, { run: rec }) : send(res, 404, { error: "not found" });
    }

    const m = pathname.match(/^\/api\/automations\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === "GET") {
        const auto = await getAutomation(id);
        return auto ? send(res, 200, { automation: auto }) : send(res, 404, { error: "not found" });
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        return send(res, 200, { automation: await saveAutomation({ ...body, id }) });
      }
      if (req.method === "DELETE") {
        return send(res, 200, { deleted: await deleteAutomation(id) });
      }
    }
    // Static UI (run viewer) — serve assets, with an index.html SPA fallback for
    // any unknown non-asset path so client routes work. Confine reads to DIST so
    // a crafted path (../) cannot escape and read arbitrary files.
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
        // SPA fallback: serve index.html for unknown routes; only error if the UI
        // bundle itself is genuinely missing (so the message is never misleading).
        try {
          const index = await readFile(path.join(DIST, "index.html"), "utf8");
          return send(res, 200, index, { "content-type": "text/html; charset=utf-8" });
        } catch {
          return send(res, 500, `<!doctype html><title>Automations</title><body>Automations UI asset missing: ${DIST}/index.html not found. Reinstall the fitting (apm install).</body>`);
        }
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err.message });
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
        views: [{ id: "automations", title: "Automations", route: "/" }]
      },
      null,
      2
    )
  );
}

// A sub_automation runner: loads the referenced automation and runs it,
// guarding against cycles via the shared `visited` set.
function makeSubRunner() {
  return async function runSub({ id, inputs, visited }) {
    if (visited.has(id)) throw new Error(`sub_automation cycle detected: ${id}`);
    visited.add(id);
    const auto = await getAutomation(id);
    if (!auto) throw new Error(`sub_automation not found: ${id}`);
    const rec = await runAutomation({ automation: auto, inputs, visited, deps: { runSubAutomation: runSub } });
    if (rec.status !== "completed") throw new Error(`sub_automation ${id} did not complete (${rec.status})`);
    return { runId: rec.id, status: rec.status, steps: rec.steps.length };
  };
}

export function createServer() {
  return http.createServer((req, res) => void handle(req, res));
}

// Bind to the first free port at/after `start` (the runner injects no port, so
// the default is informational and the fitting self-selects, like kanban-loop).
async function findFreePort(start, host) {
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, host);
    });
    if (free) return port;
  }
  return start;
}

export async function startServer() {
  const host = process.env.AUTOMATIONS_UI_HOST || "127.0.0.1";
  const desired = Number(process.env.AUTOMATIONS_UI_PORT || DEFAULT_PORT);
  const port = await findFreePort(desired, host);
  const server = createServer();
  await new Promise((resolve) => server.listen(port, host, resolve));
  await writeStatusFile(port, host);
  const shutdown = async () => {
    try { await unlink(STATUS_FILE); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log(`automations server on http://${host}:${port}`);
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
