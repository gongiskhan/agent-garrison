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

// ── Providers as policy data (GARRISON-RUNTIMES-V1 P2/D2) ───────────────────
// The provider registry is POLICY DATA, not code. Each entry names an
// Anthropic-compatible endpoint: id, kind (anthropic-plan | local | cloud-oss),
// baseUrl (null ONLY for the anthropic-plan Max-OAuth path), vaultKey for the
// auth credential (or dummyToken for local endpoints that ignore auth), notes.
// SEED_PROVIDERS reproduces the four historical hardcoded entries byte-for-byte
// in behavior; migration seeds them so existing routing resolves identically.
export const SEED_PROVIDERS = [
  { id: "anthropic-plan", kind: "anthropic-plan", baseUrl: null, notes: "Max OAuth, no base URL, no key" },
  // The agent-sdk runtime's historical id for the same Max-OAuth endpoint —
  // live seed targets (agent-sdk-haiku-fast) reference it, so migration seeds
  // it too (brief said four; reality's target space needs this fifth id).
  { id: "anthropic", kind: "anthropic-plan", baseUrl: null, notes: "agent-sdk id for the Anthropic Max OAuth endpoint" },
  { id: "ollama-local", kind: "local", baseUrl: "http://localhost:11434", dummyToken: "ollama", notes: "local Ollama Anthropic-compatible endpoint" },
  { id: "deepseek", kind: "cloud-oss", baseUrl: "https://api.deepseek.com/anthropic", vaultKey: "DEEPSEEK_API_KEY" },
  { id: "zai-glm", kind: "cloud-oss", baseUrl: "https://api.z.ai/api/anthropic", vaultKey: "ZAI_API_KEY" }
];

export const PROVIDER_KINDS = ["anthropic-plan", "local", "cloud-oss"];

// ── Primary runtime selection (GARRISON-RUNTIMES-V1 P3/D4) ──────────────────
// The policy file names WHICH composed runtime fitting hosts the orchestrator
// loop. Default: the Claude Code runtime. The composer writes this key; the
// runner and the gateway pool read it. Validation of "is that fitting actually
// composed/installed" happens where composition data exists (the own-port
// server's PUT guard + the runner's resolvePrimaryRuntime) — the pure layer
// only guards the shape.
export const DEFAULT_PRIMARY_RUNTIME_ID = "claude-code-runtime";

export function primaryRuntimeOf(config) {
  const raw = config && typeof config === "object" ? config.primaryRuntime : undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || DEFAULT_PRIMARY_RUNTIME_ID;
}

// Migration shim: a config authored before the providers section gains the
// seed entries (pure; the caller/writer logs the migration). A config that
// already carries providers is returned untouched — the file owns the list.
export function ensureProviders(config) {
  if (!config || typeof config !== "object") return config;
  if (Array.isArray(config.providers) && config.providers.length) return config;
  return { ...config, providers: SEED_PROVIDERS.map((p) => ({ ...p })) };
}

