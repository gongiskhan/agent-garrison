// level-resolution.mjs — the ONE dial the router turns, and how everything else
// resolves from it (ORCHESTRATOR_COHERENCE.md §2.3 / brief §2.3).
//
// The problem this solves: duties have levels and flows have levels, and if both
// are live the router has to reason about two numbers on every request. So the
// rule is that **the router chooses exactly one level — the flow level — and every
// duty level is derived from it** by a fixed three-step chain:
//
//   1. INHERIT   every duty in the flow runs at the flow level. A level 2 flow
//                runs its duties at level 2. This is the whole answer most of
//                the time.
//   2. PIN       the flow definition may pin an individual duty to a different
//                level AT A GIVEN FLOW LEVEL ("at flow level 2, review runs at
//                3"). Authoring time, declared once, visible in the definition.
//                This is the normal way to say "this kind of work always
//                warrants a harder review" and is the first thing to reach for.
//   3. ESCALATE  the router may raise ONE duty on ONE card when that card
//                warrants it. Never lowers. Never touches the flow level. Never
//                writes back into the flow definition. Always logged.
//
// The asymmetry in step 3 is deliberate: escalation is fail-safe (worst case you
// spent more compute than needed), de-escalation is not (worst case you shipped
// unreviewed work). So `escalate` can only ever move a level up, and an attempt to
// move it down is REJECTED and reported — not silently ignored, because a silent
// no-op would let a caller believe it had lowered something.
//
// A recurring escalation on the same work shape is the highest-value improver
// signal there is: it is the system telling you the flow definition is wrong.
// `summariseEscalations` shapes that for the improver, which proposes promoting
// the escalation into a pin (step 2) so the runtime escalation stops recurring —
// config converging on what actually happens instead of drifting away from it.
//
// This is the ONLY implementation. `src/lib/level-resolution.ts` is a typed LOADER
// that dynamic-imports this exact file (the same trick routing-core uses), not a
// mirror — so the level shown on screen can never disagree with the level the
// router acted on.

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 3;

/** How a duty arrived at its level. Ordered by precedence, lowest first. */
export const LEVEL_SOURCES = Object.freeze(["inherit", "pin", "escalation"]);

export function clampLevel(n) {
  // ACCEPT-LIST, not a reject-list. JS coerces a startling range of absent-ish
  // values to 0 — `Number(null)`, `Number("")`, `Number([])` and `Number(false)`
  // are all 0, not NaN. Any of them slipping through would clamp to 1 and make an
  // ABSENT pin read as "pinned to level 1", silently downgrading every duty in
  // every flow. That is the worst failure this module can have, so only a real
  // number or a numeric string is allowed in.
  const isNumber = typeof n === "number";
  const isNumericString = typeof n === "string" && n.trim() !== "" && Number.isFinite(Number(n));
  if (!isNumber && !isNumericString) return null;
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, v));
}

/**
 * The flow level for a request. This is the ONLY level the router picks.
 * Falls back to the flow's own `defaultLevel`, then to level 1 — never to a
 * silently higher level, because spending more compute than asked should be a
 * decision someone made, not a default.
 */
export function resolveFlowLevel(flow, requested) {
  return clampLevel(requested) ?? clampLevel(flow?.defaultLevel) ?? MIN_LEVEL;
}

/** The duty list a flow runs at a given flow level, in order. */
export function dutiesForLevel(flow, flowLevel) {
  const level = flow?.levels?.[String(flowLevel)];
  const duties = level?.duties;
  return Array.isArray(duties) ? duties.filter((d) => typeof d === "string" && d) : [];
}

/**
 * Resolve ONE duty's level. Pure — the caller supplies any escalation.
 *
 * @param flow       the flow definition
 * @param flowLevel  the level the router chose
 * @param duty       the duty id
 * @param escalation optional {level, reason} for THIS duty on THIS card
 * @returns {{level, source, inherited, pinned, escalated, reason, rejected}}
 *          `rejected` is set when an escalation asked to LOWER the level; the
 *          returned level is then the un-escalated one.
 */
