// policy-core.mjs — the pure v2 policy heart of the Orchestrator fitting.
//
// GARRISON-UNIFY-V1 S1: the routing config grows into THE policy — task types
// for every pipeline verb, a matrix that resolves taskType × tier straight to
// a TARGET (the v1 role layer collapses; roles survive only as derived ladder
// labels for logging/back-compat), phase plans, work kinds, and the
// phase-skill registry. compilePolicy() flattens the active profile into the
// single machine-readable consumption interface written to
// ~/.garrison/orchestrator/policy.json (byte-stable ordering; the WRITER owns
// atomicity — this module stays pure: NO Date.now / Math.random / I/O).
//
// v1 configs (role-based, BRIEF v4) are accepted via migrateRoutingConfig();
// routing-core.mjs delegates here when config.version === 2.

export const POLICY_VERSION = 2;

// Pipeline verbs — every phase is a task type (D1). Order IS pipeline order.
export const PHASES = [
  "plan",
  "implement",
  "review",
  "adversarial-review",
  "test",
  "adversarial-test",
  "ux-qa",
  "walkthrough",
  "validate",
  "codex-checkpoint",
  "report"
];

export const GENERAL_TASK_TYPES = ["code", "research", "writing", "image", "video", "ops", "other"];

// Full v2 vocabulary: pipeline verbs + general kinds ("review" counts once, as
// a verb — D1 lists the general kinds WITHOUT review).
export const TASK_TYPES_V2 = [...PHASES, ...GENERAL_TASK_TYPES];

export const TIERS = ["T0-trivial", "T1-standard", "T2-deep"];
export const EVIDENCE_KINDS = ["video", "logs", "text", "none"];
export const EXECUTIONS = ["interactive", "autonomous"];

// Ladder labels, cheap→expensive. A profile's computeLadder holds target ids
// in this order; modes routingBias {floor, prefer} moves along it (the
// behavior-preserving replacement for v1 role bias).
export const LADDER_LABELS = ["fast", "standard", "expert"];

export function isV2(config) {
  return !!config && typeof config === "object" && config.version === 2;
}

// ── Migration (pure, deterministic) ─────────────────────────────────────────
// v1 role-based → v2 target-based. Per profile: materialize the full matrix by
// resolving every role reference through that profile's roleMap; derive
// computeLadder from roleMap [fast, standard, expert]; exceptions keep their
// classifier semantics ({id, when}) and gain a target (active-profile
// resolution), with per-profile overrides where a roleMap differs.
export function migrateRoutingConfig(v1) {
  if (isV2(v1)) return v1;
  if (!v1 || v1.version !== 1) throw new Error(`cannot migrate routing config version ${v1 && v1.version}`);
  const activeProfile = v1.activeProfile || Object.keys(v1.profiles || {})[0];
  const mapRole = (roleMap, role) => (roleMap || {})[role] || null;

  const profiles = {};
  for (const [name, p] of Object.entries(v1.profiles || {})) {
    const rm = p.roleMap || {};
    const rows = {};
    for (const [tt, row] of Object.entries((v1.matrix || {}).rows || {})) {
      const cells = {};
      for (const [tier, role] of Object.entries(row.cells || {})) {
        const tid = mapRole(rm, role);
        if (tid) cells[tier] = tid;
      }
      const def = row.default ? mapRole(rm, row.default) : null;
      rows[tt] = { ...(def ? { default: def } : {}), cells };
    }
    const columns = {};
    for (const [tier, role] of Object.entries((v1.matrix || {}).columns || {})) {
      const tid = mapRole(rm, role);
      if (tid) columns[tier] = tid;
    }
    const globalRole = ((v1.matrix || {}).defaults || {}).role || "standard";
    const exceptionOverrides = {};
    for (const e of v1.exceptions || []) {
      const tid = mapRole(rm, e.role);
      const activeTid = mapRole((v1.profiles?.[activeProfile] || {}).roleMap, e.role);
      if (tid && tid !== activeTid) exceptionOverrides[e.id] = tid;
    }
    profiles[name] = {
      preRoute: p.preRoute ?? "on",
      matrix: {
        defaults: { target: mapRole(rm, globalRole) },
        columns,
        rows
      },
      computeLadder: LADDER_LABELS.map((l) => mapRole(rm, l)).filter(Boolean),
      disciplineOverrides: p.disciplineOverrides || {},
      ...(Object.keys(exceptionOverrides).length ? { exceptionOverrides } : {})
    };
  }

  const activeRoleMap = (v1.profiles?.[activeProfile] || {}).roleMap || {};
  const exceptions = (v1.exceptions || []).map((e) => ({
    id: e.id,
    when: e.when,
    target: mapRole(activeRoleMap, e.role)
  }));

  return {
    version: 2,
    activeProfile,
    taskTypes: Array.from(new Set([...(v1.taskTypes || GENERAL_TASK_TYPES), ...TASK_TYPES_V2])),
    tiers: v1.tiers || TIERS,
    tierDefinitions: v1.tierDefinitions || {},
    exceptions,
    targets: v1.targets || [],
    profiles,
    discipline: v1.discipline || {},
    continuations: v1.continuations || [],
    phases: [...PHASES],
    phasePlans: {},
    workKinds: {},
    defaultWorkKind: null,
    phaseSkills: { bindings: {}, overrides: {} }
  };
}

