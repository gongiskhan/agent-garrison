// Instance profiles — the single source of truth for which ports this Garrison
// process and its Fittings bind.
//
// HARD RULE: prod and dev never share a port. The committed compositions carry
// ONE port map (the 7xxx family: app 7777, gateway 4777, outpost 3702, fittings
// 70xx). Every other instance is that same map shifted by a fixed per-profile
// offset. There is no second hand-maintained port table to drift.
//
//   profile  offset   app     gateway  outpost  fittings  scheduler
//   dev          0    7777     4777     3702     70xx      7099
//   prod     +1000    8777     5777     4702     80xx      8099
//   codex   +20000   27777    24777    23702    270xx     27099
//
// The codex family was ALREADY exactly +20000 from the committed values before
// this module existed — the offset model describes reality, it does not impose
// a new scheme on it.
//
// Only PROD is ever fronted by `tailscale serve`. The tailnet address is the
// always-on surface and must never resolve to a dev server: a dev crash or a
// half-finished edit would take the tailnet down. See scripts/tailnet-serve-views.mjs.

export type InstanceProfileId = "prod" | "dev" | "codex";

export const INSTANCE_PROFILE_IDS: readonly InstanceProfileId[] = ["prod", "dev", "codex"];

// Added to every port the composition declares. dev is 0 so the committed
// values ARE the dev values — an unset/unknown profile therefore behaves
// exactly as this repo did before profiles existed.
export const PROFILE_PORT_OFFSET: Record<InstanceProfileId, number> = {
  dev: 0,
  prod: 1000,
  codex: 20000
};

// Base ports for the process-level listeners the compositions do NOT declare
// (the Next app itself, the outpost host, and the scheduler's health port when
// no composition config supplies one). Fitting and gateway ports come from the
// composition, offset by the profile.
export const BASE_APP_PORT = 7777;
export const BASE_OUTPOST_PORT = 3702;
export const BASE_GATEWAY_PORT = 4777;
export const BASE_SCHEDULER_HEALTH_PORT = 7099;

export function isInstanceProfileId(value: unknown): value is InstanceProfileId {
  return typeof value === "string" && (INSTANCE_PROFILE_IDS as readonly string[]).includes(value);
}

// The profile this process is running as. The launcher
// (scripts/garrison-instance.sh) exports GARRISON_INSTANCE_ID; an unset value
// means "dev" so a bare `next dev` keeps the committed 7xxx behaviour rather
// than silently landing on prod's ports.
export function currentProfile(): InstanceProfileId {
  const raw = process.env.GARRISON_INSTANCE_ID?.trim();
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
