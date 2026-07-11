// routing-core.mjs — the pure, dependency-free heart of the Model Router.
//
// Two responsibilities, both deterministic (NO Date.now / Math.random / I/O):
//   1. resolveRoute(config, profile, classification) -> a ROLE then a TARGET.
//      Stage A's gateway calls this after the warm classifier returns
//      {taskType, tier, matchedException?}. The LLM only classifies; this
//      resolution is pure code (brief §2 "both lookups are deterministic").
//   2. compileRouting(config, profile) -> the routing.md markdown section the
//      assembly pipeline injects via {{routing}} (brief §2 "routing section
//      enters the prompt through the assembly pipeline only"). Byte-stable so
//      pending-restart == (compiled bytes != loaded bytes).
//
// The v4 frame (BRIEF v4 §A): the matrix + exceptions resolve to a ROLE
// (fixed vocabulary), shared across Profiles; a Profile is just its
// roleMap (role -> target id) + discipline overrides. Swapping provider or
// going local changes only the map, never the policy.

import {
  isV2,
  migrateRoutingConfig,
  validatePolicyConfig,
  resolveRouteV2,
  resolveDisciplineV2,
  compileRoutingV2,
  routingMarkerV2,
  compilePolicy,
  stableStringify,
  railFor,
  inferPhasePlan,
  biasTarget,
  resolvePhaseTarget,
  classifyExecution,
  isSignificantAutonomous,
  buildAutonomousCardPayload,
  PHASES,
  TASK_TYPES_V2,
  POLICY_VERSION,
  SEED_PROVIDERS,
  ensureProviders,
  validateProviders
} from "./policy-core.mjs";

// v2 policy API re-exported so dynamic importers (runner, gateway, server)
// keep a single entry module.
export {
  isV2,
  migrateRoutingConfig,
  validatePolicyConfig,
  resolveRouteV2,
  resolveDisciplineV2,
  compileRoutingV2,
  routingMarkerV2,
  compilePolicy,
  stableStringify,
  railFor,
  inferPhasePlan,
  biasTarget,
  resolvePhaseTarget,
  classifyExecution,
  isSignificantAutonomous,
  buildAutonomousCardPayload,
  PHASES,
  TASK_TYPES_V2,
  POLICY_VERSION,
  SEED_PROVIDERS,
  ensureProviders,
  validateProviders
};

export const ROLES = ["expert", "standard", "fast", "image", "video", "review"];
export const TASK_TYPES = ["code", "review", "research", "image", "video", "writing", "ops", "other"];
export const TIERS = ["T0-trivial", "T1-standard", "T2-deep"];
export const CONTINUATION_KINDS = ["plan", "report", "document", "code-change", "other"];
export const CONTINUATION_VERBS = ["store", "ask", "route", "notify"];
export const DISCIPLINE_FIELDS = ["review", "testing", "evidence", "distribution"];

export const ROUTING_VERSION = 1;

function activeProfileName(config, profile) {
  return profile || config.activeProfile || Object.keys(config.profiles || {})[0];
}

function getProfile(config, profile) {
  const name = activeProfileName(config, profile);
  const p = (config.profiles || {})[name];
  if (!p) throw new Error(`routing: unknown profile "${name}"`);
  return { name, profile: p };
}

// ── Resolution (Stage A pure code) ──────────────────────────────────────────
// Procedure (brief §2, deterministic): ordered exceptions (first match wins)
// -> matrix cell -> inheritance (cell > row default > column default > global
// default) -> a ROLE; then the active Profile's roleMap resolves role ->
// target. The classifier supplies matchedException (an exception id) when an
// exception condition fired, plus {taskType, tier}.
export function resolveRole(config, classification) {
  const { taskType, tier, matchedException } = classification || {};
  const exceptions = config.exceptions || [];
  if (matchedException) {
    const ex = exceptions.find((e) => e.id === matchedException);
    if (ex) return { role: ex.role, ruleId: `exception:${ex.id}`, via: "exception" };
  }
  const matrix = config.matrix || {};
  const row = (matrix.rows || {})[taskType];
  if (row && row.cells && Object.prototype.hasOwnProperty.call(row.cells, tier)) {
    return { role: row.cells[tier], ruleId: `cell:${taskType}/${tier}`, via: "cell" };
  }
  if (row && row.default) {
    return { role: row.default, ruleId: `row:${taskType}`, via: "row-default" };
  }
  const col = (matrix.columns || {})[tier];
  if (col) return { role: col, ruleId: `col:${tier}`, via: "column-default" };
  const globalRole = (matrix.defaults && matrix.defaults.role) || "standard";
  return { role: globalRole, ruleId: "default", via: "global-default" };
}