// ── Profile access ───────────────────────────────────────────────────────────
function activeProfileName(config, profile) {
  return profile || config.activeProfile || Object.keys(config.profiles || {})[0];
}

export function getProfileV2(config, profile) {
  const name = activeProfileName(config, profile);
  const p = (config.profiles || {})[name];
  if (!p) throw new Error(`policy: unknown profile "${name}"`);
  return { name, profile: p };
}

// ── Resolution (Stage A pure code, v2) ──────────────────────────────────────
// Ordered exceptions (first match wins, per-profile override honored) →
// profile matrix cell > row default > column default > global default → a
// TARGET id. The `role` in the result is a derived label (ladder position, or
// the taskType for non-ladder targets) kept for logging/back-compat.
export function resolveTargetId(config, profileName, classification) {
  const { profile: p } = getProfileV2(config, profileName);
  const { taskType, tier, matchedException } = classification || {};
  if (matchedException) {
    const ex = (config.exceptions || []).find((e) => e.id === matchedException);
    if (ex) {
      const overridden = (p.exceptionOverrides || {})[ex.id];
      return { targetId: overridden || ex.target, ruleId: `exception:${ex.id}`, via: "exception" };
    }
  }
  const matrix = p.matrix || {};
  const row = (matrix.rows || {})[taskType];
  if (row && row.cells && Object.prototype.hasOwnProperty.call(row.cells, tier)) {
    return { targetId: row.cells[tier], ruleId: `cell:${taskType}/${tier}`, via: "cell" };
  }
  if (row && row.default) {
    return { targetId: row.default, ruleId: `row:${taskType}`, via: "row-default" };
  }
  const col = (matrix.columns || {})[tier];
  if (col) return { targetId: col, ruleId: `col:${tier}`, via: "column-default" };
  const def = (matrix.defaults || {}).target;
  return { targetId: def || null, ruleId: "default", via: "global-default" };
}

export function ladderLabelFor(config, profileName, targetId) {
  const { profile: p } = getProfileV2(config, profileName);
  const idx = (p.computeLadder || []).indexOf(targetId);
  return idx >= 0 ? LADDER_LABELS[Math.min(idx, LADDER_LABELS.length - 1)] : null;
}

export function resolveRouteV2(config, profile, classification) {
  const { name } = getProfileV2(config, profile);
  const { targetId, ruleId, via } = resolveTargetId(config, name, classification);
  const target = (config.targets || []).find((t) => t.id === targetId) || null;
  const role = ladderLabelFor(config, name, targetId) || (classification || {}).taskType || null;
  return { profile: name, role, ruleId, via, targetId: targetId || null, target };
}

