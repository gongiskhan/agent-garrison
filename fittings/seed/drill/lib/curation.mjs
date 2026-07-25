// Drill evidence curation client (Evidence V2, S2/D4): after a run, the
// Spotter candidate frames are batch-judged by the vision role through the
// garrison app's /api/drill/curation route (Model Router lane — the route
// asserts the ex-drill-curation exception; frames ride as local file paths).
// Output: one sidecar JSON per curated frame + reel.json, the per-run reel
// manifest Debrief plays. Everything here is warn-never-throw and touches
// ONLY evidence files — never the run record (a late re-save could clobber
// concurrent triage on the record).

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evidenceRunDir, atomicWrite } from "./evidence.mjs";
import { getPage } from "./store.mjs";
import {
  applyCaptureRules,
  pageIdFromChunk,
  recordCurationStability,
  runTriggerObservations,
  stampRuleDrift
} from "./spotter-book.mjs";

export const CURATION_DEFAULTS = {
  maxCurated: 30, // floor for the vision budget (D4: ~30 images for a small Full Drill)
  perChunkTarget: 2, // frames per check when the budget scales with the run
  maxCuratedCeiling: 120, // hard ceiling so a huge run can't run away with model calls
  batchSize: 12 // frames per model call
};

const SIGNAL_TRIGGERS = new Set(["console-burst", "message-growth", "phash"]);