export function resolveRoute(config, profile, classification) {
  if (isV2(config)) return resolveRouteV2(config, profile, classification);
  const { name, profile: p } = getProfile(config, profile);
  const { role, ruleId, via } = resolveRole(config, classification);
  const targetId = (p.roleMap || {})[role];
  const target = (config.targets || []).find((t) => t.id === targetId) || null;
  return { profile: name, role, ruleId, via, targetId: targetId || null, target };
}

// ── Mode bias (modes faculty) ───────────────────────────────────────────────
// The modes faculty (Gary/Joe/James) nudges the resolved COMPUTE-tier role per
// the mode's routing bias, WITHOUT mutating the router policy. The router stays
// the single source of truth for task-type x tier -> role; this is an
// identity-adjacent adjustment the gateway applies AFTER resolveRole/resolveRoute.
// Task-specific roles (image/video/review) are never biased — they are
// determined by the task, not the persona.
const COMPUTE_RANK = { fast: 0, standard: 1, expert: 2 };
const RANK_ROLE = ["fast", "standard", "expert"];

// Pure: bias a role given a mode's {floor, prefer}. `floor` raises a too-cheap
// role up (Joe's expert floor); when the router lands on the global-default
// 'standard' and the mode prefers cheaper, dial down toward `prefer` (Gary's
// "standard toward fast"). A role that already resolved to a higher tier than the
// floor is never lowered (a genuinely hard task keeps its tier).
export function biasRole(role, bias) {
  if (!(role in COMPUTE_RANK) || !bias) return role;
  let rank = COMPUTE_RANK[role];
  if (role === "standard" && bias.prefer in COMPUTE_RANK && COMPUTE_RANK[bias.prefer] < rank) {
    rank = COMPUTE_RANK[bias.prefer];
  }
  if (bias.floor in COMPUTE_RANK && COMPUTE_RANK[bias.floor] > rank) {
    rank = COMPUTE_RANK[bias.floor];
  }
  return RANK_ROLE[rank];
}

// Look up a mode's bias ({floor, prefer}) from a modes config (modes.json shape:
// { modes: { <mode>: { routingBias: <name> } }, routingBias: { <name>: {floor, prefer} } }).
export function modeBiasFor(mode, modesConfig) {
  const biasName = modesConfig && modesConfig.modes && modesConfig.modes[mode]
    ? modesConfig.modes[mode].routingBias
    : null;
  return (biasName && modesConfig.routingBias && modesConfig.routingBias[biasName]) || null;
}

// NOTE: the route+target variant (bias a resolved route, then re-map its target
// through the profile roleMap) lands with the orchestrator-mode↔routing
// unification — when preRoute runs WITH a mode in scope. Until then the live
// application is at assembly time: src/lib/souls.ts uses biasRole + modeBiasFor to
// compute each mode's nominal tier and bakes per-mode tier guidance into the
// orchestrator's delegation prompt (so the orchestrator spawns each soul at its
// mode's tier). Building the route variant now would be dead code (YAGNI).

// Merge per-tier discipline defaults with the active profile's overrides.
export function resolveDiscipline(config, profile, tier) {
  if (isV2(config)) return resolveDisciplineV2(config, profile, tier);
  const { profile: p } = getProfile(config, profile);
  const base = (config.discipline || {})[tier] || {};
  const over = (p.disciplineOverrides || {})[tier] || {};
  const out = {};
  for (const f of DISCIPLINE_FIELDS) out[f] = over[f] ?? base[f] ?? "none";
  return out;
}