// ── Mode bias on the ladder (behavior-preserving v1 biasRole port) ──────────
// `floor` raises a too-cheap target up; a "standard" resolution with a cheaper
// `prefer` dials down. Targets off the ladder (image/video/secondary/etc.) are
// never biased. Mirrors routing-core.biasRole exactly, on target ids.
export function biasTarget(targetId, bias, computeLadder) {
  const ladder = computeLadder || [];
  const rank = ladder.indexOf(targetId);
  if (rank === -1 || !bias) return targetId;
  const rankOf = (label) => LADDER_LABELS.indexOf(label);
  let r = rank;
  const preferRank = rankOf(bias.prefer);
  const floorRank = rankOf(bias.floor);
  if (LADDER_LABELS[rank] === "standard" && preferRank >= 0 && preferRank < r) r = preferRank;
  if (floorRank >= 0 && floorRank > r) r = floorRank;
  return ladder[Math.min(r, ladder.length - 1)] ?? targetId;
}

// ── Discipline (unchanged semantics) ────────────────────────────────────────
export const DISCIPLINE_FIELDS = ["review", "testing", "evidence", "distribution"];

export function resolveDisciplineV2(config, profile, tier) {
  const { profile: p } = getProfileV2(config, profile);
  const base = (config.discipline || {})[tier] || {};
  const over = (p.disciplineOverrides || {})[tier] || {};
  const out = {};
  for (const f of DISCIPLINE_FIELDS) out[f] = over[f] ?? base[f] ?? "none";
  return out;
}

// ── Phase rails ──────────────────────────────────────────────────────────────
// A work kind names a phase plan; a phase plan is an ORDERED SUBSET of the
// pipeline phases (D2) — so the rail carries EVERY pipeline phase: the plan's
// phases (plan order, on/off per plan), then the remaining pipeline phases
// (policy order) rendered OFF with off_reason "phase-plan". A disabled phase
// stays IN the rail, rendered off — honesty, never hidden. `cardToggles`
// (D17) is an optional map {phase: false} merged over the plan.
export function railFor(config, workKindName, cardToggles) {
  const kindName = workKindName || config.defaultWorkKind;
  const kind = (config.workKinds || {})[kindName];
  if (!kind) throw new Error(`policy: unknown work kind "${kindName}"`);
  const plan = (config.phasePlans || {})[kind.phasePlan];
  if (!plan) throw new Error(`policy: work kind "${kindName}" names unknown phase plan "${kind.phasePlan}"`);
  const allPhases = Array.isArray(config.phases) ? config.phases : [...PHASES];
  const bindings = (config.phaseSkills || {}).bindings || {};
  const overrides = ((config.phaseSkills || {}).overrides || {})[kindName] || {};
  const entry = (id, planOn) => {
    const toggledOff = cardToggles && cardToggles[id] === false;
    return {
      id,
      on: planOn && !toggledOff,
      ...(toggledOff ? { off_reason: "card-toggle" } : planOn ? {} : { off_reason: "phase-plan" }),
      skill: overrides[id] || bindings[id] || null
    };
  };
  const inPlan = new Map(
    (plan.phases || []).map((ph) => {
      const id = typeof ph === "string" ? ph : ph.id;
      const on = typeof ph === "string" ? true : ph.on !== false;
      return [id, on];
    })
  );
  return {
    workKind: kindName,
    evidence: plan.evidence || "none",
    phases: [
      ...[...inPlan.entries()].map(([id, on]) => entry(id, on)),
      ...allPhases.filter((id) => !inPlan.has(id)).map((id) => entry(id, false))
    ]
  };
}

// Infer a phase plan from the discipline defaults of a tier (D2: work matching
// no named kind). Pure + recorded by the caller on the card.
export function inferPhasePlan(config, profileName, tier) {
  const d = resolveDisciplineV2(config, profileName, tier);
  const phases = ["implement"];
  if (d.testing !== "none") phases.push("test");
  if (d.review === "self-review") phases.splice(1, 0, "review");
  if (String(d.review).startsWith("review-by")) phases.splice(1, 0, "review", "adversarial-review");
  if (d.evidence === "video") phases.push("walkthrough");
  if (d.distribution !== "none") phases.push("validate", "report");
  const evidence = d.evidence === "video" ? "video" : d.evidence === "none" ? "none" : d.evidence === "text" ? "text" : "logs";
  return { inferred: true, tier, evidence, phases: phases.map((id) => ({ id, on: true })) };
}

