// Pure client-side host rewriting for absolute URLs surfaced in card bodies.
//
// The user's browser is almost never on the Garrison box (tailnet remote-access
// model): a loopback URL (http://127.0.0.1:PORT/…) baked into a card body is
// unreachable from a remote device AND a plain-http frame/link on the HTTPS
// tailnet page is mixed content (silently blocked). This maps a loopback URL to
// the client's own reachable form:
//   - client actually ON the box (loopback page)   → unchanged (loopback works)
//   - the port has a `tailscale serve` mapping      → swap scheme+host to HTTPS
//   - otherwise                                     → rebind host to the page host
//   - https page + would stay plain http (no map)   → "" (unreachable/mixed)
//
// Kept behaviorally identical to packages/claude-chat/src/host-rewrite.ts (the
// canonical version the app/package build owns); this is kanban's own copy so
// the own-port fitting installs independently (no cross-fitting import path).

export interface HostRewriteContext {
  /** The page host (window.location.hostname) — where the client actually runs. */
  hostname: string;
  /** The page protocol (window.location.protocol, e.g. "https:"). */
  protocol: string;
  /** localPort → HTTPS tailnet base URL, from GET /host-map. */
  serveMap: Record<number, string>;
}

function isLoopbackHost(host: string): boolean {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "0.0.0.0" || h === "::1";
}

// Rewrite a single absolute URL for the client that will use it. Non-loopback
// targets and unparseable input pass through unchanged. Returns "" when the URL
// cannot be made reachable without mixed content (https page, http-only target,
// no serve mapping) so the caller can drop the link rather than render a dead one.
export function rewriteHostUrl(raw: string, ctx: HostRewriteContext): string {
  if (!raw) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  // Only loopback targets need rehosting — a real/external host is left alone.
  if (!isLoopbackHost(url.hostname)) return raw;
  // A client actually on the box reaches loopback directly; leave it.
  if (isLoopbackHost(ctx.hostname)) return raw;

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const mapped = ctx.serveMap ? ctx.serveMap[port] : undefined;
  if (mapped) {
    try {
      const base = new URL(mapped);
      url.protocol = base.protocol;
      url.host = base.host;
      return url.toString();
    } catch {
      // fall through to a plain host rebind
    }
  }
  // No serve mapping: rebind the loopback host to the page host, keeping scheme
  // + port. A plain-http target on an https page is mixed content (blocked) — so
  // signal "unreachable" with "" rather than hand out a link that never loads.
  if (ctx.protocol === "https:" && url.protocol === "http:") return "";
  url.hostname = ctx.hostname.replace(/^\[|\]$/g, "");
  return url.toString();
}