// ── Compilation (the routing.md section) ─────────────────────────────────────
function targetLabel(config, targetId) {
  const t = (config.targets || []).find((x) => x.id === targetId);
  if (!t) return `${targetId} (UNDEFINED TARGET)`;
  if (t.type === "secondary") return `delegate to secondary runtime \`${t.runtime}\``;
  if (t.type === "workflow") return `run workflow \`${t.workflow || t.id}\``;
  // runtime-target
  const bits = [t.runtime, t.provider, t.model, t.effort].filter(Boolean).join(" / ");
  return `${bits}${t.soul ? ` (soul: ${t.soul})` : ""}`;
}

function renderRoleMap(config, profileName) {
  const { profile: p } = getProfile(config, profileName);
  const lines = [];
  for (const role of ROLES) {
    const tid = (p.roleMap || {})[role];
    if (!tid) continue;
    lines.push(`- **${role}** → \`${tid}\` — ${targetLabel(config, tid)}`);
  }
  return lines.join("\n");
}

function renderTiers(config) {
  const defs = config.tierDefinitions || {};
  return TIERS.map((t) => `- **${t}** — ${defs[t] || "(no definition)"}`).join("\n");
}

function renderExceptions(config) {
  const ex = config.exceptions || [];
  if (!ex.length) return "_(none)_";
  return ex.map((e, i) => `${i + 1}. \`${e.id}\` — WHEN ${e.when} → role **${e.role}**`).join("\n");
}

function renderMatrix(config) {
  const matrix = config.matrix || {};
  const rows = matrix.rows || {};
  const header = `| task-type | ${TIERS.join(" | ")} | row-default |`;
  const sep = `|${"---|".repeat(TIERS.length + 2)}`;
  const body = TASK_TYPES.map((tt) => {
    const row = rows[tt] || {};
    const cells = TIERS.map((tier) => {
      if (row.cells && Object.prototype.hasOwnProperty.call(row.cells, tier)) return row.cells[tier];
      return "·";
    });
    return `| ${tt} | ${cells.join(" | ")} | ${row.default || "·"} |`;
  });
  const colDefaults = `| _column-default_ | ${TIERS.map((t) => (matrix.columns || {})[t] || "·").join(" | ")} | ${(matrix.defaults && matrix.defaults.role) || "standard"} |`;
  return [header, sep, ...body, colDefaults].join("\n");
}

// Map a discipline field value to the garrison-* verb-skill that satisfies it —
// the decomposed build-discipline parts the orchestrator invokes (deliverable #1).
// One skill family (garrison-*); a higher tier escalates the skill set;
// "none"/"text" need no skill.
function disciplineSkill(field, value) {
  if (!value || value === "none") return null;
  if (field === "testing") return "garrison-test"; // tests / full-gates
  if (field === "review") {
    // ux-qa is UI-only — annotate it as CONDITIONAL, not a blanket second gate on
    // every deep task (a non-UI deep change needs code-review, not a UI audit).
    return String(value).startsWith("review-by")
      ? "code-review (+ garrison-ux-qa for UI changes)"
      : "code-review";
  }
  // evidence:video is recorded by garrison-walkthrough (NOT run-garrison, which is
  // only an app launcher — corrects the prior mapping).
  if (field === "evidence") return value === "video" ? "garrison-walkthrough" : null;
  if (field === "distribution") return value === "link" ? "garrison-validate (record + link)" : null;
  return null;
}

function renderDiscipline(config, profileName) {
  const lines = [];
  const ann = (field, value) => {
    const s = disciplineSkill(field, value);
    return s ? `${value} → ${s}` : value;
  };
  for (const tier of TIERS) {
    const d = resolveDiscipline(config, profileName, tier);
    lines.push(
      `- **${tier}** — review: ${ann("review", d.review)}; testing: ${ann("testing", d.testing)}; evidence: ${ann("evidence", d.evidence)}; distribution: ${ann("distribution", d.distribution)}`
    );
  }
  return lines.join("\n");
}

