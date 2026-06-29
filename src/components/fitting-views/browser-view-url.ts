"use client";

// Own-port Fitting views are written to ~/.garrison/ui-fittings/<id>.json with
// a canonical loopback URL (http://127.0.0.1:<port>) — correct for the server's
// own health probe, but wrong as a *browser* link: a user who reached Garrison
// over Tailscale or the LAN would open THEIR OWN device's localhost, not the
// machine running the Fitting. Only the browser knows which host the user is on,
// so rewrite the loopback host to window.location.hostname at render time
// (preserving scheme, port, and path). This mirrors the dev-env browser-pane's
// existing `//${window.location.hostname}:${port}` rewrite — now shared so every
// view link works everywhere, not just on localhost.
//
// During SSR (no window) or when the browser is already on localhost, the URL is
// returned unchanged.

const LOOPBACK_HOST = /^(https?:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;

export function browserViewUrl(url: string | null | undefined): string {
  if (!url) return url ?? "";
  if (typeof window === "undefined") return url; // SSR — no host to rebind to
  const here = window.location.hostname;
  // Already on loopback (local dev) — nothing to rewrite, and rebinding to
  // "localhost"/"127.0.0.1" would be a no-op anyway.
  if (!here || here === "127.0.0.1" || here === "localhost") return url;
  return url.replace(LOOPBACK_HOST, `$1${here}`);
}

// Pick the right URL for an own-port view given where the browser actually is:
//   - on localhost            -> the loopback `url` (direct, fastest)
//   - over Tailscale, mapped  -> the HTTPS `tailnetUrl` (reachable + same-scheme,
//                                so no mixed content; `tailscale serve` proxies
//                                HTTP/WS/SSE), when its host matches the page host
//   - any other remote host   -> best-effort loopback-host rebind (LAN/http)
// Garrison is only reachable off-box via `tailscale serve`, so "remote" is
// normally the tailnet host; the rebind is a safety fallback.
export function resolveViewUrl(view: {
  url: string | null | undefined;
  tailnetUrl?: string | null;
}): string {
  const url = view?.url ?? "";
  if (!url) return url;
  if (typeof window === "undefined") return url;
  const here = window.location.hostname;
  if (!here || here === "127.0.0.1" || here === "localhost") return url;
  if (view.tailnetUrl) {
    try {
      if (new URL(view.tailnetUrl).hostname === here) return view.tailnetUrl;
    } catch {
      // fall through to the rebind fallback
    }
  }
  return browserViewUrl(url);
}
