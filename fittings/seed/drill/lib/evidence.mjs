// Drill Evidence Capture (v0.1): run-level video + per-step traces and
// screenshots, indexed per run. Storage follows R13 (machine-local plain
// files with links, no artifact store) with the D4 layout
// `evidence/<drillId>/<runId>/` under the drill home, where drillId is the
// same project key convention snapshots use. All paths RECORDED anywhere
// (steps.json, evidence.json, findings) are relative to the run's evidence
// dir; bytes are only ever served through confined HTTP routes.
//
// EVERY helper here is warn-never-throw: failing to capture or index
// evidence must never fail the drill run itself (hard constraint). Callers
// get `null` back on failure and the warning lands on the server log.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { drillHomeDir } from "./snapshots.mjs";
import { browserBaseUrl } from "./browser-fitting-client.mjs";

export function evidenceProjectKey(root) {
  return crypto.createHash("sha256").update(String(root)).digest("hex").slice(0, 12);
}

export function evidenceRunDir(runId, root) {
  return path.join(drillHomeDir(), "evidence", evidenceProjectKey(root), String(runId));
}

// Qualified per-check evidence name: bare stepIds repeat across pages and
// viewports (page-shell-renders exists on every page), so files are keyed by
// the full (page, step, viewport) coordinate.
export function checkKey({ pageId, stepId, viewportId }) {
  const clean = (part) => String(part ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${clean(pageId)}--${clean(stepId)}--${clean(viewportId)}`;
}

function warn(message) {
  console.warn(`[drill] evidence: ${message}`);
}

export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

// Generic browser capture call — the live-replay flow (S6) drives sessions
// that are not run-scoped, so it needs the raw call rather than the
// run-shaped helpers below.
export async function captureCall(pathname, body, { fetchImpl = globalThis.fetch } = {}) {
  return captureFetch(fetchImpl, pathname, body);
}

async function captureFetch(fetchImpl, pathname, body) {
  const base = browserBaseUrl();
  if (!base) throw new Error("browser fitting not running (no GARRISON_BROWSER_URL / status file)");
  const res = await fetchImpl(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `browser ${res.status}`);
  }
  return payload;
}

// Spotter request (Evidence V2, D1/D2): trigger-driven frame capture is ON
// for every run by default — the capture path is deterministic and cheap;
// curation bounds what's SHOWN, never what was kept. `false` (Book or body)
// disables it; objects merge Book config under body overrides. Defaults and
// clamping live browser-side (spotter.mjs SPOTTER_DEFAULTS).
export function spotterRequest(book, evidenceBody) {
  const bookCfg = book?.spotter;
  const bodyCfg = evidenceBody?.spotter;
  if (bookCfg === false || bodyCfg === false) return null;
  return {
    ...(bookCfg && typeof bookCfg === "object" ? bookCfg : {}),
    ...(bodyCfg && typeof bodyCfg === "object" ? bodyCfg : {})
  };
}

// Begin a capture session for a run. Returns
// { sessionId, dir, startedAt, video, spotter, warnings } or null (degraded —
// the run proceeds exactly as before evidence capture existed).
export async function captureStart({ runId, root, video, viewport, spotter, fetchImpl = globalThis.fetch }) {
  try {
    const dir = evidenceRunDir(runId, root);
    const payload = await captureFetch(fetchImpl, "/capture/start", {
      sessionId: `drill-${runId}`,
      dir,
      video: video === true,
      viewport: viewport && viewport.width ? { width: viewport.width, height: viewport.height } : undefined,
      spotter: spotter && typeof spotter === "object" ? spotter : undefined
    });
    for (const w of payload.warnings ?? []) warn(`capture start: ${w}`);
    return {
      sessionId: payload.sessionId,
      dir,
      startedAt: payload.startedAt,
      video: payload.video === true,
      spotter: payload.spotter === true
    };
  } catch (err) {
    warn(`capture start failed (run continues without video/session): ${err.message}`);
    return null;
  }
}

// Bracket one check with a trace chunk (D2). Start is fire-and-log; stop
// returns the relative trace filename or null.
export async function captureChunkStart(session, title, { key, fetchImpl = globalThis.fetch } = {}) {
  if (!session) return false;
  try {
    // `name` (the check key) lets Spotter tag frames with the same coordinate
    // the chunk-stop trace file will carry.
    await captureFetch(fetchImpl, "/capture/chunk-start", { sessionId: session.sessionId, title, name: key });
    return true;
  } catch (err) {
    warn(`trace chunk start failed: ${err.message}`);
    return false;
  }
}

export async function captureChunkStop(session, key, { fetchImpl = globalThis.fetch } = {}) {
  if (!session) return null;
  try {
    const payload = await captureFetch(fetchImpl, "/capture/chunk-stop", { sessionId: session.sessionId, name: key });
    return payload.trace ?? null;
  } catch (err) {
    warn(`trace chunk stop failed: ${err.message}`);
    return null;
  }
}

// Full-page step screenshots (D3): the only evidence kind eligible as model
// input downstream. Returns the relative png name or null.
export async function captureScreenshot(session, name, { fullPage = true, fetchImpl = globalThis.fetch } = {}) {
  if (!session) return null;
  try {
    const payload = await captureFetch(fetchImpl, "/capture/screenshot", { sessionId: session.sessionId, name, fullPage });
    return payload.screenshot ?? null;
  } catch (err) {
    warn(`screenshot failed: ${err.message}`);
    return null;
  }
}

// Finalize the session. Returns { video, spotter, startedAt, endedAt,
// warnings } or null.
export async function captureStop(session, { fetchImpl = globalThis.fetch } = {}) {
  if (!session) return null;
  try {
    const payload = await captureFetch(fetchImpl, "/capture/stop", { sessionId: session.sessionId });
    for (const w of payload.warnings ?? []) warn(`capture stop: ${w}`);
    return {
      video: payload.video ?? null,
      spotter: payload.spotter ?? null,
      startedAt: payload.startedAt,
      endedAt: payload.endedAt
    };
  } catch (err) {
    warn(`capture stop failed: ${err.message}`);
    return null;
  }
}

// steps.json (D1): the per-check offset manifest consumers use to deep-link
// into the run video. Rows: { pageId, stepId, viewportId, automationRunId,
// title, startMs, endMs, status }.
export async function writeStepsManifest(session, rows) {
  if (!session) return null;
  try {
    const file = path.join(session.dir, "steps.json");
    await atomicWrite(file, JSON.stringify(rows, null, 2));
    return "steps.json";
  } catch (err) {
    warn(`steps.json write failed: ${err.message}`);
    return null;
  }
}

// evidence.json (D4): one index per run, one row per item, mirroring the
// evidence-index.json slices[] row style (kind/status/bytes/sha256 fields).
// All artifact paths are RELATIVE to the run's evidence dir.
export async function writeEvidenceIndex(session, { project, runId, video, checks, spotter }) {
  if (!session) return null;
  try {
    const items = [];
    if (video) {
      const videoPath = path.join(session.dir, video);
      let bytes = null;
      let sha256 = null;
      try {
        const buf = await fs.readFile(videoPath);
        bytes = buf.length;
        sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      } catch (err) {
        warn(`video hash failed: ${err.message}`);
      }
      items.push({ item: "video", kind: "video", path: video, bytes, sha256, videoMode: "evidence" });
    }
    if (spotter && spotter.manifest) {
      // One summary row; the per-frame detail lives in spotter-frames.json
      // (always kept — only the frame JPEGs themselves are retention-eligible).
      items.push({
        item: "spotter",
        kind: "spotter",
        manifest: spotter.manifest,
        frames: spotter.frames ?? spotter.counts?.kept ?? 0,
        collapsed: spotter.counts?.collapsed ?? 0,
        dropped: spotter.counts?.dropped ?? 0
      });
    }
    for (const check of checks ?? []) {
      items.push({
        item: check.key,
        kind: "step",
        pageId: check.pageId,
        stepId: check.stepId,
        viewportId: check.viewportId,
        status: check.status,
        startMs: check.startMs,
        endMs: check.endMs,
        automationRunId: check.automationRunId,
        trace: check.trace ?? null,
        screenshot: check.screenshot ?? null,
        failureScreenshot: check.failureScreenshot ?? null
      });
    }
    const index = {
      project,
      drillId: evidenceProjectKey(project),
      runId,
      updatedAt: new Date().toISOString(),
      items
    };
    await atomicWrite(path.join(session.dir, "evidence.json"), JSON.stringify(index, null, 2));
    return "evidence.json";
  } catch (err) {
    warn(`evidence.json write failed: ${err.message}`);
    return null;
  }
}

// Book/state references store evidence RELATIVE to the drill evidence root
// (`<drillId>/<runId>/<file>`); legacy records hold absolute machine paths.
// Resolve either form to an absolute path for reads.
export function evidenceRootDir() {
  return path.join(drillHomeDir(), "evidence");
}

export function evidenceRootRef(runId, root, file) {
  return path.posix.join(evidenceProjectKey(root), String(runId), file);
}

export function resolveEvidencePath(ref) {
  if (!ref) return null;
  return path.isAbsolute(ref) ? ref : path.join(evidenceRootDir(), ref);
}

// ── Retention (D6, hardcoded v1 defaults) ─────────────────────────────────
//
// Keep EVERYTHING for runs with findings or a Needs-Attention outcome. Keep
// the last KEEP_GREEN_FULL green Full Drill runs (video-recorded) complete.
// Older green runs lose video + trace zips but keep steps.json,
// evidence.json, and every screenshot. Muster-configurable later.

export const KEEP_GREEN_FULL = 3;

// Pure classification over drill run records (newest-first not required).
// green = nothing to look at: no findings, no failed checks, no infra noise,
// no circuit. fullDrill = the run recorded a video (the D5 discriminator).
export function classifyForRetention(runs) {
  return (runs ?? []).map((run) => ({
    runId: run.id,
    startedAt: run.startedAt,
    green:
      (run.findings ?? []).length === 0 &&
      (run.summary?.failed ?? 0) === 0 &&
      (run.summary?.infra ?? 0) === 0 &&
      !run.circuit,
    fullDrill: !!run.evidence?.video
  }));
}

async function pruneRunDir(dir) {
  const removed = [];
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    // Raw Spotter frames follow the same retention as video + traces (V2
    // hard constraint); manifests/annotations/feedback are never pruned.
    if (
      name === "video.webm" ||
      (name.startsWith("trace-") && name.endsWith(".zip")) ||
      (name.startsWith("frame-") && name.endsWith(".jpg"))
    ) {
      try {
        await fs.unlink(path.join(dir, name));
        removed.push(name);
      } catch (err) {
        warn(`prune ${name} failed: ${err.message}`);
      }
    }
  }
  if (removed.length) {
    // Keep the index honest: rows survive, but pruned artifacts are flagged
    // so consumers 404 knowingly instead of trusting a dangling name.
    try {
      const indexPath = path.join(dir, "evidence.json");
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      index.prunedAt = new Date().toISOString();
      const prunedFrames = removed.filter((n) => n.startsWith("frame-")).length;
      for (const item of index.items ?? []) {
        if (item.kind === "video" && removed.includes(item.path)) item.pruned = true;
        if (item.kind === "step" && item.trace && removed.includes(item.trace)) item.pruned = true;
        if (item.kind === "spotter" && prunedFrames) {
          item.pruned = true;
          item.prunedFrames = prunedFrames;
        }
      }
      await atomicWrite(indexPath, JSON.stringify(index, null, 2));
    } catch (err) {
      warn(`prune index stamp failed: ${err.message}`);
    }
  }
  return removed;
}

// Apply D6 to one project's evidence tree. `classified` comes from
// classifyForRetention over the project's run records; runs without an
// evidence dir are skipped. Returns {runId, removed[]} for what was pruned.
// Warn-never-throw like everything else here.
export async function pruneEvidence({ root, classified }) {
  const pruned = [];
  try {
    const byNewest = [...(classified ?? [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const keptFull = byNewest.filter((c) => c.green && c.fullDrill).slice(0, KEEP_GREEN_FULL);
    // Not enough green Full Drill history yet — prune nothing, so a young or
    // authoring-only project keeps every trace.
    if (keptFull.length < KEEP_GREEN_FULL) return pruned;
    const keptIds = new Set(keptFull.map((c) => c.runId));
    const threshold = String(keptFull[keptFull.length - 1].startedAt);
    for (const c of byNewest) {
      if (!c.green || keptIds.has(c.runId)) continue;
      // Green runs newer than the kept window stay complete (recent
      // authoring iterations keep their traces); only OLDER green runs lose
      // video + trace zips.
      if (String(c.startedAt) >= threshold) continue;
      const removed = await pruneRunDir(evidenceRunDir(c.runId, root));
      if (removed.length) pruned.push({ runId: c.runId, removed });
    }
  } catch (err) {
    warn(`retention prune failed: ${err.message}`);
  }
  return pruned;
}

// A deleted run's evidence goes with it (not a D6 rule — just the honest
// companion to DELETE /api/runs/:id).
export async function removeRunEvidence(runId, root) {
  try {
    await fs.rm(evidenceRunDir(runId, root), { recursive: true, force: true });
  } catch (err) {
    warn(`evidence removal failed: ${err.message}`);
  }
}

// Per-check offsets relative to the capture start. Engine run timestamps are
// authoritative when present (same machine, same clock); the drill-side
// wallclock pair is the fallback for transport-failed checks.
export function manifestRow({ job, automationRun, status, session, fallbackStartMs, fallbackEndMs }) {
  const toMs = (iso) => {
    const t = Date.parse(iso ?? "");
    return Number.isFinite(t) ? Math.max(0, t - session.startedAt) : null;
  };
  return {
    pageId: job.pageId,
    stepId: job.step.id,
    viewportId: job.viewportId,
    automationRunId: automationRun?.id ?? null,
    title: job.step.description || job.step.id,
    startMs: toMs(automationRun?.startedAt) ?? Math.max(0, Math.round(fallbackStartMs)),
    endMs: toMs(automationRun?.endedAt) ?? Math.max(0, Math.round(fallbackEndMs)),
    status
  };
}
