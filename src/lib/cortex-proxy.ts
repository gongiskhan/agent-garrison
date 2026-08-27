import { getActiveComposition } from "./active-composition";
import { readComposition } from "./compositions";
import { scopedSecrets } from "./vault";

// Server side of the cortex-automations `session` view. The view is a test rig
// over a REMOTE capability API reached with a user-scoped gateway key, and two
// things must never happen in the browser:
//
//   1. The key must not reach it. The vault secret is read here, attached here,
//      and the response is handed back without it.
//   2. The Cortex origin must not be fetched from the browser either. It is
//      routinely a machine-local address (a dev stack on this box), and the
//      user's browser is almost never on this machine - see the tailnet hard
//      rule in CLAUDE.md. Every client call is same-origin to Garrison and this
//      module makes the outbound hop.
//
// The proxy is CLOSED: only the endpoints the view drives are reachable, so a
// bug (or a hostile page) cannot turn it into a general-purpose request
// forwarder pointed at whatever the vault key opens.

export const CORTEX_FITTING_ID = "cortex-automations";
export const CORTEX_SECRET_KEY = "CORTEX_API_KEY";
export const CORTEX_BASE_URL_CONFIG_KEY = "base_url";

export type CortexMethod = "GET" | "POST" | "PATCH" | "DELETE";

const METHODS: readonly CortexMethod[] = ["GET", "POST", "PATCH", "DELETE"];

// One path segment. Deliberately narrow: ids, integration keys and action names
// only. No slashes (segment boundaries are the allowlist's structure) and no
// percent escapes (an encoded `/` or `.` would smuggle a shape past the
// patterns below).
const SEG = "[A-Za-z0-9_.~-]+";

// `/api/v1/automations/{id}` is shaped exactly like its sibling literals, so a
// bare `{id}` rule silently admits `/catalog`, `/approved-commands` and `/plan`
// as well - endpoints this rig never calls, reachable purely because an id and
// a word look the same. The `{id}` position excludes them; the ones that ARE
// allowed (POST /plan, GET /runs) have their own rules.
const RESERVED = "(?!(?:runs|plan|catalog|approved-commands)(?:/|$))";

interface AllowRule {
  method: CortexMethod;
  pattern: RegExp;
}

