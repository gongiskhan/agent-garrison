// Pure compaction helpers for plan-time browser evidence.
//
// Browser's raw network buffer is useful for DevTools, but it is the wrong
// shape for a planning transcript: it is large, repeats background noise,
// and URLs can carry credentials, query tokens, or fragments. These helpers
// keep only the request classes that explain page loading, classify their
// outcome, and remove URL material that must never be persisted in a plan log.

const NETWORK_TYPES = new Map([
  ["document", "Document"],
  ["stylesheet", "Stylesheet"],
  ["image", "Image"],
  ["media", "Media"],
  ["font", "Font"],
  ["script", "Script"],
  ["texttrack", "TextTrack"],
  ["fetch", "Fetch"],
  ["xhr", "XHR"],
  ["preflight", "Preflight"],
  ["eventsource", "EventSource"],
  ["websocket", "WebSocket"],
  ["manifest", "Manifest"],
  ["signedexchange", "SignedExchange"],
  ["ping", "Ping"],
  ["cspviolationreport", "CSPViolationReport"],
  ["prefetch", "Prefetch"],
  ["other", "Other"]
]);

const SUCCESS_NETWORK_TYPES = new Set(["Document", "Fetch", "XHR"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SECRET_PATH_KEYS = new Set([
  "access-token", "accesstoken", "refresh-token", "refreshtoken",
  "id-token", "idtoken", "token", "api-key", "apikey", "secret",
  "password", "passwd", "credential", "authorization", "auth", "bearer",
  "session", "reset-password", "resetpassword", "magic-link", "magiclink",
  "invite", "invitation", "verification", "oauth-code", "oauthcode", "code"
]);

const UNNAMED_INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "tab",
  "textbox", "combobox", "checkbox", "radio"
]);

export const EXPLORE_NETWORK_LIMIT = 16;
export const EXPLORE_ELEMENTS_LIMIT = 120;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedLimit(value, fallback, max = 100) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function isoOrNull(epochMs) {
  const n = finiteNumber(epochMs);
  if (n === null) return null;
  try { return new Date(n).toISOString(); } catch { return null; }
}

function normalizePathKey(value) {
  let decoded = String(value ?? "");
  try { decoded = decodeURIComponent(decoded); } catch { /* inspect encoded text as-is */ }
  return decoded.trim().toLowerCase().replaceAll("_", "-");
}

function looksLikeOpaqueSecret(value) {
  const key = normalizePathKey(value);
  if (/^eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:\.[a-z0-9_-]{8,})?$/i.test(key)) return true;
  if (/^[a-z0-9_~+.-]{32,}$/i.test(key) && /[a-z]/i.test(key) && /\d/.test(key)) return true;
  return false;
}

function sanitizeExplorePathname(pathname) {
  const segments = String(pathname || "/").split("/");
  let redactNext = false;
  return segments.map((segment) => {
    if (!segment) return segment;
    const key = normalizePathKey(segment);
    const carriesNamedSecret = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|api[-_]?key|apikey|secret|password|passwd|credential|authorization|auth|bearer|session|code)[:=].+/i.test(key);
    if (redactNext || carriesNamedSecret || looksLikeOpaqueSecret(segment)) {
      redactNext = false;
      return "[redacted]";
    }
    redactNext = SECRET_PATH_KEYS.has(key);
    return segment;
  }).join("/") || "/";
}

function normalizedResourceType(value) {
  const input = String(value ?? "").trim();
  const known = NETWORK_TYPES.get(input.toLowerCase());
  if (known) return known;
  if (/^[a-z][a-z0-9_-]{0,31}$/i.test(input)) return `${input[0].toUpperCase()}${input.slice(1)}`;
  return "Other";
}

// Same-origin requests need only their path. Cross-origin requests keep the
// origin so the agent can tell which service failed. URL userinfo, query, and
// fragment are absent by construction; malformed and non-web URLs are reduced
// to a non-sensitive marker rather than echoing their input.
export function safeExploreNetworkUrl(rawUrl, pageUrl) {
  let target;
  try { target = new URL(String(rawUrl ?? ""), pageUrl || undefined); }
  catch { return "[invalid-url]"; }

  if (!["http:", "https:", "ws:", "wss:"].includes(target.protocol)) {
    return target.protocol || "[invalid-url]";
  }

  let pageOrigin = null;
  try { pageOrigin = new URL(String(pageUrl ?? "")).origin; } catch { /* no comparable page */ }
  const pathname = sanitizeExplorePathname(target.pathname || "/");
  return pageOrigin && target.origin === pageOrigin
    ? pathname
    : `${target.origin}${pathname}`;
}

// A page URL is itself durable planner output. Keep enough context to
// distinguish the app/service and route, but never persist credentials, query
// values (OAuth codes are common here), or fragments.
export function safeExplorePageUrl(rawUrl) {
  let target;
  try { target = new URL(String(rawUrl ?? "")); }
  catch { return "[invalid-url]"; }
  if (["http:", "https:", "ws:", "wss:"].includes(target.protocol)) {
    return `${target.origin}${sanitizeExplorePathname(target.pathname || "/")}`;
  }
  if (target.protocol === "about:") return `${target.protocol}${target.pathname || "blank"}`;
  return target.protocol || "[invalid-url]";
}