export function validateProviders(providers) {
  const errors = [];
  if (providers === undefined) return errors; // pre-migration config; ensureProviders seeds
  if (!Array.isArray(providers)) return ["providers must be an array"];
  const seen = new Set();
  for (const p of providers) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id.length) {
      errors.push(`provider entry invalid: ${JSON.stringify(p)}`);
      continue;
    }
    if (seen.has(p.id)) errors.push(`provider ${p.id}: duplicate id`);
    seen.add(p.id);
    if (p.kind !== undefined && !PROVIDER_KINDS.includes(p.kind)) {
      errors.push(`provider ${p.id}: unknown kind "${p.kind}" (expected ${PROVIDER_KINDS.join("|")})`);
    }
    if (p.baseUrl !== null && p.baseUrl !== undefined && typeof p.baseUrl !== "string") {
      errors.push(`provider ${p.id}: baseUrl must be a string or null`);
    }
    if ((p.baseUrl === null || p.baseUrl === undefined) && p.kind !== "anthropic-plan") {
      errors.push(`provider ${p.id}: baseUrl is required for kind "${p.kind ?? "(unset)"}" (only anthropic-plan runs without one)`);
    }
    if (p.vaultKey !== undefined && (typeof p.vaultKey !== "string" || !p.vaultKey.length)) {
      errors.push(`provider ${p.id}: vaultKey must be a non-empty string when present`);
    }
  }
  return errors;
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

  const migrated = ensureProviders({
    version: 2,
    activeProfile,
    taskTypes: Array.from(new Set([...(v1.taskTypes || GENERAL_TASK_TYPES), ...TASK_TYPES_V2])),
    tiers: v1.tiers || TIERS,
    tierDefinitions: v1.tierDefinitions || {},
    exceptions,
    // Providers ride through from a v1 file that already carries them;
    // ensureProviders seeds the four historical entries otherwise (P2 migration).
    ...(Array.isArray(v1.providers) && v1.providers.length ? { providers: v1.providers } : {}),
    targets: v1.targets || [],
    profiles,
    discipline: v1.discipline || {},
    continuations: v1.continuations || [],
    phases: [...PHASES],
    phasePlans: {},
    workKinds: {},
    defaultWorkKind: null,
    phaseSkills: { bindings: {}, overrides: {} }
  });
  // v1 targets could carry informational provider ids (e.g. secondary targets
  // with "google"/"openai") that the v2 providers section does not know — the
  // v2 validator rejects those at compile. Secondaries auth CLI-natively, so a
  // provider id with no providers-section entry is dropped, not invented.
  const knownProviders = new Set((migrated.providers || []).map((p) => p && p.id));
  migrated.targets = (migrated.targets || []).map((t) => {
    if (t && t.provider !== undefined && t.provider !== null && !knownProviders.has(t.provider)) {
      const { provider: _dropped, ...rest } = t;
      return rest;
    }
    return t;
  });
  return migrated;
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

// A matrix cell/default is either a bare target-id string (historical) or an
// object ref {target, effort?} — the duty-derived form (GARRISON duties
// repoint), where the EFFORT lives on the cell because one target (e.g.
// cc-sonnet) serves different duties at different efforts. Normalizes to
// {target, effort} or null.
export function cellRef(value) {
  if (typeof value === "string" && value.length) return { target: value, effort: null };
  if (value && typeof value === "object" && typeof value.target === "string" && value.target.length) {
    return { target: value.target, effort: typeof value.effort === "string" && value.effort.length ? value.effort : null };
  }
  return null;
}

export function resolveTargetId(config, profileName, classification) {
  const { profile: p } = getProfileV2(config, profileName);
  const { taskType, tier, matchedException } = classification || {};
  if (matchedException) {
    const ex = (config.exceptions || []).find((e) => e.id === matchedException);
    if (ex) {
      const overridden = (p.exceptionOverrides || {})[ex.id];
      return { targetId: overridden || ex.target, ruleId: `exception:${ex.id}`, via: "exception", effort: null };
    }
  }
  const matrix = p.matrix || {};
  const row = (matrix.rows || {})[taskType];
  if (row && row.cells && Object.prototype.hasOwnProperty.call(row.cells, tier)) {
    const ref = cellRef(row.cells[tier]);
    if (ref) return { targetId: ref.target, ruleId: row.cells[tier]?.rule ?? `cell:${taskType}/${tier}`, via: "cell", effort: ref.effort };
  }
  if (row && row.default) {
    const ref = cellRef(row.default);
    if (ref) return { targetId: ref.target, ruleId: `row:${taskType}`, via: "row-default", effort: ref.effort };
  }
  const col = cellRef((matrix.columns || {})[tier]);
  if (col) return { targetId: col.target, ruleId: `col:${tier}`, via: "column-default", effort: col.effort };
  const def = cellRef((matrix.defaults || {}).target);
  return { targetId: def?.target || null, ruleId: "default", via: "global-default", effort: def?.effort ?? null };
}

