// maintenance-core.mjs — pure stale/archive planner for owned skills (v1). No
// IO: given the skill set, telemetry, the provenance classifier, and the day
// thresholds, it decides which ELIGIBLE skills go `stale` (a reversible marker)
// or `archive` (a reversible move, executed by archive.mjs). Ineligible
// (loose/pinned) skills are SKIPPED, never touched. Deterministic given a fixed
// `now`.

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days since a skill was last used; Infinity when never used (no telemetry).
export function daysSince(lastUsedAt, now) {
  if (!lastUsedAt) return Infinity;
  const t = Date.parse(lastUsedAt);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return Infinity;
  return Math.max(0, (n - t) / DAY_MS);
}

// planMaintenance({ skills, telemetry, classify, now, staleDays, archiveDays, priorState })
//   -> { evaluated:[{name, daysUnused, state}], transitions:[{name, from, to, reason}], skipped:[{name, reason}] }
// `skills` is the full candidate set (on-disk ∪ telemetry); `priorState` is the
// last-known per-skill state map (from maintenance.json) so transitions are from→to.
export function planMaintenance({
  skills = [],
  telemetry = {},
  classify,
  now,
  staleDays = 30,
  archiveDays = 90,
  priorState = {},
} = {}) {
  const bySkill = telemetry.bySkill || telemetry || {};
  const cls = typeof classify === "function" ? classify : () => ({ owned: false, pinned: false, eligible: false });

  const evaluated = [];
  const transitions = [];
  const skipped = [];

  for (const name of skills) {
    const c = cls(name);
    if (!c.eligible) {
      skipped.push({ name, reason: c.pinned ? "pinned" : c.owned ? "owned-ineligible" : "loose" });
      continue;
    }
    const usage = bySkill[name] || null;
    const unused = daysSince(usage ? usage.lastUsedAt : null, now);
    const prior = priorState[name] || "active";

    let to = "active";
    if (unused >= archiveDays) to = "archive";
    else if (unused >= staleDays) to = "stale";

    const daysLabel = unused === Infinity ? null : Math.floor(unused);
    evaluated.push({ name, daysUnused: daysLabel, state: to });

    if (to !== "active" && to !== prior) {
      transitions.push({
        name,
        from: prior,
        to,
        reason: `unused ${unused === Infinity ? "never" : Math.floor(unused) + "d"} ≥ ${to === "archive" ? archiveDays : staleDays}d`,
      });
    }
  }

  return { evaluated, transitions, skipped };
}