// Console errors are useful corroboration, but applications routinely print a
// failed request URL or an auth value into them. Strip complete absolute and
// relative URL queries, then redact common bare credential assignments. This is
// deliberately conservative: the planner needs the error, not the credential.
export function sanitizeExploreConsoleText(value, { limit = 300 } = {}) {
  let text = String(value ?? "").slice(0, 2000);
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, (match) => safeExplorePageUrl(match));
  text = text.replace(
    /(^|[\s("'`])((?:\/|\.\.?\/)[^\s<>"'`?#]*)(?:\?[^\s<>"'`#]*)?(?:#[^\s<>"'`]*)?/g,
    (_match, prefix, pathname) => `${prefix}${sanitizeExplorePathname(pathname)}`
  );
  const secretKey = "access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|credential|authorization|cookie|code|state";
  text = text.replace(
    new RegExp(`("(?:${secretKey})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi"),
    '$1"[redacted]"'
  );
  text = text.replace(
    new RegExp(`('(?:${secretKey})'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, "gi"),
    "$1'[redacted]'"
  );
  // Authorization values routinely contain a scheme plus whitespace (and
  // JSON loggers often expand them into several words). Redact to a structural
  // delimiter instead of stopping at the first space.
  text = text.replace(
    /\b(authorization)\s*([=:])\s*[^,;\r\n}\]]+/gi,
    (_match, key, separator) => `${key}${separator}[redacted]`
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  text = text.replace(
    /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|credential|cookie|code|state)\s*([=:])\s*[^,;&\r\n}\]]+/gi,
    (_match, key, separator) => `${key}${separator}[redacted]`
  );
  return text.slice(0, boundedLimit(limit, 300, 1000));
}

// Whitelist Browser's factual quiet scalars. Future Browser diagnostics must
// not silently become durable plan material merely because they were added to
// the upstream object.
export function safeExploreQuietMetadata(value) {
  const input = value && typeof value === "object" ? value : {};
  const allowedOutcomes = new Set(["quiet", "budget-exhausted", "unavailable"]);
  const outcome = allowedOutcomes.has(input.outcome) ? input.outcome : "unavailable";
  const out = { outcome };
  for (const key of ["waitedMs", "quietForMs", "budgetMs", "pendingRequests", "persistentRequests"]) {
    const n = finiteNumber(input[key]);
    if (n !== null) out[key] = Math.max(0, Math.round(n));
  }
  if (["loading", "interactive", "complete", "unknown"].includes(input.readyState)) {
    out.readyState = input.readyState;
  }
  for (const key of ["networkQuiet", "domStable", "timedOut"]) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  return out;
}

export function isCoherentExploreQuiet(value) {
  const quiet = safeExploreQuietMetadata(value);
  return quiet.outcome === "quiet"
    && quiet.networkQuiet === true
    && quiet.domStable === true
    && quiet.timedOut === false;
}

function compactNetworkEntry(record, { pageUrl, nowMs }) {
  const entry = record.entry;
  const ts = finiteNumber(entry?.ts);
  const duration = finiteNumber(entry?.duration);
  const status = finiteNumber(entry?.status);
  const failed = entry?.failed === true;
  const pending = duration === null && !failed;
  const ageMs = ts === null ? null : Math.max(0, Math.round(nowMs - ts));
  return {
    resourceType: record.resourceType,
    method: String(entry?.method ?? "GET").toUpperCase().slice(0, 12),
    url: safeExploreNetworkUrl(entry?.url, pageUrl),
    status,
    pending,
    persistent: record.persistent,
    failed,
    ageMs,
    durationMs: duration === null ? null : Math.max(0, Math.round(duration))
  };
}

