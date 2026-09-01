// Derived indexes. Nothing here is ever stored.
//
// The file-to-flows relationship and the uncommitted-changes mapping are both
// functions of the manifests, so computing them on request is the only way to
// guarantee they cannot drift. At pilot volume this costs microseconds; if it
// ever stops being free, cache it keyed on manifest hashes rather than persisting
// a second copy of the truth.

/**
 * path -> [{ flowId, stepIds }]
 *
 * Diff samples count too: a commit walkthrough legitimately "participates in" the
 * files it changed, and a reader looking up a file wants to find that walkthrough.
 */
export function buildFileIndex(flows) {
  const index = {};
  const add = (file, flowId, stepId) => {
    if (!file) return;
    if (!index[file]) index[file] = [];
    let entry = index[file].find((e) => e.flowId === flowId);
    if (!entry) {
      entry = { flowId, stepIds: [] };
      index[file].push(entry);
    }
    if (stepId && !entry.stepIds.includes(stepId)) entry.stepIds.push(stepId);
  };

  for (const flow of flows ?? []) {
    for (const state of flow.states ?? []) {
      for (const step of state.steps ?? []) {
        add(step.sample?.file, flow.flowId, step.id);
        add(step.diffSample?.file, flow.flowId, step.id);
      }
    }
  }

  // Deterministic ordering: the renderer's output must be reproducible.
  for (const file of Object.keys(index)) {
    index[file].sort((a, b) => a.flowId.localeCompare(b.flowId));
    for (const entry of index[file]) entry.stepIds.sort();
  }
  return index;
}

/** Which flows a finding's spans point at, folded into the same index. */
export function addFindingSpans(index, findings) {
  const out = { ...index };
  for (const f of findings ?? []) {
    const file = f.span?.file;
    if (!file) continue;
    if (!out[file]) out[file] = [];
    if (!out[file].some((e) => e.flowId === f.flowId)) {
      out[file].push({ flowId: f.flowId, stepIds: f.stepId ? [f.stepId] : [] });
    }
  }
  return out;
}

/**
 * Join `git status` against the index.
 *
 * A changed file that no flow covers is surfaced rather than hidden: that gap is
 * signal, and hiding it would let the viewer quietly stop describing the project.
 */
export function uncommittedView(statusEntries, fileIndex) {
  return (statusEntries ?? []).map((e) => {
    const flows = fileIndex[e.file] ?? [];
    return {
      file: e.file,
      status: e.status,
      from: e.from ?? null,
      flows,
      unmapped: flows.length === 0,
    };
  });
}

/** Flows whose steps sit in any of the given files — used to scope an update run. */
export function flowsTouchingFiles(fileIndex, files) {
  const ids = new Set();
  for (const file of files ?? []) {
    for (const entry of fileIndex[file] ?? []) ids.add(entry.flowId);
  }
  return [...ids].sort();
}

/** Coverage summary for the index page: how much of the analysed surface is stale. */
export function stalenessSummary(flows) {
  let fresh = 0;
  let stale = 0;
  let invalidated = 0;
  for (const flow of flows ?? []) {
    for (const state of flow.states ?? []) {
      for (const step of state.steps ?? []) {
        const status = step.staleness?.status ?? "fresh";
        if (status === "stale") stale += 1;
        else if (status === "invalidated") invalidated += 1;
        else fresh += 1;
      }
    }
  }
  return { fresh, stale, invalidated, total: fresh + stale + invalidated };
}
