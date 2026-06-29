// souls-route.mjs — honor an EXPLICIT {taskType,tier} classification hint in
// souls/orchestrator mode, mirroring what preRoute does in PTY-gateway mode.
//
// The Kanban board POSTs /chat with body.classification = {taskType,tier} as an
// explicit routing hint. In PTY mode gateway-routing.mjs:preRoute honors it (the
// in-vocab guard at :492-502). In souls mode the /chat handler forwards to the
// orchestrator and DROPPED the hint — this helper closes that gap.
//
// Pure by construction: inputs in, object out. NO fs / fetch / disk import. The
// gateway loads the routing core+config via the existing portable loaders
// (loadRoutingCore / loadRoutingConfig) and passes resolveRoute in, so the same
// fitting-dir resolution that PTY mode uses works in installed compositions too
// (a static relative import would only resolve the repo-seed layout).

// parseClassificationHint(body, config) — mirror the preRoute in-vocab guard:
// return {taskType,tier} ONLY when BOTH taskType and tier are strings AND in the
// router's vocabulary (config.taskTypes / config.tiers). Anything
// malformed/out-of-vocab/absent → null so a bad hint can never silently misroute
// a turn (it falls back to normal flow).
//
// We honor ONLY the documented souls contract {taskType,tier}. We deliberately do
// NOT carry a caller-supplied `matchedException`: in souls mode there is no
// classifier asserting it, and resolveRole honors matchedException by short-
// circuiting straight to a role — so trusting a caller-supplied one would let the
// caller bypass the task-type×tier matrix and force exception routing (e.g.
// ex-secrets → review). Exceptions stay router-internal; an extra field on the
// body is ignored, not trusted.
export function parseClassificationHint(body, config) {
  const c = body?.classification;
  if (!c || typeof c !== "object") return null;
  if (typeof c.taskType !== "string" || typeof c.tier !== "string") return null;
  const validTask = Array.isArray(config?.taskTypes) ? config.taskTypes : [];
  const validTier = Array.isArray(config?.tiers) ? config.tiers : [];
  if (!validTask.includes(c.taskType) || !validTier.includes(c.tier)) return null;
  return { taskType: c.taskType, tier: c.tier };
}

// resolveSoulsHint(body, config, resolveRoute) — parse the hint; if null return
// null (caller keeps EXACT current behavior). Else resolve the route via the pure
// model-router resolver and return a compact annotation the gateway can thread
// into the orchestrator turn. resolveRoute is injected (the gateway already loads
// routing-core via loadRoutingCore) so this stays pure + unit-testable.
export function resolveSoulsHint(body, config, resolveRoute) {
  const classification = parseClassificationHint(body, config);
  if (!classification) return null;
  if (typeof resolveRoute !== "function") return null;
  // resolveRoute is pure but can throw on an internally-inconsistent routing
  // config (missing profile/roleMap/targets). A valid /chat must never become a
  // request-time 500 because of bad routing state — fall back to no-hint behavior.
  let route;
  try {
    route = resolveRoute(config, config?.activeProfile, classification);
  } catch {
    return null;
  }
  const target = route?.target ?? null;
  return {
    classification,
    role: route?.role ?? null,
    targetId: route?.targetId ?? null,
    tier: classification.tier,
    model: target?.model ?? null,
    effort: target?.effort ?? null,
  };
}