function renderContinuationStep(config, profileName, step) {
  if (step.verb === "store") return "write the output to the Artifact Store";
  if (step.verb === "ask") return `ask the user: "${step.arg || "Continue?"}" (everything after is gated on yes)`;
  if (step.verb === "notify") return `notify channel \`${step.arg || "?"}\``;
  if (step.verb === "route") {
    return `chain into routing target \`${step.arg}\` — ${targetLabel(config, step.arg)}`;
  }
  return `${step.verb} ${step.arg || ""}`.trim();
}

function renderContinuations(config, profileName) {
  const conts = config.continuations || [];
  if (!conts.length) return "_(none)_";
  return conts
    .map((c) => {
      const seq = (c.then || []).map((s) => renderContinuationStep(config, profileName, s)).join(", then ");
      return `- WHEN this turn produced a **${c.when}** → ${seq}`;
    })
    .join("\n");
}

export function routingMarker(profileName, version = ROUTING_VERSION) {
  return `<!-- garrison:routing v${version} profile=${profileName} -->`;
}

export function compileRouting(config, profile) {
  if (isV2(config)) return compileRoutingV2(config, profile);
  const { name } = getProfile(config, profile);
  const preRoute = ((config.profiles || {})[name] || {}).preRoute ?? "on";
  const sections = [];
  sections.push(routingMarker(name));
  sections.push("## Routing policy");
  sections.push(
    `Active Profile: **${name}** (preRoute: ${preRoute}). The gateway pre-routes every inbound ` +
      `message: the warm classifier returns {taskType, tier}, pure code resolves a **role** ` +
      `via the policy below, and this Profile's role-map resolves the role to a concrete target. ` +
      `You do not choose your own model — the gateway has already placed this turn on the resolved target.`
  );
  sections.push("### Role → target (this Profile)");
  sections.push(renderRoleMap(config, name));
  sections.push("### Tier definitions");
  sections.push(renderTiers(config));
  sections.push("### Exceptions (ordered — first match wins, resolves to a role)");
  sections.push(renderExceptions(config));
  sections.push("### Matrix (task-type × tier → role; inheritance: cell > row > column > default)");
  sections.push(renderMatrix(config));
  sections.push("### Discipline (post-task duties by tier)");
  sections.push(renderDiscipline(config, name));
  sections.push("### Continuations (post-task, by output kind)");
  sections.push(renderContinuations(config, name));
  sections.push("### Reply duty");
  sections.push(
    "End every reply with a routing token on its own line: " +
      "`[route: <target-id> | rule: <rule-id> | profile: <name>]`. " +
      "The gateway diff-checks this token against the route it resolved and logs honored:false on a mismatch."
  );
  // Trailing newline for byte-stable concatenation into the assembled prompt.
  return sections.join("\n\n") + "\n";
}