// ── Validation ───────────────────────────────────────────────────────────────
export function validatePolicyConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return ["config is not an object"];
  if (config.version !== 2) errors.push("version must be 2");
  if (!config.profiles || !Object.keys(config.profiles).length) errors.push("no profiles defined");
  if (!config.activeProfile) errors.push("no activeProfile");
  else if (!(config.profiles || {})[config.activeProfile]) errors.push(`activeProfile "${config.activeProfile}" not in profiles`);
  const targetIds = new Set((config.targets || []).map((t) => t.id));
  const taskTypes = config.taskTypes || TASK_TYPES_V2;
  const tiers = config.tiers || TIERS;

  for (const e of config.exceptions || []) {
    if (e.target && !targetIds.has(e.target)) errors.push(`exception ${e.id}: unknown target ${e.target}`);
  }
  for (const [pname, p] of Object.entries(config.profiles || {})) {
    const m = p.matrix || {};
    const check = (tid, where) => {
      if (tid && !targetIds.has(tid)) errors.push(`profile ${pname}: ${where} -> unknown target ${tid}`);
    };
    check((m.defaults || {}).target, "matrix default");
    for (const [tier, tid] of Object.entries(m.columns || {})) {
      if (!tiers.includes(tier)) errors.push(`profile ${pname}: matrix column ${tier} not a tier`);
      check(tid, `column ${tier}`);
    }
    for (const [tt, row] of Object.entries(m.rows || {})) {
      if (!taskTypes.includes(tt)) errors.push(`profile ${pname}: matrix row ${tt} not a task type`);
      check(row.default, `row ${tt} default`);
      for (const [tier, tid] of Object.entries(row.cells || {})) {
        if (!tiers.includes(tier)) errors.push(`profile ${pname}: matrix ${tt}/${tier} not a tier`);
        check(tid, `cell ${tt}/${tier}`);
      }
    }
    for (const tid of p.computeLadder || []) check(tid, "computeLadder");
    for (const [exId, tid] of Object.entries(p.exceptionOverrides || {})) check(tid, `exceptionOverride ${exId}`);
  }
  // Phase machinery
  const phases = config.phases || [];
  for (const ph of phases) {
    if (typeof ph !== "string" || !ph.length) errors.push(`phase entry invalid: ${ph}`);
  }
  const planNames = new Set(Object.keys(config.phasePlans || {}));
  for (const [name, plan] of Object.entries(config.phasePlans || {})) {
    if (plan.evidence && !EVIDENCE_KINDS.includes(plan.evidence)) {
      errors.push(`phase plan ${name}: evidence ${plan.evidence} not in ${EVIDENCE_KINDS.join("|")}`);
    }
    for (const ph of plan.phases || []) {
      const id = typeof ph === "string" ? ph : ph.id;
      if (!phases.includes(id)) errors.push(`phase plan ${name}: unknown phase ${id}`);
    }
  }
  for (const [kind, k] of Object.entries(config.workKinds || {})) {
    if (!k.phasePlan || !planNames.has(k.phasePlan)) {
      errors.push(`work kind ${kind}: unknown phase plan ${k.phasePlan}`);
    }
  }
  if (config.defaultWorkKind && !(config.workKinds || {})[config.defaultWorkKind]) {
    errors.push(`defaultWorkKind ${config.defaultWorkKind} not in workKinds`);
  }
  const bindings = (config.phaseSkills || {}).bindings || {};
  for (const [ph] of Object.entries(bindings)) {
    if (!phases.includes(ph)) errors.push(`phaseSkills binding for unknown phase ${ph}`);
  }
  for (const [kind, over] of Object.entries((config.phaseSkills || {}).overrides || {})) {
    if (!(config.workKinds || {})[kind]) errors.push(`phaseSkills override for unknown work kind ${kind}`);
    for (const [ph] of Object.entries(over || {})) {
      if (!phases.includes(ph)) errors.push(`phaseSkills override ${kind}: unknown phase ${ph}`);
    }
  }
  return errors;
}

// ── Byte-stable serialization ────────────────────────────────────────────────
export function stableStringify(value) {
  return JSON.stringify(sortForJson(value), null, 2) + "\n";
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortForJson(value[key]);
  return out;
}