// Return a small evidence window. Counts describe every eligible request in
// the window; detail rows are globally capped and prioritise issues over 2xx
// successes so a noisy page cannot push the one useful failure out of view.
export function compactExploreNetwork(entries, {
  pageUrl = null,
  since = null,
  now = Date.now(),
  limit = EXPLORE_NETWORK_LIMIT
} = {}) {
  const nowMs = finiteNumber(now) ?? Date.now();
  const sinceMs = finiteNumber(since);
  const cap = boundedLimit(limit, EXPLORE_NETWORK_LIMIT, 50);
  const records = [];

  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const resourceType = normalizedResourceType(entry?.resourceType);
    const ts = finiteNumber(entry?.ts);
    if (sinceMs !== null && ts !== null && ts < sinceMs) continue;
    const duration = finiteNumber(entry?.duration);
    const status = finiteNumber(entry?.status);
    const failed = entry?.failed === true;
    const rawPending = duration === null && !failed;
    const persistent = rawPending && entry?.persistent === true;
    const pending = rawPending && !persistent;
    const upgradedWebSocket = resourceType === "WebSocket" && status === 101;
    const non2xx = !failed && !upgradedWebSocket && status !== null && (status < 200 || status >= 300);
    const redirect = non2xx && REDIRECT_STATUSES.has(status);
    const notModified = non2xx && status === 304;
    const httpError = non2xx && status >= 400;
    const otherNon2xx = non2xx && !redirect && !notModified && !httpError;
    const completed2xx = !failed && !rawPending && status !== null && status >= 200 && status < 300;
    // Successful static resources are background noise, but an Image/Script/
    // Font failure or hang is page evidence and must never disappear merely
    // because it is not an API request.
    if (!rawPending && !failed && !non2xx && !(completed2xx && SUCCESS_NETWORK_TYPES.has(resourceType))) continue;
    records.push({
      index, entry, resourceType, ts: ts ?? -1,
      pending, persistent, failed, non2xx, redirect, notModified, httpError, otherNon2xx, completed2xx
    });
  }

  const newest = (a, b) => b.ts - a.ts || b.index - a.index;
  const issueRecords = records.filter((r) => r.pending || r.persistent || r.failed || r.httpError).sort(newest);
  const factualNon2xxRecords = records.filter((r) => r.redirect || r.notModified || r.otherNon2xx).sort(newest);
  const successRecords = records.filter((r) => r.completed2xx).sort((a, b) => {
    const aPriority = a.resourceType === "Document" ? 1 : 0;
    const bPriority = b.resourceType === "Document" ? 1 : 0;
    return aPriority - bPriority || newest(a, b);
  });
  const selected = [];
  const selectedIndexes = new Set();
  for (const record of [...issueRecords, ...factualNon2xxRecords, ...successRecords]) {
    if (selected.length >= cap) break;
    if (selectedIndexes.has(record.index)) continue;
    selectedIndexes.add(record.index);
    selected.push(record);
  }

  const compacted = new Map(selected.map((record) => [
    record.index,
    compactNetworkEntry(record, { pageUrl, nowMs })
  ]));
  const details = (predicate) => selected
    .filter(predicate)
    .sort(newest)
    .map((record) => compacted.get(record.index));

  return {
    summary: {
      windowStartedAt: isoOrNull(sinceMs),
      total: records.length,
      pending: records.filter((r) => r.pending).length,
      persistent: records.filter((r) => r.persistent).length,
      non2xx: records.filter((r) => r.non2xx).length,
      redirects: records.filter((r) => r.redirect).length,
      notModified: records.filter((r) => r.notModified).length,
      httpErrors: records.filter((r) => r.httpError).length,
      otherNon2xx: records.filter((r) => r.otherNon2xx).length,
      transportFailures: records.filter((r) => r.failed).length,
      completed2xx: records.filter((r) => r.completed2xx).length
    },
    issues: {
      pending: details((r) => r.pending),
      persistent: details((r) => r.persistent),
      httpErrors: details((r) => r.httpError),
      transportFailures: details((r) => r.failed)
    },
    otherResponses: {
      redirects: details((r) => r.redirect),
      notModified: details((r) => r.notModified),
      otherNon2xx: details((r) => r.otherNon2xx)
    },
    recent2xx: details((r) => r.completed2xx),
    truncated: records.length > selected.length
  };
}

// Preserve named a11y nodes as before, but do not erase an interactive control
// merely because its accessible name is missing. One cue per unnamed role is
// enough to expose the defect without flooding the planner with duplicates.
export function compactExploreElements(a11y, { limit = EXPLORE_ELEMENTS_LIMIT } = {}) {
  const cap = boundedLimit(limit, EXPLORE_ELEMENTS_LIMIT, 500);
  const seen = new Set();
  const elements = [];
  let eligible = 0;

  for (const node of Array.isArray(a11y) ? a11y : []) {
    const role = String(node?.role ?? "").trim().slice(0, 80);
    const name = String(node?.name ?? "").trim().slice(0, 300);
    if (!role) continue;
    if (!name && !UNNAMED_INTERACTIVE_ROLES.has(role)) continue;
    const key = name ? `${role}|${name}` : `${role}|<accessible-name-missing>`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible++;
    if (elements.length >= cap) continue;
    elements.push(name
      ? { role, name }
      : { role, accessibleNameMissing: true });
  }

  return { elements, truncated: eligible > elements.length };
}

// Browser owns these values, but Drill still treats the service boundary as a
// privacy boundary. Only the documented scalar context reaches a transcript.
export function safeExploreBrowserContext(value) {
  const input = value && typeof value === "object" ? value : {};
  const out = {};
  if (typeof input.persistentProfile === "boolean") out.persistentProfile = input.persistentProfile;
  for (const key of ["tabAgeMs", "navigationAgeMs"]) {
    const n = finiteNumber(input[key]);
    if (n !== null) out[key] = Math.max(0, Math.round(n));
  }
  return out;
}
