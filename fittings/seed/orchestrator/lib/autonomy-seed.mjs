// autonomy-seed.mjs — expand the mined cold-start seed into the entry list
// `seedFromHistory` (routing-autonomy.mjs) consumes.
//
// The seed document (config/autonomy-seed.json, or a composition's own
// .garrison/autonomy-seed.json override) records how often each flow shape
// occurred in the Phase 0 mining as plain counts. This module turns those
// counts into [{shape, category}] entries — one per historical task, per
// decision category — because tracks are per (category, shape) and a seed
// that only warmed `flow` would leave every `level` decision asking forever.
//
// THE CAP IS THE POINT, not a convenience. Seeded weight lands in a track's
// `positive` and is NOT bounded by SILENCE_CAP, so raw mined volumes (280 fix
// commits) would push confidence past the upper threshold and buy act-inform
// from inferred history alone — the exact thing routing-autonomy's own
// invariant says must never happen. At the default silence weight, 50 entries
// land confidence exactly ON the lower threshold: above ask, below act-inform.
// That is the intended cold-start posture — the router stops interrogating the
// shapes the mining proved common, and still cannot act-without-offering-revert
// until real evidence arrives. tests/autonomy-seed.test.ts pins this.
//
// Pure: no I/O, no clock. Callers read the JSON themselves (the shell API
// route today; the gateway's decision-time consult loads it from the resolved
// orchestrator dir the same way it loads dispatch-core).

export const SEED_CAP_DEFAULT = 50;

/** The two decision categories the bands track. Kept in lockstep with
 *  CATEGORIES in routing-autonomy.mjs — an entry in neither is skipped by
 *  seedFromHistory, so drift here fails soft (a cold shape, not a crash). */
export const SEED_CATEGORIES = Object.freeze(["flow", "level"]);

/**
 * Expand a seed document into seedFromHistory entries.
 * Malformed input yields [] or skips the malformed shape — a broken seed file
 * must degrade to a cold start, never to a crash on the decision path.
 */
export function expandAutonomySeed(doc, { cap = null, categories = SEED_CATEGORIES } = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  const shapes = doc.shapes;
  if (!shapes || typeof shapes !== "object" || Array.isArray(shapes)) return [];
  const docCap = Number.isFinite(Number(doc.cap)) && Number(doc.cap) > 0 ? Math.trunc(Number(doc.cap)) : null;
  const effectiveCap = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.trunc(Number(cap)) : (docCap ?? SEED_CAP_DEFAULT);
  const entries = [];
  for (const [shape, rawCount] of Object.entries(shapes)) {
    if (typeof shape !== "string" || !shape.trim()) continue;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count <= 0) continue;
    const n = Math.min(Math.trunc(count), effectiveCap);
    for (const category of categories) {
      for (let i = 0; i < n; i++) entries.push({ shape, category });
    }
  }
  return entries;
}