// ── compilePolicy — the one consumption interface (D4) ──────────────────────
// Flattens the ACTIVE profile into a fully-resolved object: every
// taskType × tier resolved to its concrete target ({targetId, type, runtime,
// provider, model, effort}), discipline resolved, rails resolvable offline.
// The caller writes stableStringify(compilePolicy(config)) atomically to
// ~/.garrison/orchestrator/policy.json. NO timestamps — byte-stable.
export function compilePolicy(config, profile) {
  const cfg = isV2(config) ? config : migrateRoutingConfig(config);
  const errors = validatePolicyConfig(cfg);
  if (errors.length) throw new Error("policy config INVALID:\n  - " + errors.join("\n  - "));
  const { name, profile: p } = getProfileV2(cfg, profile);
  const taskTypes = cfg.taskTypes || TASK_TYPES_V2;
  const tiers = cfg.tiers || TIERS;
  const targetsById = {};
  for (const t of cfg.targets || []) targetsById[t.id] = t;

  const matrix = {};
  for (const tt of taskTypes) {
    matrix[tt] = {};
    for (const tier of tiers) {
      const { targetId, ruleId } = resolveTargetId(cfg, name, { taskType: tt, tier });
      const t = targetsById[targetId] || null;
      matrix[tt][tier] = {
        targetId: targetId || null,
        rule: ruleId,
        type: t?.type ?? null,
        runtime: t?.runtime ?? null,
        provider: t?.provider ?? null,
        model: t?.model ?? null,
        effort: t?.effort ?? null
      };
    }
  }

  const discipline = {};
  for (const tier of tiers) discipline[tier] = resolveDisciplineV2(cfg, name, tier);

  return {
    policyVersion: POLICY_VERSION,
    activeProfile: name,
    preRoute: p.preRoute ?? "on",
    taskTypes,
    tiers,
    tierDefinitions: cfg.tierDefinitions || {},
    targets: targetsById,
    computeLadder: p.computeLadder || [],
    exceptions: (cfg.exceptions || []).map((e) => ({
      id: e.id,
      when: e.when,
      targetId: (p.exceptionOverrides || {})[e.id] || e.target || null
    })),
    matrix,
    discipline,
    continuations: cfg.continuations || [],
    phases: cfg.phases || [...PHASES],
    phasePlans: cfg.phasePlans || {},
    workKinds: cfg.workKinds || {},
    defaultWorkKind: cfg.defaultWorkKind || null,
    phaseSkills: cfg.phaseSkills || { bindings: {}, overrides: {} },
    projects: cfg.projects || {},
    uxQa: cfg.uxQa || { severityThreshold: "major" }
  };
}

// Resolve a phase to its execution triple straight off a COMPILED policy —
// what phase skills and the run engine call (no config, no HTTP, no I/O).
export function resolvePhaseTarget(policy, phase, tier) {
  const cell = ((policy.matrix || {})[phase] || {})[tier];
  if (!cell) throw new Error(`policy: no matrix cell for ${phase} × ${tier}`);
  return cell;
}

// ── Autonomy axis (D8) ───────────────────────────────────────────────────────
// preRoute output extends to {taskType, tier, execution}. Deterministic rules
// first (pure): a card- or scheduler-originated turn is autonomous; an explicit
// autonomous marker (the web-channel toggle, the autothing doorway) is
// autonomous; a multi-step cross-app automation shape is autonomous; otherwise
// THE CLASSIFIER decides (its reply now carries an `execution` field — see
// buildClassifierPrompt), with Gary-mode conversation flooring to interactive.
// NOTE (rev-s2 finding #2): there is deliberately NO task-type fallback here —
// the live classifier vocabulary is the general kinds, so keying autonomy on
// pipeline-verb task types was dead code with one false-positive ("review this
// diff" card-ifying an inline review). Ordinary chat work stays interactive
// unless an origin, an explicit marker, or the classifier itself says
// autonomous. Returns "interactive" | "autonomous".
const AUTONOMOUS_CHANNELS = new Set(["kanban", "scheduler", "board", "autothing"]);
const AUTOMATION_SHAPE = /\b(then|after that|every day|each morning|on a schedule|and then|for each|across (all|both)|multi-step|automate|workflow)\b/i;
const BUILD_VERBS = new Set([
  "plan", "implement", "test", "review", "adversarial-review", "adversarial-test",
  "ux-qa", "walkthrough", "validate", "codex-checkpoint"
]);

