// CORS / Origin guard for this fitting's REST and WS surface.
//
// The browser reaches the OWNING node's fitting DIRECTLY, cross-origin - a
// page on node A calls node B's shells fitting. That is a wider allowance
// than the shell app's own same-origin guard (src/lib/mesh/peer-auth.ts):
// isTrustedHost here is ported VERBATIM (the two must classify a host
// identically), but a trusted-Origin request is allowed even when its host
// differs from the request's own Host header. The tailnet is the trust
// boundary this fitting already lives inside (same posture as dev-env's own
// unauthenticated /io).

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export function isTrustedHost(value) {
  const h = String(value || "")
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/i, "")
    .toLowerCase();
  if (!h) return true;
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h === "::1" || h.endsWith(".ts.net")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true; // 127/8 loopback
    if (a === 10) return true; // 10/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 tailnet CGNAT
    return false; // any other IPv4 is public
  }
  if (h.includes(":") && (h.startsWith("fd") || h.startsWith("fc") || h.startsWith("fe80"))) return true;
  return false;
}

/** { blocked, reason? } for one request's Host/Origin pair. Host must be
 *  trusted (the DNS-rebinding guard); Origin, when present, must itself be a
 *  trusted host - NOT necessarily the same one as Host. */
export function verdict({ host, origin }) {
  const hostHeader = String(host ?? "");
  const hostName = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (hostName && !isTrustedHost(hostName)) {
    return { blocked: true, reason: `untrusted Host '${hostName}' (DNS-rebinding guard)` };
  }
  if (origin) {
    let ok = false;
    try {
      ok = isTrustedHost(new URL(origin).hostname);
    } catch {
      ok = false;
    }
    if (!ok) return { blocked: true, reason: `untrusted Origin '${origin}'` };
  }
  return { blocked: false };
}

/** Set the CORS response headers for an allowed, Origin-bearing request. A
 *  same-origin request (no Origin header) needs none of this. */
export function applyCors(res, origin) {
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "600");
}
