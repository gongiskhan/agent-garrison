// Local-origin guards for APP routes, and the timing-safe token compare.
//
// This is the fourth copy of `isTrustedHost` / `crossSiteBlocked` in the
// repo - and it exists so it can become the ONLY one. The three live copies
// are in `fittings/seed/{ports-default,power-default,outpost-tailscale-host}
// /scripts/server.mjs`; they are `.mjs` fitting servers speaking `node:http`
// and cannot import a TypeScript module from `src/lib`, so they stay until the
// phase-E cleanup folds them (outpost-tailscale-host is slated for deletion
// there; the other two get the generated-copy treatment the state client
// already uses). The behaviour here is deliberately IDENTICAL to theirs -
// tests/mesh-proxy.test.ts pins the shared cases - so folding them later is a
// delete, not a re-derivation.
//
// What the guard is for: a Next route handler is reachable from any page the
// user happens to have open. Two attacks matter on a loopback/tailnet app:
//
//   - a CORS-simple cross-site request (the browser sends `Origin`), and
//   - DNS rebinding, which points a hostile public domain at 127.0.0.1, so the
//     request's `Host` header is that domain.
//
// So: `Host` must be a trusted host, and `Origin` (when present) must be
// loopback or same-origin. Everything else is refused with 403.

import crypto from "node:crypto";

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0"
]);

// A host/IP is TRUSTED when it is loopback, an RFC1918 private address, a
// tailnet CGNAT address (100.64.0.0/10 - the block `tailscale` assigns), an
// IPv6 ULA / link-local literal, or a *.ts.net MagicDNS name. An empty Host is
// trusted: HTTP/1.0 and some loopback clients omit it, and it cannot be the
// rebinding vector because rebinding REQUIRES a name in that header.
export function isTrustedHost(value: unknown): boolean {
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
  // IPv6 literals only (they contain a colon); a hostname like "fd.evil.com"
  // must not match.
  if (h.includes(":") && (h.startsWith("fd") || h.startsWith("fc") || h.startsWith("fe80"))) return true;
  return false;
}

export interface CrossSiteVerdict {
  blocked: boolean;
  reason?: string;
}

// Header-only so it is trivially unit-testable and framework-free; the Request
// wrapper below is the one line that knows about `Response`.
export function crossSiteVerdict(headers: { host?: string | null; origin?: string | null }): CrossSiteVerdict {
  const hostHeader = String(headers.host ?? "");
  const hostName = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (hostName && !isTrustedHost(hostName)) {
    return { blocked: true, reason: `untrusted Host '${hostName}' (DNS-rebinding guard)` };
  }
  const origin = headers.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) || u.host.toLowerCase() === hostHeader.toLowerCase();
    } catch {
      ok = false;
    }
    if (!ok) return { blocked: true, reason: `cross-site Origin '${origin}'` };
  }
  return { blocked: false };
}

// Returns the 403 Response when the request is blocked, or null to continue.
export function crossSiteBlocked(request: Request): Response | null {
  const verdict = crossSiteVerdict({
    host: request.headers.get("host"),
    origin: request.headers.get("origin")
  });
  if (!verdict.blocked) return null;
  return new Response(JSON.stringify({ error: "forbidden", reason: verdict.reason }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// Constant-time token compare. Lifted from src/lib/dispatch-machines.ts so the
// mesh's own auth does not grow a second, subtly different one.
//
// NOT USED BY THE PEER PROXY YET, and that is deliberate: day one a node calls
// a peer's PUBLISHED web-channel serve port, which is a browser-grade tailnet
// surface trusting loopback + tailnet exactly as it does today. A per-node MESH
// BEARER between peers is the phase-4 hardening. The state-service tokens are
// for the state service ONLY and must never be sent to a peer - a peer that
// receives one can impersonate this node to the authority.
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch. The length
  // of a token is not the secret.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
