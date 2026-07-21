// reapply-sweep.mjs - post-ecosystem-update reapply sweep.
//
// A `status: "applied"` queue entry marks its target file with
// `<!-- improver:${id} -->` (apply-core.mjs's markerFor/buildNewContent). If an
// ecosystem update (or any external write) clobbers that file and the marker
// goes missing, this sweep reapplies the tracked improvement on top of the
// fresh content using the same never-clobber applyWithRetry contract. A
// genuine content conflict (the fresh content has drifted too far for a clean
// reapply) is recorded as `reapply-failed` with a reason - never silently
// dropped, never a crash.
//
// Today `evidence.targetFile` resolves to whatever server.mjs's targetFileFor()
// picked at apply time (one shared applied-content file, not per-skill files -
// see docs/autothing/runs/20260701-092738-9b939e7a/FLOW_PLAN.md). This sweep
// protects whatever that file is; it does not yet protect individual
// `~/.claude/skills/<name>/SKILL.md` files (out of scope here).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { saveQueue, markApplied, markReapplyFailed } from "./review-queue.mjs";
import { applyWithRetry, markerFor } from "./apply-core.mjs";
import { defaultStateDir, loadJsonLog, appendJsonLog } from "./json-log.mjs";

export { defaultStateDir };

function defaultQueuePath(stateDir) {
  return path.join(stateDir, "review-queue.json");
}

function logPath(stateDir) {
  return path.join(stateDir, "reapply-sweep-log.json");
}

// Distinguishes "no queue yet" (a fresh install - genuinely empty, fine to
// treat as []) from "the file exists but couldn't be read/parsed" (a real
// problem - review-queue.mjs's own loadQueue() collapses both into the same
// default [], which is fine for READING but not safe as the basis for a
// blind saveQueue() afterwards: a transient unreadable/corrupt file must
// never be silently overwritten with an empty/reconstructed queue).
async function probeQueue(queuePath) {
  if (!existsSync(queuePath)) return { ok: true, entries: [] };
  try {
    const parsed = JSON.parse(await readFile(queuePath, "utf8"));
    return { ok: true, entries: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    return { ok: false, entries: [], error: err?.message || String(err) };
  }
}

// Distinguishes a genuinely missing target (ENOENT) from a real read failure
// (permissions, EISDIR, transient I/O) - the two get different, honest
// reapplyFailureReason strings rather than being collapsed into one.
async function readTargetSafe(targetFile) {
  try {
    return { content: await readFile(targetFile, "utf8"), error: null };
  } catch (err) {
    if (err?.code === "ENOENT") return { content: null, error: "missing" };
    return { content: null, error: `unreadable: ${err?.message || err}` };
  }
}

// Sweep the review queue for `applied` entries whose target lost its marker and
// reapply them. Never throws - a per-entry failure is recorded, not propagated.
export async function runReapplySweep({ stateDir = defaultStateDir(), queuePath = defaultQueuePath(stateDir), reconcileFn } = {}) {
  const at = new Date().toISOString();
  const queueLoad = await probeQueue(queuePath);
  let queue = queueLoad.entries;
  const applied = queue.filter((p) => p.status === "applied" && p.evidence?.targetFile);

  let checked = 0;
  let restored = 0;
  let mutated = false;
  const failed = [];

  for (const entry of applied) {
    checked += 1;
    const targetFile = entry.evidence.targetFile;
    const { content, error } = await readTargetSafe(targetFile);

    if (error) {
      const reason = error === "missing" ? "target file missing" : `target file ${error}`;
      queue = markReapplyFailed(queue, entry.id, reason, at);
      mutated = true;
      failed.push({ id: entry.id, reason });
      continue;
    }
    if (content.includes(markerFor(entry.id))) {
      continue; // still protected - no action needed
    }

    try {
      const res = await applyWithRetry({ proposal: entry, targetFile, reconcileFn });
      if (res.ok) {
        queue = markApplied(queue, entry.id, res.evidence, at);
        mutated = true;
        restored += 1;
      } else {
        const reason = res.code === "conflict" ? "conflict: target changed again mid-reapply" : `apply failed: ${res.code || "unknown"}`;
        queue = markReapplyFailed(queue, entry.id, reason, at);
        mutated = true;
        failed.push({ id: entry.id, reason });
      }
    } catch (err) {
      const reason = `reapply threw: ${err?.message || err}`;
      queue = markReapplyFailed(queue, entry.id, reason, at);
      mutated = true;
      failed.push({ id: entry.id, reason });
    }
  }

  // Only persist when something actually changed. This matters most when
  // queueLoad.ok is false (the file existed but was unreadable/malformed):
  // `entries`/`applied` are then empty, so the loop never runs, `mutated`
  // stays false, and we correctly leave the real on-disk file untouched
  // instead of clobbering it with an empty/reconstructed queue.
  if (mutated) {
    try {
      await saveQueue(queuePath, queue);
    } catch (err) {
      console.error(`reapply-sweep: failed to persist ${queuePath}: ${err?.message || err}`);
    }
  }

  const summary = { at, checked, restored, failed, queueReadable: queueLoad.ok };
  await appendJsonLog(logPath(stateDir), summary);
  return summary;
}

export async function readReapplySweepLog(stateDir = defaultStateDir()) {
  return loadJsonLog(logPath(stateDir));
}
