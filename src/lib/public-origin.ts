// The origin the USER'S BROWSER used to reach us — not the one this process saw.
//
// Garrison is used from other machines over `tailscale serve`, which terminates
// TLS and proxies to loopback. Server-side, `new URL(request.url).origin` is
// therefore the PROXY TARGET (`http://localhost:8777`), never the tailnet origin
// the browser is actually on. Anything built from it and handed back to the
// client is unreachable — the same hard rule that governs iframe/img/link URLs,
// which is easy to miss here because the value is not obviously "a URL for the
// client" until something like an OAuth provider redirects to it.
//
// Trusting `x-forwarded-*` is safe in this deployment and only here: Garrison
// binds loopback and is reached either directly or through tailscale serve, so
// there is no untrusted hop that could forge these. A spoofed value could at
// worst redirect the user's own OAuth callback somewhere else in their own
// browser; it grants no access, since the callback still requires the
// single-use state this process minted.
export function publicOrigin(request: Request): string {
  const h = request.headers;
  // A proxy chain appends, so the ORIGINAL client value is the first entry.
  const first = (value: string | null) => value?.split(",")[0]?.trim() || "";
  const host = first(h.get("x-forwarded-host")) || first(h.get("host"));
  if (!host) return new URL(request.url).origin;
  const proto = first(h.get("x-forwarded-proto"))
    // tailscale serve sets x-forwarded-proto; without it, fall back to the
    // scheme this process was reached on rather than assuming https, so a plain
    // local http:// session keeps working.
    || new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}