function warn(message) {
  console.warn(`[drill] curation: ${message}`);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function curationConfig(book, evidenceBody) {
  const bookCfg = book?.spotter?.curation;
  const bodyCfg = evidenceBody?.curation;
  if (bookCfg === false || bodyCfg === false) return null;
  const merged = {
    ...(bookCfg && typeof bookCfg === "object" ? bookCfg : {}),
    ...(bodyCfg && typeof bodyCfg === "object" ? bodyCfg : {})
  };
  return {
    maxCurated: clampInt(merged.maxCurated, CURATION_DEFAULTS.maxCurated, 1, CURATION_DEFAULTS.maxCuratedCeiling),
    // Remember whether the operator pinned a budget: an unpinned budget scales
    // with the run's size (below), a pinned one is honoured verbatim.
    maxCuratedExplicit: Number.isFinite(Number(merged.maxCurated)),
    batchSize: clampInt(merged.batchSize, CURATION_DEFAULTS.batchSize, 1, 40)
  };
}

// A fixed 30-frame budget starves a big run: with 36 checks it cannot even give
// every check one frame. Scale with the number of checks actually captured,
// unless the operator pinned a budget.
export function effectiveMaxCurated(config, chunkCount) {
  if (!config) return 0;
  if (config.maxCuratedExplicit) return config.maxCurated;
  const wanted = Math.max(CURATION_DEFAULTS.maxCurated, chunkCount * CURATION_DEFAULTS.perChunkTarget);
  return Math.min(CURATION_DEFAULTS.maxCuratedCeiling, wanted);
}

function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function garrisonBaseUrl() {
  return process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777";
}

// Within one chunk, which frame is most worth a model's attention. Signal
// triggers (something HAPPENED) outrank boundary frames; among boundaries,
// step-end shows the settled state the check was actually judged on, while
// step-start fires before this check's navigation and therefore still shows
// the PREVIOUS check's page.
function framePriority(frame) {
  if (SIGNAL_TRIGGERS.has(frame.trigger)) return 0;
  if (frame.trigger === "step-end") return 1;
  return 2;
}

// Deterministic selection under the vision budget, allocated FAIRLY ACROSS
// CHECKS.
//
// The previous rule took every signal-trigger frame in time order first. On a
// real 36-check run that spent the entire 30-frame budget on the first 8
// checks (101 phash frames existed, all early), so 28 checks were never judged
// and their Debrief scope rendered "No reel frames for this scope". Fairness
// across chunks matters more than global ranking: one good frame for every
// check beats five for the first few.
//
// Round-robin: every chunk contributes its best frame, then its second-best,
// and so on until the budget runs out. Frames past the budget are marked
// uncurated in the reel — visible in show-all, never silently dropped (D1).
export function selectCurationCandidates(frames, maxCurated) {
  const byChunk = new Map();
  for (const f of frames) {
    const key = f.chunk ?? "";
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(f);
  }
  // Stable ordering: chunks in first-appearance order, frames within a chunk
  // by priority then time, so the same run always yields the same candidates.
  for (const list of byChunk.values()) {
    list.sort((a, b) => framePriority(a) - framePriority(b) || (a.tMs ?? 0) - (b.tMs ?? 0));
  }
  const chosen = new Set();
  const lists = [...byChunk.values()];
  for (let round = 0; chosen.size < maxCurated; round++) {
    let progressed = false;
    for (const list of lists) {
      if (chosen.size >= maxCurated) break;
      const f = list[round];
      if (!f) continue;
      chosen.add(f.name);
      progressed = true;
    }
    if (!progressed) break; // every chunk exhausted
  }
  return frames.filter((f) => chosen.has(f.name));
}

// The reel floor: every check must end up with at least one frame.
//
// Curation is a model judgment with a deliberately drop-biased prompt, run
// under a budget, over a flaky network. Any of those can legitimately leave a
// check with zero kept frames — but a Debrief that says "No reel frames for
// this scope" for a check that plainly has evidence reads as broken, and is
// exactly the thing that made run results unanalysable. So after the verdicts
// are in, any chunk with no keep gets its best frame promoted deterministically
// and flagged `floor: true`, so the UI can show it while being honest that
// nothing chose it.
export function applyReelFloor(rows) {
  const byChunk = new Map();
  for (const row of rows) {
    const key = row.chunk ?? "";
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(row);
  }
  let floored = 0;
  for (const list of byChunk.values()) {
    if (list.some((r) => r.keep === true)) continue;
    const best = [...list].sort(
      (a, b) => framePriority(a) - framePriority(b) || (a.tMs ?? 0) - (b.tMs ?? 0)
    )[0];
    if (!best) continue;
    best.keep = true;
    best.floor = true;
    // Always lead with WHY this frame is on screen. A frame the model actively
    // dropped can carry a dismissive note ("superseded by frame-0003"), and
    // showing that as a check's evidence with no explanation is worse than
    // showing nothing. Its original note is kept after the prefix as context.
    const auto = "Auto-selected: curation kept no frame for this check, so its most representative frame is shown.";
    best.annotation = best.annotation ? `${auto} Curation noted: ${best.annotation}` : auto;
    delete best.uncurated;
    floored += 1;
  }
  return floored;
}

export async function curateRunEvidence({ record, root, config, app, fetchImpl = globalThis.fetch }) {
  try {
    if (!config) return null;
    const dir = evidenceRunDir(record.id, root);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, "spotter-frames.json"), "utf8"));
    } catch {
      return null; // no Spotter frames for this run
    }
    const all = Array.isArray(manifest.frames) ? manifest.frames : [];
    if (all.length === 0) return null;

    // Graduated capture rules (S5/D5): frames covered by a page's active
    // rules get their deterministic verdict and skip vision. Drift (hash
    // profile shift) or a finding on the page re-engages vision for that
    // page and stamps the rules. Blind adversarial runs never apply rules
    // and never write graduation state (R12 parity with graduate.mjs).
    const blind = record.contextTag === "drill-adversarial";
    const pageIds = [...new Set((record.pages ?? []).map((p) => p.pageId))];
    const ruleVerdicts = new Map();
    const reengaged = [];
    if (!blind && pageIds.length) {
      const framesByPage = new Map();
      for (const frame of all) {
        const pageId = pageIdFromChunk(frame.chunk, pageIds);
        if (!pageId) continue;
        if (!framesByPage.has(pageId)) framesByPage.set(pageId, []);
        framesByPage.get(pageId).push(frame);
      }
      for (const [pageId, pageFrames] of framesByPage) {
        try {
          const page = await getPage(pageId, root);
          if (!page) continue;
          const res = applyCaptureRules({
            page,
            frames: pageFrames,
            runHasFindingForPage: (record.findings ?? []).some((f) => f.pageId === pageId)
          });
          if (res.reengage) {
            reengaged.push({ pageId, reason: res.reengage });
            await stampRuleDrift({ root, pageId, reason: res.reengage, runId: record.id });
          } else {
            for (const [name, v] of res.verdicts) ruleVerdicts.set(name, v);
          }
        } catch (err) {
          warn(`capture rules for ${pageId} failed: ${err.message}`);
        }
      }
    }

    const visionPool = all.filter((f) => !ruleVerdicts.has(f.name));
    const chunkCount = new Set(all.map((f) => f.chunk ?? "")).size;
    const candidates = selectCurationCandidates(visionPool, effectiveMaxCurated(config, chunkCount));
    const verdictByName = new Map(ruleVerdicts);
    let routedVia = null;
    let batches = 0;
    let failedBatches = 0;
    const token = candidates.length ? internalToken() : null;
    if (candidates.length && !token) {
      warn("no internal token available — skipping vision curation");
      candidates.length = 0;
    }
    for (let i = 0; i < candidates.length; i += config.batchSize) {
      const batch = candidates.slice(i, i + config.batchSize);
      const batchNo = Math.floor(i / config.batchSize) + 1;
      const postBatch = async () => {
        const res = await fetchImpl(`${garrisonBaseUrl()}/api/drill/curation`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-garrison-internal": token
          },
          body: JSON.stringify({
            frames: batch.map((f) => ({
              name: f.name,
              path: path.join(dir, f.name),
              trigger: f.trigger,
              chunk: f.chunk,
              tMs: f.tMs
            })),
            meta: { app, runId: record.id }
          })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `curation route ${res.status}`);
        return body;
      };
      let payload = null;
      // One retry: a dropped batch silently costs every check in it its reel
      // frames, and the usual causes (a gateway hiccup, a transient 502) clear
      // on a second attempt. Two failures is a real outage — record it.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          payload = await postBatch();
          break;
        } catch (err) {
          if (attempt === 2) {
            failedBatches += 1;
            warn(`batch ${batchNo} failed twice: ${err.message}`);
          } else {
            warn(`batch ${batchNo} attempt 1 failed (${err.message}) — retrying`);
          }
        }
      }
      if (!payload) continue;
      batches += 1;
      routedVia = payload.routedVia ?? routedVia;
      for (const v of payload.results ?? []) {
        if (v && typeof v.name === "string") verdictByName.set(v.name, v);
      }
    }
    // A reel is still written when nothing came back. The floor below gives
    // every check a frame, and writing the file is what lets the UI stop
    // claiming "Curation is still selecting the reel" forever (that message is
    // keyed on the reel row's ABSENCE, so a hard failure used to hang there
    // permanently with no error and no retry).
    if (verdictByName.size === 0) {
      warn("no curation verdicts came back — falling back to a deterministic reel");
    }

    // Sidecar JSON per curated frame (D4): frame-0001.jpg -> frame-0001.json.
    // Sidecars and reel.json are retention-exempt (only *.jpg frames prune).
    const curatedAt = new Date().toISOString();
    for (const f of all) {
      const v = verdictByName.get(f.name);
      if (!v) continue;
      const sidecar = {
        name: f.name,
        curatedAt,
        routedVia: v.ruleApplied ? "capture-rule" : routedVia,
        keep: v.keep === true,
        importance: v.importance === "high" ? "high" : "normal",
        annotation: typeof v.annotation === "string" ? v.annotation : "",
        highlight: v.highlight && typeof v.highlight === "object" ? v.highlight : null,
        ...(v.ruleApplied ? { ruleApplied: true } : {})
      };
      await atomicWrite(
        path.join(dir, f.name.replace(/\.[a-z]+$/, ".json")),
        JSON.stringify(sidecar, null, 2)
      );
    }

    const rows = all.map((f) => {
      const base = { name: f.name, tMs: f.tMs, trigger: f.trigger, chunk: f.chunk };
      const v = verdictByName.get(f.name);
      if (!v) return { ...base, uncurated: true };
      return {
        ...base,
        keep: v.keep === true,
        importance: v.importance === "high" ? "high" : "normal",
        annotation: typeof v.annotation === "string" ? v.annotation : "",
        highlight: v.highlight && typeof v.highlight === "object" ? v.highlight : null,
        ...(v.ruleApplied ? { ruleApplied: true } : {})
      };
    });
    // Guarantee every check a frame before the counts are taken.
    const floored = applyReelFloor(rows);
    const reel = {
      version: 1,
      runId: record.id,
      curatedAt,
      // Rules-only runs never touched a model — say so instead of null.
      routedVia: routedVia ?? (ruleVerdicts.size ? "capture-rules" : null),
      batches,
      failedBatches,
      reengaged,
      // Surfaced so the Debrief can say WHY a reel looks thin instead of
      // rendering an empty pane that reads as a bug.
      health: {
        degraded: failedBatches > 0 || verdictByName.size === 0,
        floored,
        chunks: new Set(rows.map((r) => r.chunk ?? "")).size
      },
      counts: {
        frames: all.length,
        candidates: candidates.length,
        curated: verdictByName.size,
        ruleApplied: rows.filter((r) => r.ruleApplied === true).length,
        reel: rows.filter((r) => r.keep === true).length,
        floored,
        uncurated: rows.filter((r) => r.uncurated === true).length
      },
      frames: rows
    };
    await atomicWrite(path.join(dir, "reel.json"), JSON.stringify(reel, null, 2));

    // Graduation counting (S5): fold this run's VISION verdicts into the
    // Book's stability counters (rule-applied frames never feed the counter
    // that graduated them). Blind runs never write graduation state.
    if (!blind) {
      try {
        const observations = runTriggerObservations({ frames: all, verdictByName, pageIds });
        if (observations.length) {
          await recordCurationStability({ root, runId: record.id, observations });
        }
      } catch (err) {
        warn(`stability recording failed: ${err.message}`);
      }
    }

    // Keep the per-run evidence index honest: one reel row, replaced on
    // re-curation, never duplicated.
    try {
      const indexPath = path.join(dir, "evidence.json");
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      index.items = (index.items ?? []).filter((i) => i.kind !== "reel");
      index.items.unshift({
        item: "reel",
        kind: "reel",
        manifest: "reel.json",
        frames: reel.counts.reel,
        curated: reel.counts.curated,
        uncurated: reel.counts.uncurated,
        routedVia
      });
      index.updatedAt = curatedAt;
      await atomicWrite(indexPath, JSON.stringify(index, null, 2));
    } catch (err) {
      warn(`evidence.json reel row failed: ${err.message}`);
    }
    return reel;
  } catch (err) {
    warn(`curation failed: ${err.message}`);
    return null;
  }
}