export function ladderLabelFor(config, profileName, targetId) {
  const { profile: p } = getProfileV2(config, profileName);
  const idx = (p.computeLadder || []).indexOf(targetId);
  return idx >= 0 ? LADDER_LABELS[Math.min(idx, LADDER_LABELS.length - 1)] : null;
}

export function resolveRouteV2(config, profile, classification) {
  const { name } = getProfileV2(config, profile);
  const { targetId, ruleId, via, effort: cellEffort } = resolveTargetId(config, name, classification);
  const base = (config.targets || []).find((t) => t.id === targetId) || null;
  // A cell-level effort OVERLAYS the target's own: the returned target IS the
  // effective spec, so the switch planner (/effort inject), the decision log,
  // and the done-event attribution all see the duty cell's effort with no
  // extra plumbing. The config's target entry itself is never mutated.
  const target = base && cellEffort ? { ...base, effort: cellEffort } : base;
  const role = ladderLabelFor(config, name, targetId) || (classification || {}).taskType || null;
  return { profile: name, role, ruleId, via, targetId: targetId || null, target, effort: target?.effort ?? cellEffort ?? null };
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
// no named kind). Pure + recorded by the caller on the card. `plan` is always
// on: a goal card enters the pipeline through the Plan list, so a rail that
// omitted it would fast-forward straight past the phase the run starts in.
// Order comes from PHASES (pipeline order), never from insertion order.
export function inferPhasePlan(config, profileName, tier) {
  const d = resolveDisciplineV2(config, profileName, tier);
  const on = new Set(["plan", "implement"]);
  if (d.testing !== "none") on.add("test");
  if (d.testing === "full-gates") {
    on.add("adversarial-test");
    on.add("ux-qa");
    on.add("validate");
    on.add("codex-checkpoint");
  }
  if (d.review !== "none") on.add("review");
  if (String(d.review).startsWith("review-by")) on.add("adversarial-review");
  if (d.evidence === "video") on.add("walkthrough");
  if (d.distribution !== "none") {
    on.add("validate");
    on.add("report");
  }
  const evidence = d.evidence === "video" ? "video" : d.evidence === "none" ? "none" : d.evidence === "text" ? "text" : "logs";
  return { inferred: true, tier, evidence, phases: PHASES.filter((id) => on.has(id)).map((id) => ({ id, on: true })) };
}

// The card-toggle map for an inferred plan: every pipeline phase the plan
// leaves OFF becomes {phase: false} — the shape buildAutonomousCardPayload's
// `phases` field and the engine's rail merge already speak (D17). Returns null
// when nothing is off (an all-on plan needs no toggles on the card).
export function phaseTogglesFor(inferredPlan) {
  const onIds = new Set((inferredPlan?.phases || []).map((p) => (typeof p === "string" ? p : p.id)));
  const toggles = {};
  for (const id of PHASES) if (!onIds.has(id)) toggles[id] = false;
  return Object.keys(toggles).length ? toggles : null;
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

  // Primary runtime (P3): shape-guard only — a non-string or empty explicit
  // value is a config bug; whether the named fitting is composed is validated
  // by the writer (server PUT) and the runner, which hold composition data.
  if (config.primaryRuntime !== undefined && (typeof config.primaryRuntime !== "string" || !config.primaryRuntime.trim().length)) {
    errors.push(`primaryRuntime must be a non-empty string when present (got ${JSON.stringify(config.primaryRuntime)})`);
  }

  // Providers section (P2): entries well-formed, and every target that names a
  // provider names a KNOWN one — an unknown provider id must fail compile, not
  // surface as a launch-time lookup miss.
  errors.push(...validateProviders(config.providers));
  if (Array.isArray(config.providers) && config.providers.length) {
    const providerIds = new Set(config.providers.map((p) => p && p.id));
    for (const t of config.targets || []) {
      if (t && t.provider !== undefined && t.provider !== null && !providerIds.has(t.provider)) {
        errors.push(`target ${t.id}: unknown provider "${t.provider}" (known: ${[...providerIds].join(", ")})`);
      }
    }
  }

  for (const e of config.exceptions || []) {
    if (e.target && !targetIds.has(e.target)) errors.push(`exception ${e.id}: unknown target ${e.target}`);
  }
  for (const [pname, p] of Object.entries(config.profiles || {})) {
    const m = p.matrix || {};
    // A cell value is a target-id string or an object ref {target, effort?}
    // (duty-derived cells). Both resolve through cellRef; anything else, or a
    // ref naming an unknown target, is a config bug.
    const check = (value, where) => {
      if (value === undefined || value === null) return;
      const ref = cellRef(value);
      if (!ref) {
        errors.push(`profile ${pname}: ${where} -> invalid cell ${JSON.stringify(value)} (expected a target id or {target, effort})`);
        return;
      }
      if (!targetIds.has(ref.target)) errors.push(`profile ${pname}: ${where} -> unknown target ${ref.target}`);
      if (value && typeof value === "object" && value.effort !== undefined && value.effort !== null && typeof value.effort !== "string") {
        errors.push(`profile ${pname}: ${where} -> effort must be a string when present`);
      }
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
  // Coordination section (GARRISON-FLOW-V2 S6): optional, but when present its
  // types must hold — the compiled policy is what the kanban engine reads, so a
  // mistyped threshold or a non-string lease path would break coordination
  // silently. Reject on the PUT instead (the composer reverts + shows why).
  const coord = config.coordination;
  if (coord !== undefined) {
    if (typeof coord !== "object" || coord === null || Array.isArray(coord)) {
      errors.push("coordination must be an object");
    } else {
      if ("enabled" in coord && typeof coord.enabled !== "boolean") errors.push("coordination.enabled must be a boolean");
      if ("serializeWhenUnavailable" in coord && typeof coord.serializeWhenUnavailable !== "boolean")
        errors.push("coordination.serializeWhenUnavailable must be a boolean");
      if (coord.thresholds !== undefined) {
        const th = coord.thresholds;
        if (typeof th !== "object" || th === null) errors.push("coordination.thresholds must be an object");
        else {
          if ("heavyFiles" in th && !(Number.isFinite(th.heavyFiles) && th.heavyFiles >= 1))
            errors.push("coordination.thresholds.heavyFiles must be a number >= 1");
          if ("heavyRatio" in th && !(Number.isFinite(th.heavyRatio) && th.heavyRatio > 0 && th.heavyRatio <= 1))
            errors.push("coordination.thresholds.heavyRatio must be a number in (0, 1]");
        }
      }
      if (coord.exclusiveLeases !== undefined) {
        if (!Array.isArray(coord.exclusiveLeases) || coord.exclusiveLeases.some((p) => typeof p !== "string"))
          errors.push("coordination.exclusiveLeases must be an array of strings");
      }
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
  const cfg = ensureProviders(isV2(config) ? config : migrateRoutingConfig(config));
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
      const { targetId, ruleId, effort: cellEffort } = resolveTargetId(cfg, name, { taskType: tt, tier });
      const t = targetsById[targetId] || null;
      matrix[tt][tier] = {
        targetId: targetId || null,
        rule: ruleId,
        type: t?.type ?? null,
        runtime: t?.runtime ?? null,
        provider: t?.provider ?? null,
        model: t?.model ?? null,
        // Cell-level effort (duty-derived cells) wins over the target's own —
        // the same overlay resolveRouteV2 applies at turn time.
        effort: cellEffort ?? t?.effort ?? null
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
    // Providers as policy data (P2): the compiled policy is THE consumption
    // interface, so launch-env building reads providers from here — never from
    // a code constant. ensureProviders above guarantees the section exists.
    providers: cfg.providers,
    // Primary runtime (P3/D4): which composed runtime fitting hosts the
    // orchestrator loop. The gateway pool reads this at warm time.
    primaryRuntime: primaryRuntimeOf(cfg),
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
    uxQa: cfg.uxQa || { severityThreshold: "major" },
    // Coordination (GARRISON-FLOW-V2 S6): carried through ONLY when the config
    // declares it, so the kanban engine's `Boolean(policy.coordination)` gate
    // stays OFF for a policy that predates the composer (a stripped/legacy
    // config never coordinates), and turns ON the moment the composer seeds the
    // section. The composer surfaces enabled / thresholds / exclusiveLeases /
    // serializeWhenUnavailable; fences + leaseTtlMinutes pass through verbatim.
    ...(cfg.coordination && typeof cfg.coordination === "object" ? { coordination: cfg.coordination } : {})
  };
}

// ── Duties drive the matrix (the "repoint" slice) ────────────────────────────
// The composition's duty ladders (Muster page, apm.yml x-garrison.composition)
// are the user-facing routing truth; the router matrix rows must derive from
// them or the Muster page lies. `dutyModel` is the runner-projected resolved
// model (~/.garrison/kanban-loop/model.json, kanban-model.ts) extended with
// per-duty per-level CELLS:
//   { cells: { <dutyId>: { "<level>": {target, effort, runtime, model, provider, type?} } } }
//
// Tier -> level rule: tier index k (in config.tiers order) uses ladder rung
// min(k+1, ladder length) — T0-trivial -> L1, T1-standard -> L2, T2-deep -> L3,
// clamped to the duty's real ladder. This matches the Dispatcher's standard
// slot (defaultLevelFor = min(2, n)) for T1. A rung without a leaf cell (a
// composite level) falls DOWN to the nearest lower rung that has one.
//
// The derived row replaces the row in EVERY profile: duty ladders are
// composition-level truth, not a per-profile preference (profiles keep their
// other knobs — preRoute, ladder, exceptions, discipline overrides). Targets
// referenced by duty cells that the config does not know are appended from the
// cell's own spec (provider dropped when unknown, mirroring migration). Pure —
// returns a new config, never mutates.
export function applyDutyCells(config, dutyModel) {
  const cells = dutyModel && typeof dutyModel === "object" ? dutyModel.cells : null;
  if (!cells || typeof cells !== "object" || !Object.keys(cells).length) return config;
  const cfg = ensureProviders(isV2(config) ? config : migrateRoutingConfig(config));
  const taskTypes = new Set(cfg.taskTypes || TASK_TYPES_V2);
  const tiers = cfg.tiers || TIERS;
  const knownProviders = new Set((cfg.providers || []).map((p) => p && p.id));
  const targets = (cfg.targets || []).slice();
  const targetIds = new Set(targets.map((t) => t && t.id));

  const rows = {};
  for (const [duty, perLevel] of Object.entries(cells)) {
    if (!taskTypes.has(duty) || !perLevel || typeof perLevel !== "object") continue;
    const rungs = Object.keys(perLevel)
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
    if (!rungs.length) continue;
    const maxRung = rungs[rungs.length - 1];
    const cellAt = (rung) => {
      // Walk down from the mapped rung to the nearest one with a leaf cell.
      for (let r = rung; r >= 1; r--) {
        const spec = perLevel[String(r)];
        if (spec && typeof spec.target === "string" && spec.target.length) return { spec, rung: r };
      }
      return null;
    };
    const rowCells = {};
    for (let k = 0; k < tiers.length; k++) {
      const hit = cellAt(Math.min(k + 1, maxRung));
      if (!hit) continue;
      rowCells[tiers[k]] = {
        target: hit.spec.target,
        ...(hit.spec.effort ? { effort: hit.spec.effort } : {}),
        rule: `duty:${duty}/L${hit.rung}`
      };
      if (!targetIds.has(hit.spec.target)) {
        targetIds.add(hit.spec.target);
        targets.push({
          id: hit.spec.target,
          ...(hit.spec.runtime ? { runtime: hit.spec.runtime } : {}),
          ...(hit.spec.model ? { model: hit.spec.model } : {}),
          ...(hit.spec.provider && knownProviders.has(hit.spec.provider) ? { provider: hit.spec.provider } : {}),
          ...(hit.spec.type ? { type: hit.spec.type } : {})
        });
      }
    }
    if (!Object.keys(rowCells).length) continue;
    // Row default = the standard slot (the same rung T1 maps to), so an
    // out-of-vocab tier still lands on the duty's standard cell.
    const std = cellAt(Math.min(2, maxRung));
    rows[duty] = {
      cells: rowCells,
      ...(std ? { default: { target: std.spec.target, ...(std.spec.effort ? { effort: std.spec.effort } : {}) } } : {})
    };
  }
  if (!Object.keys(rows).length) return cfg;

  const profiles = {};
  for (const [name, p] of Object.entries(cfg.profiles || {})) {
    const matrix = p.matrix || {};
    profiles[name] = { ...p, matrix: { ...matrix, rows: { ...(matrix.rows || {}), ...rows } } };
  }
  return { ...cfg, targets, profiles };
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
// autonomous marker (the web-channel toggle, the garrison doorway) is
// autonomous; a multi-step cross-app automation shape is autonomous; otherwise
// THE CLASSIFIER decides (its reply now carries an `execution` field — see
// buildClassifierPrompt), with Gary-mode conversation flooring to interactive.
// NOTE (rev-s2 finding #2): there is deliberately NO task-type fallback here —
// the live classifier vocabulary is the general kinds, so keying autonomy on
// pipeline-verb task types was dead code with one false-positive ("review this
// diff" card-ifying an inline review). Ordinary chat work stays interactive
// unless an origin, an explicit marker, or the classifier itself says
// autonomous. Returns "interactive" | "autonomous".
const AUTONOMOUS_CHANNELS = new Set(["kanban", "scheduler", "board", "garrison"]);
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
// rather than run inline (the garrison scope test): a pipeline verb (reachable
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
export function buildAutonomousCardPayload({ brief, project, workKind, phases, taskType, tier, duty, level, sequence, originChannel } = {}) {
  return {
    description: brief || "",
    project: project || null,
    list: "backlog",
    goalMode: true,
    workKind: workKind || null,
    phases: phases || null,
    origin: "orchestrator",
    // The originating channel thread ({channel, threadId}), when the surface
    // identified one — the run engine posts the card's outcome back to it.
    originChannel: originChannel && typeof originChannel === "object" ? originChannel : null,
    classification: taskType && tier ? { taskType, tier } : null,
    // S4b completion (D15 acceptance 9): carry the resolved (duty, level) + its
    // ordered sequence onto the card so a gateway/skill-entered card FLOWS through
    // the IDENTICAL resolved sequence a board-entered card would (door-1
    // persistence). ALL THREE are gated on a RESOLVED sequence (codex S4b finding):
    // without a sequence the resolution is incomplete, so we keep the pre-S4b card
    // shape byte-for-byte rather than stamping a partial (duty, level).
    //
    // A goal card with NO dispatcher resolution still gets a bare `sequence` when
    // the caller derived one (the tier discipline's ON phases): without it the
    // card walks the board's LIST-UNION order — duty declaration order, not a
    // pipeline — and marches into whatever list happens to follow its last phase
    // (observed live: Test → Image). The sequence IS the card's rail.
    ...(Array.isArray(sequence) && sequence.length && duty && Number.isInteger(level)
      ? { duty, level, sequence }
      : Array.isArray(sequence) && sequence.length
        ? { sequence }
        : {})
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