export function resolveDutyLevel(flow, flowLevel, duty, escalation) {
  const inherited = resolveFlowLevel(flow, flowLevel);

  // 2. a pin declared in the flow definition at THIS flow level.
  const pins = flow?.levels?.[String(inherited)]?.pins;
  const pinnedRaw = pins && Object.prototype.hasOwnProperty.call(pins, duty) ? pins[duty] : null;
  const pinned = clampLevel(pinnedRaw);
  let level = pinned ?? inherited;
  let source = pinned != null && pinned !== inherited ? "pin" : "inherit";

  // 3. a per-card runtime escalation. Raise only.
  const wanted = clampLevel(escalation?.level);
  let escalated = null;
  let rejected = null;
  if (wanted != null) {
    if (wanted > level) {
      escalated = wanted;
      level = wanted;
      source = "escalation";
    } else if (wanted < level) {
      // Not silently dropped: a caller that believes it de-escalated and did not
      // would ship unreviewed work thinking it had chosen to.
      rejected = {
        requested: wanted,
        keptAt: level,
        why: "escalation may only raise a level, never lower it"
      };
    }
  }

  return {
    level,
    source,
    inherited,
    pinned: pinned ?? null,
    escalated,
    reason: escalated != null ? (escalation?.reason ?? null) : null,
    rejected
  };
}

/**
 * Resolve the whole duty sequence for a flow at a level.
 * `escalations` is {duty: {level, reason}} scoped to a single card.
 */
export function resolveFlowPlan(flow, flowLevel, escalations = {}) {
  const level = resolveFlowLevel(flow, flowLevel);
  const duties = dutiesForLevel(flow, level).map((duty) => ({
    duty,
    ...resolveDutyLevel(flow, level, duty, escalations?.[duty])
  }));
  return {
    flowLevel: level,
    duties,
    definitionOfDone: flow?.levels?.[String(level)]?.definitionOfDone ?? null,
    evidence: flow?.levels?.[String(level)]?.evidence ?? null
  };
}

/**
 * The decision-log record for an escalation. The brief is explicit that an
 * unlogged escalation is a bug, so this is the only supported way to make one:
 * it returns BOTH the resolution and the record that must be written.
 *
 * Returns `{applied: false}` with a record of the refusal when the escalation
 * would have lowered a level.
 */
export function escalateDuty({ flow, flowLevel, duty, toLevel, reason, cardId = null, at = null }) {
  const resolved = resolveDutyLevel(flow, flowLevel, duty, { level: toLevel, reason });
  const before = resolveDutyLevel(flow, flowLevel, duty).level;
  const applied = resolved.escalated != null;
  return {
    applied,
    resolved,
    record: {
      kind: "escalation",
      at,
      cardId,
      duty,
      flowLevel: resolved.inherited,
      from: before,
      to: resolved.level,
      // A reason is not optional. An escalation with no reason cannot become a
      // useful improver signal, and cannot be judged in the decisions log.
      reason: reason ?? null,
      applied,
      ...(resolved.rejected ? { rejected: resolved.rejected } : {})
    }
  };
}

/**
 * Group escalation records by (flow, level, duty, to) so the improver can spot a
 * shape that keeps escalating. When a group's count crosses the configured
 * threshold, that is evidence the FLOW DEFINITION is wrong rather than evidence
 * about any single card, and the improver proposes promoting it to a pin.
 */
export function summariseEscalations(records, { threshold = 3 } = {}) {
  const groups = new Map();
  for (const r of records || []) {
    if (!r || r.kind !== "escalation" || !r.applied) continue;
    const key = [r.flow ?? "", r.flowLevel ?? "", r.duty ?? "", r.to ?? ""].join("|");
    const g = groups.get(key) ?? {
      flow: r.flow ?? null,
      flowLevel: r.flowLevel ?? null,
      duty: r.duty ?? null,
      to: r.to ?? null,
      count: 0,
      reasons: [],
      cardIds: []
    };
    g.count += 1;
    if (r.reason && !g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    if (r.cardId) g.cardIds.push(r.cardId);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, recurring: g.count >= threshold }))
    .sort((a, b) => b.count - a.count);
}