export function classifyExecution({ channel, explicitAutonomous, mode, message, classification } = {}) {
  if (explicitAutonomous === true) return "autonomous";
  if (channel && AUTONOMOUS_CHANNELS.has(String(channel).toLowerCase())) return "autonomous";
  if (
    typeof message === "string" &&
    AUTOMATION_SHAPE.test(message) &&
    (classification?.taskType === "ops" || classification?.taskType === "other")
  ) {
    return "autonomous";
  }
  if (mode === "gary") return "interactive";
  // The classifier's own read (buildClassifierPrompt asks for it; an absent or
  // out-of-vocab value means interactive).
  if (classification?.execution === "autonomous") return "autonomous";
  return "interactive";
}

// Whether an AUTONOMOUS turn is "significant" enough to become a card+run
// rather than run inline (the autothing scope test): a pipeline verb (reachable
// via explicit engine/doorway hints), or code/ops work above T0. Only consulted
// AFTER execution resolved autonomous — it never makes something autonomous.
export function isSignificantAutonomous(classification) {
  if (!classification) return false;
  if (BUILD_VERBS.has(classification.taskType)) return true;
  if ((classification.taskType === "code" || classification.taskType === "ops") && classification.tier !== "T0-trivial") return true;
  return false;
}

// Build the board-API card payload for an autonomous run (D8 card creation).
// Pure: the caller POSTs it to the board's /cards endpoint. `phases` is an
// optional per-card toggle map merged over the work kind's plan (D17).
export function buildAutonomousCardPayload({ brief, project, workKind, phases, taskType, tier } = {}) {
  return {
    description: brief || "",
    project: project || null,
    list: "backlog",
    goalMode: true,
    workKind: workKind || null,
    phases: phases || null,
    origin: "orchestrator",
    classification: taskType && tier ? { taskType, tier } : null
  };
}

// ── compileRoutingV2 — the {{routing}} markdown for v2 configs ──────────────
function targetLabelV2(config, targetId) {
  const t = (config.targets || []).find((x) => x.id === targetId);
  if (!t) return `${targetId} (UNDEFINED TARGET)`;
  if (t.type === "secondary") {
    const bits = [t.model, t.effort].filter(Boolean).join(" / ");
    return `delegate to secondary runtime \`${t.runtime}\`${bits ? ` (${bits})` : ""}`;
  }
  if (t.type === "workflow") return `run workflow \`${t.workflow || t.id}\``;
  const bits = [t.runtime, t.provider, t.model, t.effort].filter(Boolean).join(" / ");
  return `${bits}${t.soul ? ` (soul: ${t.soul})` : ""}`;
}

export function routingMarkerV2(profileName) {
  return `<!-- garrison:routing v${POLICY_VERSION} profile=${profileName} -->`;
}

