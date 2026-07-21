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
  maxCurated: 30, // vision budget per run (D4: ~30 images for a typical Full Drill)
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
    maxCurated: clampInt(merged.maxCurated, CURATION_DEFAULTS.maxCurated, 1, 40),
    batchSize: clampInt(merged.batchSize, CURATION_DEFAULTS.batchSize, 1, 40)
  };
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

// Deterministic selection under the vision budget: signal-trigger frames
// (something HAPPENED) outrank boundary frames, both in time order. Frames
// past the budget are marked uncurated in the reel — visible in show-all,
// never silently dropped (D1).
export function selectCurationCandidates(frames, maxCurated) {
  const chosen = new Set();
  for (const f of frames) {
    if (chosen.size >= maxCurated) break;
    if (SIGNAL_TRIGGERS.has(f.trigger)) chosen.add(f.name);
  }
  for (const f of frames) {
    if (chosen.size >= maxCurated) break;
    chosen.add(f.name);
  }
  return frames.filter((f) => chosen.has(f.name));
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
    const candidates = selectCurationCandidates(visionPool, config.maxCurated);
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
      let payload = {};
      try {
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
        payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `curation route ${res.status}`);
      } catch (err) {
        failedBatches += 1;
        warn(`batch ${Math.floor(i / config.batchSize) + 1} failed: ${err.message}`);
        continue;
      }
      batches += 1;
      routedVia = payload.routedVia ?? routedVia;
      for (const v of payload.results ?? []) {
        if (v && typeof v.name === "string") verdictByName.set(v.name, v);
      }
    }
    if (verdictByName.size === 0) {
      warn("no curation verdicts came back — reel not written");
      return null;
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
    const reel = {
      version: 1,
      runId: record.id,
      curatedAt,
      // Rules-only runs never touched a model — say so instead of null.
      routedVia: routedVia ?? (ruleVerdicts.size ? "capture-rules" : null),
      batches,
      failedBatches,
      reengaged,
      counts: {
        frames: all.length,
        candidates: candidates.length,
        curated: verdictByName.size,
        ruleApplied: rows.filter((r) => r.ruleApplied === true).length,
        reel: rows.filter((r) => r.keep === true).length,
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
