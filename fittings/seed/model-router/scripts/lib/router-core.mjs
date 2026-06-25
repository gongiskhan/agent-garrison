export const ROUTING_MARKER_PREFIX = "<!-- garrison:routing v1";
export const taskTypes = ["code", "review", "research", "image", "video", "writing", "ops", "other"];
export const routeTiers = ["T0-trivial", "T1-standard", "T2-deep"];
export const effortLevels = ["low", "medium", "high", "xhigh", "ultracode"];
export const targetTypes = ["native-model", "skill", "workflow", "ollama"];
export const continuationVerbs = ["store", "ask", "route", "notify"];

const taskTypeSet = new Set(taskTypes);
const tierSet = new Set(routeTiers);
const effortSet = new Set(effortLevels);
const targetTypeSet = new Set(targetTypes);
const verbSet = new Set(continuationVerbs);

export function validateRoutingConfig(config) {
  const errors = [];
  if (config?.version !== 1) errors.push("version must be 1");
  const targetIds = new Set();
  for (const target of config?.targets ?? []) {
    if (!isSlug(target.id)) errors.push(`target id is invalid: ${target.id}`);
    if (targetIds.has(target.id)) errors.push(`duplicate target id: ${target.id}`);
    targetIds.add(target.id);
    if (!targetTypeSet.has(target.type)) errors.push(`target ${target.id} has unknown type ${target.type}`);
    if (target.effort && !effortSet.has(target.effort)) errors.push(`target ${target.id} has unknown effort ${target.effort}`);
    if (target.type === "native-model" && !target.model) errors.push(`native target ${target.id} needs model`);
    if (target.type === "skill" && !target.providerModel) errors.push(`skill target ${target.id} needs providerModel`);
    if (target.type === "workflow" && !target.workflow) errors.push(`workflow target ${target.id} needs workflow`);
  }
  const profileIds = new Set();
  for (const profile of config?.profiles ?? []) {
    if (!isSlug(profile.id)) errors.push(`profile id is invalid: ${profile.id}`);
    if (profileIds.has(profile.id)) errors.push(`duplicate profile id: ${profile.id}`);
    profileIds.add(profile.id);
  }
  if (!profileIds.has(config?.activeProfile)) errors.push(`activeProfile not found: ${config?.activeProfile}`);
  for (const profile of config?.profiles ?? []) {
    if (profile.inherits && !profileIds.has(profile.inherits)) errors.push(`profile ${profile.id} inherits missing profile ${profile.inherits}`);
    if (!targetIds.has(profile.defaultTarget)) errors.push(`profile ${profile.id} defaultTarget missing: ${profile.defaultTarget}`);
    for (const exception of profile.exceptions ?? []) {
      if (!isSlug(exception.id)) errors.push(`profile ${profile.id} exception id invalid: ${exception.id}`);
      if (exception.taskType && !taskTypeSet.has(exception.taskType)) errors.push(`exception ${exception.id} taskType invalid: ${exception.taskType}`);
      if (exception.tier && !tierSet.has(exception.tier)) errors.push(`exception ${exception.id} tier invalid: ${exception.tier}`);
      if (!targetIds.has(exception.target)) errors.push(`exception ${exception.id} target missing: ${exception.target}`);
    }
    for (const [taskType, row] of Object.entries(profile.matrix ?? {})) {
      if (!taskTypeSet.has(taskType)) errors.push(`profile ${profile.id} matrix task invalid: ${taskType}`);
      for (const [tier, target] of Object.entries(row ?? {})) {
        if (!tierSet.has(tier)) errors.push(`profile ${profile.id} matrix tier invalid: ${tier}`);
        if (!targetIds.has(target)) errors.push(`profile ${profile.id} matrix ${taskType}/${tier} target missing: ${target}`);
      }
    }
    for (const tier of routeTiers) {
      if (!profile.discipline?.[tier]) errors.push(`profile ${profile.id} missing discipline for ${tier}`);
    }
    for (const rule of profile.continuations ?? []) {
      if (!isSlug(rule.id)) errors.push(`profile ${profile.id} continuation id invalid: ${rule.id}`);
      if (!verbSet.has(rule.verb)) errors.push(`profile ${profile.id} continuation ${rule.id} invalid verb ${rule.verb}`);
    }
  }
  return errors;
}

