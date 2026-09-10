// Direct-origin client for the Shells fitting: the browser reaches the
// OWNING node's fitting directly (Next cannot upgrade WebSockets, so there
// is no same-origin relay for another node's session). For the LOCAL node,
// the origin is resolved exactly like an embedded own-port view
// (src/components/fitting-views/browser-view-url.ts resolveViewUrl, ported
// here since packages/talk builds separately from the shell app); for a
// PEER node it is the row's own shellOrigin.public, already computed by
// that node.

export type ShellOriginErrorKind = "no-origin" | "unreachable" | "cors" | "http" | "offline";

export class ShellOriginError extends Error {
  kind: ShellOriginErrorKind;
  status?: number;
  detail?: string;
  constructor(kind: ShellOriginErrorKind, message: string, opts: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = "ShellOriginError";
    this.kind = kind;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

/** Pure twin of resolveViewUrl. `loc` is injectable for tests; defaults to
 *  the real page location in the browser. */
export function resolveOriginForPage(
  view: { url?: string | null; tailnetUrl?: string | null },
  loc: { hostname: string; protocol: string } = typeof window !== "undefined" ? window.location : { hostname: "", protocol: "" }
): string {
  const url = view?.url ?? "";
  if (!url) return "";
  const here = loc.hostname;
  if (!here || here === "127.0.0.1" || here === "localhost") return url;
  if (view.tailnetUrl) {
    try {
      if (new URL(view.tailnetUrl).hostname === here) return view.tailnetUrl;
    } catch { /* fall through */ }
  }
  const LOOPBACK_HOST = /^(https?:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;
  const rebound = url.replace(LOOPBACK_HOST, `$1${here}`);
  if (loc.protocol === "https:" && rebound.startsWith("http://")) return "";
  return rebound;
}

let viewsCache: { at: number; views: Array<{ fittingId: string; url?: string | null; tailnetUrl?: string | null }> } | null = null;
const VIEWS_CACHE_MS = 60_000;

async function fetchLocalViews(fetchImpl: typeof fetch = fetch, refresh = false): Promise<Array<{ fittingId: string; url?: string | null; tailnetUrl?: string | null }>> {
  const now = Date.now();
  if (!refresh && viewsCache && now - viewsCache.at < VIEWS_CACHE_MS) return viewsCache.views;
  try {
    const r = await fetchImpl("/api/fittings/views", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Fitting discovery failed: HTTP ${r.status}`);
    const d = await r.json();
    const views = Array.isArray(d?.views) ? d.views : [];
    viewsCache = { at: now, views };
    return views;
  } catch {
    return viewsCache?.views ?? [];
  }
}

/** Legacy remote-shell threads also belong to the local Shells fitting.
 * Next serves their REST proxy, but cannot serve the old WebSocket relay. */
export async function resolveLocalShellOrigin(
  opts: { fetchImpl?: typeof fetch; loc?: { hostname: string; protocol: string }; refresh?: boolean } = {}
): Promise<string> {
  const views = await fetchLocalViews(opts.fetchImpl, opts.refresh);
  const view = views.find((v) => v.fittingId === "remote-shell-runtime");
  return view ? resolveOriginForPage(view, opts.loc) : "";
}

/** The origin to reach `row`'s owning node's Shells fitting from THIS page.
 *  Local (row.node === self): resolved from /api/fittings/views, cached 60s.
 *  Peer: the row/node's own published shellOrigin, verbatim. Empty string =
 *  "not reachable from here" - never null/undefined, so a caller can render
 *  it directly into errorCopy(). */
export async function resolveShellOrigin(
  row: { node: string; shellOrigin?: string | null },
  self: string | null,
  opts: { fetchImpl?: typeof fetch; loc?: { hostname: string; protocol: string } } = {}
): Promise<string> {
  if (self && row.node === self) {
    return resolveLocalShellOrigin(opts);
  }
  return row.shellOrigin ?? "";
}

export function shellSocketUrl(origin: string): string {
  return origin.replace(/^http/, "ws").replace(/\/+$/, "") + "/io";
}

// REST controls use the page's existing mesh path. Only the low-latency
// terminal WebSocket needs the fitting's published origin.
export function shellApiBase(node: string, self: string | null): string {
  return !self || node === self ? "/api/remote-shell" : `/api/mesh/nodes/${encodeURIComponent(node)}/remote-shell`;
}

export function newShellRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const SHELL_START_TIMEOUT_MS = 65_000;

/** fetch() against a Shells fitting origin, classifying every failure mode
 *  into one ShellOriginError kind rather than letting a bare TypeError reach
 *  the UI. `path` starts with "/". */
export async function shellFetch<T = unknown>(
  origin: string,
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!origin) throw new ShellOriginError("no-origin", "no reachable origin for this fitting");
  const timeoutMs = opts.timeoutMs ?? 8000;
  let res: Response;
  try {
    res = await fetchImpl(`${origin}${path}`, { ...init, mode: "cors", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (origin.startsWith("/") || (err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name))) {
      throw new ShellOriginError("unreachable", "The connection did not finish. Retry to reconnect to the same session.");
    }
    // A CORS refusal and a network failure both surface as an opaque
    // TypeError to fetch(); distinguish them with a no-cors probe of /health,
    // which succeeds (opaque response) iff the server is actually up.
    let reachable = false;
    try {
      await fetchImpl(`${origin}/health`, { mode: "no-cors", signal: AbortSignal.timeout(timeoutMs) });
      reachable = true;
    } catch { /* the probe also failed */ }
    if (reachable) throw new ShellOriginError("cors", "the fitting refused this page's origin", { detail: String(origin) });
    throw new ShellOriginError("unreachable", "This machine is not answering. Your draft is still here.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status >= 500 && /peer-unreachable|signal timed out|aborted due to timeout|remote-shell upstream/i.test(body?.error ?? "")) {
      throw new ShellOriginError("unreachable", "This machine is not answering. Retry will reconnect to the same session.", { status: res.status });
    }
    throw new ShellOriginError("http", body?.error ?? `http ${res.status}`, { status: res.status, detail: body?.reason });
  }
  return (await res.json()) as T;
}

/** User-facing copy for the deck/plaque when a shell/session cannot be
 *  reached. `lastSeenAt` is the node's roster timestamp, for the "offline"
 *  case (used by the caller, not derived here). */
export function errorCopy(
  err: unknown,
  nodeName: string,
  lastSeenAgo?: string | null
): { title: string; sub: string; hint?: string } {
  if (!(err instanceof ShellOriginError)) {
    return { title: "Something went wrong", sub: err instanceof Error ? err.message : String(err) };
  }
  switch (err.kind) {
    case "no-origin":
      return {
        title: `No address for ${nodeName}`,
        sub: "this page cannot reach the Shells fitting there.",
        hint: `Run scripts/tailnet-serve-views.mjs on ${nodeName}, or open this page from a tailnet address.`
      };
    case "cors":
      return {
        title: `${nodeName} refused this page`,
        sub: `the fitting is up but did not allow ${typeof window !== "undefined" ? window.location.origin : "this origin"}.`,
        hint: "This should not happen on the tailnet - check the fitting's CORS allow-list."
      };
    case "unreachable":
      return { title: `${nodeName} is not reachable`, sub: err.message };
    case "http":
      return { title: `${nodeName} refused the request`, sub: err.detail ?? err.message };
    case "offline":
      return { title: `${nodeName} is offline`, sub: lastSeenAgo ? `last seen ${lastSeenAgo}` : "no recent heartbeat", hint: "Sessions shown are from the last known index." };
    default:
      return { title: "Unreachable", sub: err.message };
  }
}

export function _resetShellOriginCacheForTests(): void {
  viewsCache = null;
}