// ── Stage A classification (warm classifier prompt + response parser) ────────
// The gateway asks the pinned warm classifier ONE short question per inbound
// prompt; the model only classifies, code resolves. buildClassifierPrompt is
// pure (deterministic given the config + prompt) so the simulator IS Stage A.
export function buildClassifierPrompt(config, userPrompt) {
  const taskTypes = config.taskTypes || TASK_TYPES;
  const tiers = config.tiers || TIERS;
  const tierDefs = config.tierDefinitions || {};
  const exceptions = config.exceptions || [];
  const lines = [];
  lines.push(
    "You are a routing classifier. Classify the user task below. Respond with ONLY a single-line JSON object, no prose, no code fence."
  );
  lines.push("");
  lines.push(`taskType — one of: ${taskTypes.join(", ")}`);
  lines.push(`tier — one of: ${tiers.join(", ")}, where:`);
  for (const t of tiers) lines.push(`  - ${t}: ${tierDefs[t] || "(no definition)"}`);
  if (exceptions.length) {
    lines.push("matchedException — the id of the FIRST matching exception condition, else null:");
    for (const e of exceptions) lines.push(`  - ${e.id}: ${e.when}`);
  }
  lines.push("contextKind — optional short string describing the context, else omit.");
  lines.push(
    'execution — "autonomous" ONLY when the user explicitly asks for unattended/background/pipeline execution ' +
      '("run this in the background", "kick off a build", "do this autonomously", "queue this up"); ' +
      'otherwise "interactive" (the default for conversation and ordinary requests).'
  );
  lines.push("");
  lines.push('Respond exactly like: {"taskType":"code","tier":"T1-standard","matchedException":null,"contextKind":"bugfix","execution":"interactive"}');
  lines.push("");
  lines.push(`Task: """${String(userPrompt).slice(0, 4000)}"""`);
  return lines.join("\n");
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  // Prefer a fenced ```json block, else the first balanced {...}.
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidate = fence ? fence[1] : null;
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Parse + clamp a classifier reply to a valid Classification. Clamps an
// out-of-vocabulary taskType to "other" and tier to "T1-standard" (an LLM may
// return a near-miss); drops an unknown matchedException to null. Returns null
// ONLY when no JSON object is present (total failure → gateway routes default).
export function parseClassification(replyText, config) {
  const obj = extractJsonObject(replyText);
  if (!obj || typeof obj !== "object") return null;
  const taskTypes = config.taskTypes || TASK_TYPES;
  const tiers = config.tiers || TIERS;
  const exIds = new Set((config.exceptions || []).map((e) => e.id));
  const taskType = taskTypes.includes(obj.taskType) ? obj.taskType : "other";
  const tier = tiers.includes(obj.tier) ? obj.tier : "T1-standard";
  const matchedException = obj.matchedException && exIds.has(obj.matchedException) ? obj.matchedException : null;
  const contextKind = typeof obj.contextKind === "string" ? obj.contextKind : undefined;
  // D8: the classifier's own execution read; out-of-vocab clamps to interactive.
  const execution = obj.execution === "autonomous" ? "autonomous" : "interactive";
  return { taskType, tier, matchedException, contextKind, execution };
}

// Validate a routing config enough to fail loudly at compile/--check time.
export function validateRoutingConfig(config) {
  if (isV2(config)) return validatePolicyConfig(config);
  const errors = [];
  if (!config || typeof config !== "object") return ["config is not an object"];
  if (config.version !== ROUTING_VERSION) errors.push(`version must be ${ROUTING_VERSION}`);
  if (!config.profiles || !Object.keys(config.profiles).length) errors.push("no profiles defined");
  if (!config.activeProfile) errors.push("no activeProfile");
  else if (!(config.profiles || {})[config.activeProfile]) errors.push(`activeProfile "${config.activeProfile}" not in profiles`);
  const targetIds = new Set((config.targets || []).map((t) => t.id));
  for (const [pname, p] of Object.entries(config.profiles || {})) {
    for (const role of ROLES) {
      const tid = (p.roleMap || {})[role];
      if (tid && !targetIds.has(tid)) errors.push(`profile ${pname}: role ${role} -> unknown target ${tid}`);
    }
  }
  // Matrix + exception roles must be in the fixed vocabulary.
  for (const e of config.exceptions || []) {
    if (!ROLES.includes(e.role)) errors.push(`exception ${e.id}: role ${e.role} not in vocabulary`);
  }
  const rows = (config.matrix || {}).rows || {};
  for (const [tt, row] of Object.entries(rows)) {
    for (const [tier, role] of Object.entries(row.cells || {})) {
      if (!ROLES.includes(role)) errors.push(`matrix ${tt}/${tier}: role ${role} not in vocabulary`);
    }
    if (row.default && !ROLES.includes(row.default)) errors.push(`matrix ${tt} row-default: ${row.default} not in vocabulary`);
  }
  return errors;
}
