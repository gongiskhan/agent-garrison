// Instance profiles — the single source of truth for which ports this Garrison
// process and its Fittings bind.
//
// MESH RE-AXIS (2026-08-24). Two axes, two variables — conflating them is how
// a codex sandbox registers itself as a mesh node:
//   GARRISON_INSTANCE_ID — which SANDBOX on this box: node | dev | codex
//   GARRISON_NODE_NAME   — which MACHINE in the mesh (node.json / state.json)
//
// The committed compositions carry ONE port map, now the 8xxx family — the
// values the always-on instance has served on this tailnet since the prod
// profile existed. The `node` profile is offset 0: NOTHING running anywhere
// changed ports in this re-axis; only the sandboxes moved. "prod" survives as
// a spelled-out alias for `node` for one release (units and muscle memory).
//
//   profile  offset   app     gateway  fittings  scheduler
//   node         0    8777     5777     80xx      8099
//   dev     +10000   18777    15777    180xx     18099
//   codex   +20000   28777    25777    280xx     28099
//
// HARD RULE unchanged: never hardcode a port; two profiles never share one.
// Every node in the mesh runs the same map at offset 0 — same fitting, same
// port, same serve port on every machine, which is what makes peer view URLs
// computable without asking the peer (see scripts/tailnet-serve-views.mjs).

export type InstanceProfileId = "node" | "dev" | "codex";

export const INSTANCE_PROFILE_IDS: readonly InstanceProfileId[] = ["node", "dev", "codex"];

export const PROFILE_PORT_OFFSET: Record<InstanceProfileId, number> = {
  node: 0,
  dev: 10000,
  codex: 20000
};

// Base ports for the process-level listeners the compositions do NOT declare
// (the Next app itself and the scheduler's health port when no composition
// config supplies one). Fitting and gateway ports come from the composition,
// offset by the profile.
export const BASE_APP_PORT = 8777;
/**
 * @deprecated The outpost WS bridge daemon this addressed was retired with the
 * mesh (2026-08-24). Kept for one release alongside the launcher's
 * GARRISON_OUTPOST_PORT export so a stale process reads a per-instance value
 * rather than colliding on 4702. Nothing in the mesh binds it.
 */
export const BASE_OUTPOST_PORT = 4702;
export const BASE_GATEWAY_PORT = 5777;
export const BASE_SCHEDULER_HEALTH_PORT = 8099;

export function isInstanceProfileId(value: unknown): value is InstanceProfileId {
  return typeof value === "string" && (INSTANCE_PROFILE_IDS as readonly string[]).includes(value);
}

// The profile this process is running as. The launcher
// (scripts/garrison-instance.sh) exports GARRISON_INSTANCE_ID; an unset value
// means "dev" so a bare `next dev` lands in the sandbox range rather than on
// the node's live ports. "prod" is accepted as a legacy alias for "node".
export function currentProfile(): InstanceProfileId {
  const raw = process.env.GARRISON_INSTANCE_ID?.trim();
  if (raw === "prod") return "node";
  return isInstanceProfileId(raw) ? raw : "dev";
}

export function portOffset(profile: InstanceProfileId = currentProfile()): number {
  return PROFILE_PORT_OFFSET[profile] ?? 0;
}

// Shift a composition-declared base port into this profile's range. Non-numeric
// or out-of-range input is returned untouched so a malformed config surfaces as
// itself rather than as a silently wrong port.
export function profilePort(basePort: number, profile: InstanceProfileId = currentProfile()): number {
  if (!Number.isInteger(basePort) || basePort <= 0 || basePort > 65535) return basePort;
  const shifted = basePort + portOffset(profile);
  return shifted > 65535 ? basePort : shifted;
}

export function appPort(profile: InstanceProfileId = currentProfile()): number {
  return profilePort(BASE_APP_PORT, profile);
}

/** @deprecated See {@link BASE_OUTPOST_PORT}. */
export function outpostPort(profile: InstanceProfileId = currentProfile()): number {
  return profilePort(BASE_OUTPOST_PORT, profile);
}

export function schedulerHealthPort(profile: InstanceProfileId = currentProfile()): number {
  return profilePort(BASE_SCHEDULER_HEALTH_PORT, profile);
}

// Config keys whose scalar value is a port and must be shifted with the
// profile. Matches `port` and any `*_port` (slack_port, health_port, ...).
const PORT_KEY_PATTERN = /(^|_)port$/i;

// Rewrite the loopback port inside a URL-valued config entry (gateway_url,
// outpost_host_url, ...). Only 127.0.0.1/localhost is touched: a URL pointing
// at a real host is external and must not be shifted.
function shiftLoopbackUrl(value: string, profile: InstanceProfileId): string {
  return value.replace(
    /^(https?:\/\/(?:127\.0\.0\.1|localhost)):(\d+)/i,
    (whole, prefix: string, port: string) => {
      const shifted = profilePort(Number(port), profile);
      return Number.isInteger(shifted) ? `${prefix}:${shifted}` : whole;
    }
  );
}

// Shift every port-bearing entry of a fitting's composition config into this
// profile's range. Returns a new object; non-port entries pass through.
export function applyPortOffsetToConfig(
  config: Record<string, unknown>,
  profile: InstanceProfileId = currentProfile()
): Record<string, unknown> {
  if (portOffset(profile) === 0) return { ...(config ?? {}) };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (PORT_KEY_PATTERN.test(key) && typeof value === "number") {
      out[key] = profilePort(value, profile);
    } else if (PORT_KEY_PATTERN.test(key) && typeof value === "string" && /^\d+$/.test(value)) {
      out[key] = String(profilePort(Number(value), profile));
    } else if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      out[key] = shiftLoopbackUrl(value, profile);
    } else {
      out[key] = value;
    }
  }
  return out;
}
