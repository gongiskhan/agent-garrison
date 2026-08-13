// Incremental invalidation: when a commit lands, work out which steps actually
// need a model's attention and leave the rest alone.
//
// This is the module that makes the whole product affordable. A naive design
// re-narrates everything on every commit and the token bill makes the viewer not
// worth keeping. Here, a step whose span was not touched is rebased by the hunk
// offsets above it, re-verified by hash, and stamped fresh with no model call.
//
// The safety net is the point: after rebasing, the span is re-extracted and its
// hash compared. If the arithmetic was wrong for any reason, the hash mismatches
// and the step degrades to `stale` — a badge. There is no path from a rebase bug
// to wrong code presented as fresh.
//
// Pure. The caller supplies a `readAt(file) => string | null` so this module
// never shells out.

import { hashText, normaliseHighlights, sliceSpan } from "./extract.mjs";

/**
 * Parse `git diff --unified=0` into per-file hunk lists.
 *
 * With --unified=0 there is no context, so each hunk's old range is exactly the
 * lines it touched. That exactness is what lets intersection be a decision rather
 * than a guess.
 */
export function parseUnifiedZeroDiff(diffText) {
  const byFile = new Map();
  const text = String(diffText ?? "");
  if (!text.trim()) return byFile;

  for (const chunk of text.split(/^diff --git /m).filter((c) => c.trim())) {
    const headerEnd = chunk.search(/^@@ /m);
    const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);

    const oldPath = /^--- a\/(.+)$/m.exec(header)?.[1]?.trim() ?? null;
    const newPath = /^\+\+\+ b\/(.+)$/m.exec(header)?.[1]?.trim() ?? null;
    const renameFrom = /^rename from (.+)$/m.exec(header)?.[1]?.trim() ?? null;
    const renameTo = /^rename to (.+)$/m.exec(header)?.[1]?.trim() ?? null;

    let status = "modified";
    if (/^new file mode/m.test(header)) status = "added";
    else if (/^deleted file mode/m.test(header)) status = "deleted";
    else if (renameFrom) status = "renamed";

    // Key on the OLD path: the anchors we are refreshing were recorded against it.
    const key = status === "renamed" ? renameFrom : status === "added" ? newPath : oldPath ?? newPath;
    if (!key) continue;

    const hunks = [];
    if (headerEnd !== -1) {
      for (const piece of chunk.slice(headerEnd).split(/^(?=@@ )/m)) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(piece);
        if (!m) continue;
        hunks.push({
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }

    byFile.set(key, {
      status,
      renamedTo: status === "renamed" ? renameTo : null,
      hunks,
    });
  }
  return byFile;
}

/**
 * Does any hunk touch [startLine, endLine]?
 *
 * A pure insertion has oldLines === 0 and occupies no old line, so it cannot
 * intersect a span — it only shifts what follows. Treating insertions as
 * intersecting would mark half the document stale on every commit.
 */
export function hunksTouch(hunks, startLine, endLine) {
  for (const h of hunks ?? []) {
    if (h.oldLines === 0) continue;
    const from = h.oldStart;
    const to = h.oldStart + h.oldLines - 1;
    if (from <= endLine && to >= startLine) return true;
  }
  return false;
}

/** Net line delta contributed by hunks entirely above `line`. */
export function deltaAbove(hunks, line) {
  let delta = 0;
  for (const h of hunks ?? []) {
    const endsAt = h.oldLines === 0 ? h.oldStart : h.oldStart + h.oldLines - 1;
    const isAbove = h.oldLines === 0 ? h.oldStart < line : endsAt < line;
    if (isAbove) delta += h.newLines - h.oldLines;
  }
  return delta;
}

/** Shift a span and its highlights by the delta accumulated above the span. */
export function rebaseSpan({ startLine, endLine, highlights }, hunks) {
  const delta = deltaAbove(hunks, startLine);
  const nextStart = startLine + delta;
  const nextEnd = endLine + delta;
  return {
    startLine: nextStart,
    endLine: nextEnd,
    highlights: normaliseHighlights(
      (highlights ?? []).map(([a, b]) => [a + delta, b + delta]),
      nextStart,
      nextEnd
    ),
    delta,
  };
}

/**
 * Refresh one step against a diff.
 *
 * Returns { step, outcome } where outcome is one of:
 *   "unchanged"   the file was not in the diff and the hash still verifies
 *   "restamped"   rebased, re-verified, stamped fresh — no model call needed
 *   "stale"       the span was touched; needs re-narration
 *   "invalidated" the anchor is gone, or verification failed after a rebase
 *   "skipped"     a diff sample: both its SHAs are immutable, so nothing to do
 */
export function refreshStep(step, byFile, newSha, readAt) {
  if (step.diffSample) return { step, outcome: "skipped" };
  if (!step.sample) return { step, outcome: "skipped" };

  const sample = step.sample;
  const entry = byFile.get(sample.file);

  if (entry && entry.status === "deleted") {
    return {
      step: mark(step, "invalidated", newSha, `${sample.file} was deleted`),
      outcome: "invalidated",
    };
  }
  if (entry && entry.status === "renamed") {
    // A rename cannot be trusted blindly: the content may also have moved within
    // the file. Hand it to re-narration with the new path recorded.
    return {
      step: mark(step, "stale", newSha, `${sample.file} was renamed to ${entry.renamedTo}`),
      outcome: "stale",
      renamedTo: entry.renamedTo,
    };
  }

  if (entry && hunksTouch(entry.hunks, sample.startLine, sample.endLine)) {
    return {
      step: mark(step, "stale", newSha, "a commit changed lines inside this span"),
      outcome: "stale",
    };
  }

  const rebased = entry ? rebaseSpan(sample, entry.hunks) : { ...sample, delta: 0 };
  const text = readAt(sample.file);
  if (text === null || text === undefined) {
    return {
      step: mark(step, "invalidated", newSha, `${sample.file} is not readable at ${short(newSha)}`),
      outcome: "invalidated",
    };
  }

  let sliced;
  try {
    sliced = sliceSpan(text, rebased.startLine, rebased.endLine);
  } catch (err) {
    return { step: mark(step, "stale", newSha, err.message), outcome: "stale" };
  }

  if (hashText(sliced) !== sample.extractedSha256) {
    // The safety net firing. Better a badge than a confident lie.
    return {
      step: mark(step, "stale", newSha, "the span moved in a way the rebase could not follow"),
      outcome: "stale",
    };
  }

  const nextStep = {
    ...step,
    sample: {
      ...sample,
      startLine: rebased.startLine,
      endLine: rebased.endLine,
      highlights: rebased.highlights,
      sha: newSha,
    },
    staleness: { status: "fresh", checkedAtSha: newSha, checkedAt: nowIso() },
  };
  return { step: nextStep, outcome: rebased.delta === 0 && !entry ? "unchanged" : "restamped" };
}

/** Refresh a whole flow. Returns the new flow plus a per-step report. */
export function refreshFlow(flow, byFile, newSha, readAt) {
  // `skipped` is counted, not dropped. A flow of eight steps that reports on five
  // leaves the reader unable to reconcile the numbers with the document in front of
  // them, and an unexplained gap in a report about staleness is the worst place to
  // have one. Skipped means a diff sample or a step with no code — nothing that can
  // go stale — and saying so is better than saying nothing.
  const report = {
    flowId: flow.flowId,
    unchanged: 0,
    restamped: 0,
    skipped: 0,
    stale: [],
    invalidated: [],
    renames: {},
  };

  const states = (flow.states ?? []).map((state) => ({
    ...state,
    steps: (state.steps ?? []).map((step) => {
      const { step: next, outcome, renamedTo } = refreshStep(step, byFile, newSha, readAt);
      if (outcome === "unchanged") report.unchanged += 1;
      else if (outcome === "restamped") report.restamped += 1;
      else if (outcome === "skipped") report.skipped += 1;
      else if (outcome === "stale") report.stale.push(step.id);
      else if (outcome === "invalidated") report.invalidated.push(step.id);
      if (renamedTo) report.renames[step.id] = renamedTo;
      return next;
    }),
  }));

  // The flow anchor advances only when nothing is left needing attention;
  // otherwise a half-refreshed flow would claim to describe a commit it does not.
  const clean = report.stale.length === 0 && report.invalidated.length === 0;
  const nextFlow = {
    ...flow,
    states,
    anchoredAt: clean ? { ...flow.anchoredAt, sha: newSha } : flow.anchoredAt,
  };
  return { flow: nextFlow, report };
}

/** A touched finding span means the finding may already be fixed. */
export function refreshFindings(findings, byFile) {
  const touched = [];
  const next = findings.map((f) => {
    if (!f.span?.file) return f;
    const entry = byFile.get(f.span.file);
    if (!entry) return f;
    const from = f.span.startLine ?? 1;
    const to = f.span.endLine ?? from;
    if (entry.status === "deleted" || hunksTouch(entry.hunks, from, to)) {
      touched.push(f.id);
      return { ...f, status: f.status === "fixed" ? "fixed" : "open", touchedByCommit: undefined };
    }
    return f;
  });
  return { findings: next, touched };
}

function mark(step, status, sha, reason) {
  return { ...step, staleness: { status, checkedAtSha: sha, checkedAt: nowIso(), reason } };
}

function nowIso() {
  return new Date().toISOString();
}

function short(sha) {
  return String(sha ?? "").slice(0, 8);
}