export function compileRoutingMarkdown(config, profileId = config.activeProfile) {
  const errors = validateRoutingConfig(config);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const profile = getProfile(config, profileId);
  const lines = [];
  lines.push(`${ROUTING_MARKER_PREFIX} profile=${profile.id} -->`);
  lines.push("# Model Routing Policy");
  lines.push("");
  lines.push(`Active profile: ${profile.id} (${profile.label})`);
  lines.push("");
  lines.push("Every assistant reply must end with `[route: <target-id> | rule: <id> | profile: <name>]`.");
  lines.push("The gateway pre-routes user prompts, writes telemetry, and may switch or restart the interactive Claude TUI to honor the selected target.");
  lines.push("Continue to preserve `[orchestrator-active]` in replies.");
  lines.push("");
  lines.push("## Targets");
  for (const target of config.targets) {
    const state = target.enabled === false ? "disabled" : "active";
    const details = targetDetails(target);
    lines.push(`- ${target.id} (${target.type}, ${state})${details ? ` - ${details}` : ""}`);
  }
  lines.push("");
  lines.push("## Matrix");
  for (const taskType of taskTypes) {
    const cells = routeTiers.map((tier) => {
      const route = resolveRouteId(config, profile, { taskType, tier }, "", new Set());
      return `${tier}: ${route.targetId} (${route.rule})`;
    });
    lines.push(`- ${taskType}: ${cells.join("; ")}`);
  }
  lines.push("");
  lines.push("## Ordered Exceptions");
  const exceptions = collectExceptions(config, profile);
  if (exceptions.length === 0) lines.push("- none");
  for (const item of exceptions) {
    const e = item.exception;
    const criteria = [
      e.taskType ? `taskType=${e.taskType}` : null,
      e.tier ? `tier=${e.tier}` : null,
      e.contextKind ? `contextKind=${e.contextKind}` : null,
      e.promptIncludes ? `promptIncludes=${JSON.stringify(e.promptIncludes)}` : null
    ].filter(Boolean).join(", ");
    lines.push(`- ${e.id} [${item.profileId}] -> ${e.target}${criteria ? ` when ${criteria}` : ""}`);
  }
  lines.push("");
  lines.push("## Discipline");
  for (const tier of routeTiers) {
    const d = resolveDiscipline(config, profile, tier);
    lines.push(`- ${tier}: review=${d.review}; testing=${d.testing}; evidence=${d.evidence}; distribution=${d.distribution}`);
  }
  lines.push("");
  lines.push("## Continuations");
  const continuations = collectContinuations(config, profile);
  if (continuations.length === 0) lines.push("- none");
  for (const item of continuations) {
    const c = item.rule;
    lines.push(`- ${c.id} [${item.profileId}] ${c.verb}: when ${c.when}; ${c.instruction}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function resolveRoute(config, classification, profileId = config.activeProfile, prompt = "") {
  const errors = validateRoutingConfig(config);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const profile = getProfile(config, profileId);
  const route = resolveRouteId(config, profile, classification, prompt, new Set());
  const target = config.targets.find((candidate) => candidate.id === route.targetId);
  if (!target) throw new Error(`resolved missing target: ${route.targetId}`);
  const honored = target.enabled !== false && target.type !== "ollama";
  return {
    classification,
    profile,
    target,
    matchedRule: route.rule,
    inheritedFrom: route.inheritedFrom,
    honored,
    mismatch: honored ? undefined : `target ${target.id} is disabled`
  };
}

export function parseClassifierReply(reply) {
  const parsed = JSON.parse(extractJsonObject(reply));
  if (!taskTypeSet.has(parsed.taskType)) throw new Error(`classifier returned invalid taskType: ${parsed.taskType}`);
  if (!tierSet.has(parsed.tier)) throw new Error(`classifier returned invalid tier: ${parsed.tier}`);
  return {
    taskType: parsed.taskType,
    tier: parsed.tier,
    ...(typeof parsed.contextKind === "string" ? { contextKind: parsed.contextKind } : {}),
    ...(typeof parsed.matchedException === "string" ? { matchedException: parsed.matchedException } : {})
  };
}

export function heuristicClassify(prompt) {
  const lower = prompt.toLowerCase();
  let taskType = "other";
  if (/\b(review|diff|pr|pull request)\b/.test(lower)) taskType = "review";
  else if (/\b(research|find|latest|source|cite)\b/.test(lower)) taskType = "research";
  else if (/\b(image|photo|picture|render|illustration)\b/.test(lower)) taskType = "image";
  else if (/\b(video|walkthrough|recording)\b/.test(lower)) taskType = "video";
  else if (/\b(write|draft|copy|email|doc)\b/.test(lower)) taskType = "writing";
  else if (/\b(deploy|ops|cron|incident|server|scheduler)\b/.test(lower)) taskType = "ops";
  else if (/\b(code|implement|fix|test|bug|refactor|typescript|python|api)\b/.test(lower)) taskType = "code";
  const tier =
    prompt.length < 120 && !/\b(deep|architecture|migration|end-to-end|e2e|full)\b/.test(lower)
      ? "T0-trivial"
      : /\b(deep|architecture|migration|security|full|e2e|end-to-end|critical)\b/.test(lower) || prompt.length > 1200
        ? "T2-deep"
        : "T1-standard";
  return { taskType, tier };
}

export function replyRouteToken(route) {
  return `[route: ${route.target.id} | rule: ${route.matchedRule} | profile: ${route.profile.id}]`;
}

export function stableJson(value) {
  return JSON.stringify(sortForJson(value), null, 2);
}

function resolveRouteId(config, profile, classification, prompt, seen) {
  if (seen.has(profile.id)) throw new Error(`routing profile inheritance cycle at ${profile.id}`);
  seen.add(profile.id);
  for (const exception of profile.exceptions ?? []) {
    if (exceptionMatches(exception, classification, prompt)) {
      return { targetId: exception.target, rule: exception.id };
    }
  }
  const cell = profile.matrix?.[classification.taskType]?.[classification.tier];
  if (cell) return { targetId: cell, rule: `cell:${profile.id}:${classification.taskType}:${classification.tier}` };
  if (profile.inherits) {
    const parent = getProfile(config, profile.inherits);
    const inherited = resolveRouteId(config, parent, classification, prompt, seen);
    return { ...inherited, rule: `inherit:${profile.id}:${inherited.rule}`, inheritedFrom: parent.id };
  }
  return { targetId: profile.defaultTarget, rule: `default:${profile.id}` };
}

function resolveDiscipline(config, profile, tier) {
  if (profile.discipline?.[tier]) return profile.discipline[tier];
  if (profile.inherits) return resolveDiscipline(config, getProfile(config, profile.inherits), tier);
  throw new Error(`missing discipline for ${profile.id}/${tier}`);
}

function collectExceptions(config, profile, seen = new Set()) {
  if (seen.has(profile.id)) return [];
  seen.add(profile.id);
  const local = (profile.exceptions ?? []).map((exception) => ({ profileId: profile.id, exception }));
  if (!profile.inherits) return local;
  return [...local, ...collectExceptions(config, getProfile(config, profile.inherits), seen)];
}

function collectContinuations(config, profile, seen = new Set()) {
  if (seen.has(profile.id)) return [];
  seen.add(profile.id);
  const local = (profile.continuations ?? []).map((rule) => ({ profileId: profile.id, rule }));
  if (!profile.inherits) return local;
  return [...local, ...collectContinuations(config, getProfile(config, profile.inherits), seen)];
}

function exceptionMatches(exception, classification, prompt) {
  if (exception.taskType && exception.taskType !== classification.taskType) return false;
  if (exception.tier && exception.tier !== classification.tier) return false;
  if (exception.contextKind && exception.contextKind !== classification.contextKind) return false;
  if (exception.promptIncludes && !prompt.toLowerCase().includes(exception.promptIncludes.toLowerCase())) return false;
  return true;
}

function getProfile(config, profileId) {
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`unknown routing profile: ${profileId}`);
  return profile;
}

function targetDetails(target) {
  if (target.type === "native-model") return `model=${target.model}; effort=${target.effort ?? "medium"}`;
  if (target.type === "skill") return `skill=${target.skill ?? target.id}; providerModel=${target.providerModel}`;
  if (target.type === "workflow") return `workflow=${target.workflow}`;
  return "Coming soon";
}

function extractJsonObject(reply) {
  const trimmed = String(reply).trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("classifier did not return a JSON object");
}

function isSlug(value) {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortForJson(value[key]);
  return out;
}