export function compileRoutingV2(config, profile) {
  const { name, profile: p } = getProfileV2(config, profile);
  const taskTypes = config.taskTypes || TASK_TYPES_V2;
  const tiers = config.tiers || TIERS;
  const m = p.matrix || {};
  const sections = [];
  sections.push(routingMarkerV2(name));
  sections.push("## Routing policy");
  sections.push(
    `Active Profile: **${name}** (preRoute: ${p.preRoute ?? "on"}). The gateway pre-routes every inbound ` +
      `message: the warm classifier returns {taskType, tier, execution}, pure code resolves the concrete ` +
      `**target** via the matrix below. You do not choose your own model — the gateway has already placed ` +
      `this turn on the resolved target.`
  );
  sections.push("### Targets");
  sections.push(
    (config.targets || [])
      .map((t) => `- \`${t.id}\` — ${targetLabelV2(config, t.id)}${t.pinned ? " (pinned)" : ""}`)
      .join("\n")
  );
  sections.push("### Tier definitions");
  sections.push(tiers.map((t) => `- **${t}** — ${(config.tierDefinitions || {})[t] || "(no definition)"}`).join("\n"));
  sections.push("### Exceptions (ordered — first match wins, resolves to a target)");
  const exceptions = (config.exceptions || []).map((e, i) => {
    const tid = (p.exceptionOverrides || {})[e.id] || e.target;
    return `${i + 1}. \`${e.id}\` — WHEN ${e.when} → \`${tid}\``;
  });
  sections.push(exceptions.length ? exceptions.join("\n") : "_(none)_");
  sections.push("### Matrix (task-type × tier → target; inheritance: cell > row > column > default)");
  {
    const header = `| task-type | ${tiers.join(" | ")} | row-default |`;
    const sep = `|${"---|".repeat(tiers.length + 2)}`;
    const body = taskTypes.map((tt) => {
      const row = (m.rows || {})[tt] || {};
      const cells = tiers.map((tier) =>
        row.cells && Object.prototype.hasOwnProperty.call(row.cells, tier) ? row.cells[tier] : "·"
      );
      return `| ${tt} | ${cells.join(" | ")} | ${row.default || "·"} |`;
    });
    const colDefaults = `| _column-default_ | ${tiers
      .map((t) => (m.columns || {})[t] || "·")
      .join(" | ")} | ${(m.defaults || {}).target || "·"} |`;
    sections.push([header, sep, ...body, colDefaults].join("\n"));
  }
  sections.push("### Discipline (post-task duties by tier)");
  // Annotate each duty with the skill that satisfies it — resolved from the
  // phase-skill REGISTRY (D3: bindings are configuration, never hardcoded).
  const bindings = ((config.phaseSkills || {}).bindings || {});
  const annotate = (field, value) => {
    if (!value || value === "none") return value;
    if (field === "testing") return `${value} → ${bindings.test || "test"}`;
    if (field === "review") {
      // ux-qa is UI-only — CONDITIONAL, not a blanket second gate.
      return String(value).startsWith("review-by")
        ? `${value} → ${bindings.review || "review"} (+ ${bindings["ux-qa"] || "ux-qa"} for UI changes)`
        : `${value} → ${bindings.review || "review"}`;
    }
    if (field === "evidence") return value === "video" ? `${value} → ${bindings.walkthrough || "walkthrough"}` : value;
    if (field === "distribution")
      return value === "link" ? `${value} → ${bindings.validate || "validate"} (record + link)` : value;
    return value;
  };
  sections.push(
    tiers
      .map((tier) => {
        const d = resolveDisciplineV2(config, name, tier);
        return `- **${tier}** — review: ${annotate("review", d.review)}; testing: ${annotate("testing", d.testing)}; evidence: ${annotate("evidence", d.evidence)}; distribution: ${annotate("distribution", d.distribution)}`;
      })
      .join("\n")
  );
  sections.push("### Continuations (post-task, by output kind)");
  const conts = (config.continuations || []).map((c) => {
    const seq = (c.then || [])
      .map((s) => {
        if (s.verb === "store") return "write the output to the Artifact Store";
        if (s.verb === "ask") return `ask the user: "${s.arg || "Continue?"}" (everything after is gated on yes)`;
        if (s.verb === "notify") return `notify channel \`${s.arg || "?"}\``;
        if (s.verb === "route") return `chain into routing target \`${s.arg}\` — ${targetLabelV2(config, s.arg)}`;
        return `${s.verb} ${s.arg || ""}`.trim();
      })
      .join(", then ");
    return `- WHEN this turn produced a **${c.when}** → ${seq}`;
  });
  sections.push(conts.length ? conts.join("\n") : "_(none)_");
  const kinds = Object.keys(config.workKinds || {});
  if (kinds.length) {
    sections.push("### Work kinds → phase rails (autonomous runs)");
    sections.push(
      kinds
        .map((k) => {
          const rail = railFor(config, k);
          const chips = rail.phases.map((ph) => (ph.on ? ph.id : `~~${ph.id}~~`)).join(" → ");
          return `- **${k}**${k === config.defaultWorkKind ? " (default)" : ""} — ${chips} (evidence: ${rail.evidence})`;
        })
        .join("\n")
    );
    sections.push(
      "A struck-through phase is OFF for that kind — record it as off, never as a silent pass. " +
        "Each phase runs under its bound skill from the phase-skill registry; per-kind overrides win."
    );
  }
  sections.push("### Reply duty");
  sections.push(
    "End every reply with a routing token on its own line: " +
      "`[route: <target-id> | rule: <rule-id> | profile: <name>]`. " +
      "The gateway diff-checks this token against the route it resolved and logs honored:false on a mismatch."
  );
  return sections.join("\n\n") + "\n";
}
