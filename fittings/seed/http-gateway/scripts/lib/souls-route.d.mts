// Hand-written types for souls-route.mjs so the TypeScript test (and any future
// typed consumer) gets types without a build step — mirrors the convention used
// by ../../../model-router/lib/routing-core.d.mts.

import type { RoutingConfig, Classification, RouteResolution } from "../../../../model-router/lib/routing-core.d.mts";

// The compact annotation the gateway threads into the orchestrator turn when an
// explicit classification hint is honored.
export interface SoulsRouteHint {
  classification: Classification;
  role: string | null;
  targetId: string | null;
  tier: string;
  model: string | null;
  effort: string | null;
}

// Parse + in-vocab guard for body.classification. Returns the classification only
// when taskType and tier are both strings AND in config.taskTypes/config.tiers,
// else null (so a bad hint falls back to normal classification).
export function parseClassificationHint(
  body: unknown,
  config: RoutingConfig,
): Classification | null;

// Resolve the hint through the injected pure resolveRoute. Null when the hint is
// absent/malformed/out-of-vocab or no resolver is supplied.
export function resolveSoulsHint(
  body: unknown,
  config: RoutingConfig,
  resolveRoute?: (config: RoutingConfig, profile: string | null, classification: Classification) => RouteResolution,
): SoulsRouteHint | null;