// The complete key-reachable surface of the Cortex v1 capability API, as the
// session view drives it. Anything absent here is refused before a request is
// built. Adding a row is a deliberate act; it widens what one leaked page load
// can reach.
const ALLOWED: readonly AllowRule[] = [
  { method: "GET", pattern: /^\/api\/v1\/integrations$/ },
  { method: "GET", pattern: new RegExp(`^/api/v1/integrations/${SEG}$`) },
  {
    method: "POST",
    pattern: new RegExp(`^/api/v1/integrations/${SEG}/actions/${SEG}/execute$`)
  },
  { method: "POST", pattern: new RegExp(`^/api/v1/integrations/${SEG}/achieve$`) },

  { method: "GET", pattern: /^\/api\/v1\/automations$/ },
  { method: "POST", pattern: /^\/api\/v1\/automations$/ },
  { method: "POST", pattern: /^\/api\/v1\/automations\/plan$/ },

  // `runs` before `{id}`: both shapes are one segment deep, and a rule list is
  // an OR, so the literal must exist in its own right.
  { method: "GET", pattern: /^\/api\/v1\/automations\/runs$/ },
  { method: "GET", pattern: new RegExp(`^/api/v1/automations/runs/${SEG}$`) },
  { method: "GET", pattern: new RegExp(`^/api/v1/automations/runs/${SEG}/logs$`) },
  {
    method: "POST",
    pattern: new RegExp(`^/api/v1/automations/runs/${SEG}/(consent|resume|cancel)$`)
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/v1/automations/runs/${SEG}/steps/${SEG}/feedback$`)
  },

  { method: "GET", pattern: new RegExp(`^/api/v1/automations/${RESERVED}${SEG}$`) },
  { method: "PATCH", pattern: new RegExp(`^/api/v1/automations/${RESERVED}${SEG}$`) },
  { method: "DELETE", pattern: new RegExp(`^/api/v1/automations/${RESERVED}${SEG}$`) },
  { method: "POST", pattern: new RegExp(`^/api/v1/automations/${RESERVED}${SEG}/runs$`) }
];

// Conservative query charset. The view only ever needs simple filters; a query
// string is not part of the allowlist's identity, so it may not carry structure.
const QUERY = /^[A-Za-z0-9_.~%=&,+-]*$/;

export type PathCheck =
  | { ok: true; method: CortexMethod; path: string }
  | { ok: false; reason: string };

export function checkCortexRequest(method: unknown, rawPath: unknown): PathCheck {
  if (typeof method !== "string" || !METHODS.includes(method.toUpperCase() as CortexMethod)) {
    return { ok: false, reason: `method must be one of ${METHODS.join(", ")}` };
  }
  const verb = method.toUpperCase() as CortexMethod;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "path is required" };
  }
  if (!rawPath.startsWith("/")) {
    return { ok: false, reason: "path must start with / - it is a path, not a URL" };
  }
  const [pathname, ...queryParts] = rawPath.split("?");
  const query = queryParts.join("?");
  if (query && !QUERY.test(query)) {
    return { ok: false, reason: "query string contains characters this proxy does not pass" };
  }
  // `[^/]+` in the patterns would happily match `..`, and the URL join below
  // would then normalise it into a path the allowlist never approved.
  if (/(^|\/)\.+(\/|$)/.test(pathname)) {
    return { ok: false, reason: "path may not contain relative segments" };
  }
  const allowed = ALLOWED.some((rule) => rule.method === verb && rule.pattern.test(pathname));
  if (!allowed) {
    return { ok: false, reason: `${verb} ${pathname} is not on the Cortex proxy allowlist` };
  }
  return { ok: true, method: verb, path: query ? `${pathname}?${query}` : pathname };
}

export interface CortexBase {
  baseUrl: string | null;
  source: "config" | "env" | null;
  stationed: boolean;
  compositionId: string | null;
  /** Set when a base URL IS configured but cannot be used. */
  invalid?: string;
}

function normalizeBase(raw: string, source: "config" | "env"): CortexBase["baseUrl"] | { bad: string } {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { bad: `${source} base URL "${trimmed}" is not a URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { bad: `${source} base URL must be http or https, got "${parsed.protocol}"` };
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/**
 * Where this Garrison sends Cortex requests.
 *
 * Read from the ACTIVE composition's raw selection config, not from the
 * port-shifted projection every spawn path uses: `base_url` is an address the
 * user typed, and applyPortOffsetToConfig would silently move a port in it.
 */
export async function readCortexBase(): Promise<CortexBase> {
  let compositionId: string | null = null;
  let stationed = false;
  let configured: string | null = null;
  try {
    compositionId = await getActiveComposition();
    const composition = await readComposition(compositionId);
    for (const items of Object.values(composition.selections)) {
      for (const item of items ?? []) {
        if (item?.id !== CORTEX_FITTING_ID) continue;
        stationed = true;
        const value = (item.config as Record<string, unknown> | undefined)?.[
          CORTEX_BASE_URL_CONFIG_KEY
        ];
        if (typeof value === "string") configured = value;
      }
    }
  } catch (error) {
    console.warn("[garrison] cortex base URL: composition unreadable:", error);
  }

  if (configured !== null) {
    const resolved = normalizeBase(configured, "config");
    if (resolved && typeof resolved === "object") {
      return { baseUrl: null, source: "config", stationed, compositionId, invalid: resolved.bad };
    }
    if (resolved) return { baseUrl: resolved, source: "config", stationed, compositionId };
  }

  const fromEnv = process.env.CORTEX_BASE_URL;
  if (fromEnv) {
    const resolved = normalizeBase(fromEnv, "env");
    if (resolved && typeof resolved === "object") {
      return { baseUrl: null, source: "env", stationed, compositionId, invalid: resolved.bad };
    }
    if (resolved) return { baseUrl: resolved, source: "env", stationed, compositionId };
  }

  return { baseUrl: null, source: null, stationed, compositionId };
}

export interface CortexKeyState {
  set: boolean;
  /** The vault could not be opened, so presence is unknown rather than false. */
  locked: boolean;
}

/** Presence only. The value never leaves this module for a status response. */
export async function readCortexKeyState(): Promise<CortexKeyState> {
  try {
    const secrets = await scopedSecrets([CORTEX_SECRET_KEY]);
    const found = secrets.find((secret) => secret.key === CORTEX_SECRET_KEY);
    return { set: !!found && found.value.trim().length > 0, locked: false };
  } catch {
    return { set: false, locked: true };
  }
}

export async function readCortexKey(): Promise<string | null> {
  const secrets = await scopedSecrets([CORTEX_SECRET_KEY]);
  const found = secrets.find((secret) => secret.key === CORTEX_SECRET_KEY);
  const value = found?.value.trim();
  return value ? value : null;
}

export interface UpstreamResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  /** Parsed JSON when the response is JSON, otherwise the raw text. */
  body: unknown;
}

/**
 * One authenticated hop to Cortex. The upstream status is REPORTED, never
 * mirrored onto the Garrison response: `execute` answers 200 with
 * `{success:false}` and 403 for a consent gate, and both are ordinary outcomes
 * the view has to render - not transport failures.
 */
export async function callCortex(args: {
  baseUrl: string;
  key: string;
  method: CortexMethod;
  path: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<UpstreamResponse> {
  const url = `${args.baseUrl}${args.path}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? (args.method === "GET" ? 30_000 : 120_000)
  );
  try {
    const response = await fetch(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${args.key}`,
        Accept: "application/json",
        ...(args.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: controller.signal,
      cache: "no-store"
    });
    const contentType = response.headers.get("content-type");
    const text = await response.text();
    let body: unknown = text;
    if (text && (contentType ?? "").includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, statusText: response.statusText, contentType, body };
  } finally {
    clearTimeout(timeout);
  }
}
