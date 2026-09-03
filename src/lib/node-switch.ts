// Where "the same page on another node" is. Every node publishes its app at
// its tailnet root (peerAppBase in src/lib/mesh/peer-proxy.ts), so a switch is
// the current pathname and query on the peer's https origin - a full
// navigation, never a fetch: the peer is a different origin with its own
// session, service worker and pins materialisation.
//
// Pure so the switcher's one decision is unit-testable without a DOM.

// A tethered node (csg) has no tailnet interface of its own - its published
// origin (appOrigin, on the OWNER's tailnet host) is the only way to reach it,
// so it is preferred whenever present. An ordinary node has no appOrigin and
// falls back to deriving `https://<tailnetHost>` exactly as before.
export function nodeAppOrigin(
  tailnetHost: string | null | undefined,
  appOrigin?: string | null
): string | null {
  if (typeof appOrigin === "string" && appOrigin.trim()) {
    try {
      const u = new URL(appOrigin.trim());
      if (u.protocol === "https:") return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through to the tailnetHost derivation */
    }
  }
  const host = String(tailnetHost ?? "").trim().replace(/\.$/, "").toLowerCase();
  if (!host) return null;
  // A host, not a URL: anything with a scheme, path or port is not a tailnet
  // host the installer would have registered.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  return `https://${host}`;
}

export function nodePageUrl(
  tailnetHost: string | null | undefined,
  pathname: string,
  search = "",
  appOrigin?: string | null
): string | null {
  const origin = nodeAppOrigin(tailnetHost, appOrigin);
  if (!origin) return null;
  const path = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  const query = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `${origin}${path}${query}`;
}

/** True when `origin` names the same app as `tailnetHost`/`appOrigin` (scheme
 *  and case insensitive on the host, trailing dot and slash tolerant). The
 *  app's node records store the origin the user typed; the mesh roster stores
 *  the host (and, for a tethered node, its own appOrigin). */
export function sameNodeOrigin(
  origin: string | null | undefined,
  tailnetHost: string | null | undefined,
  appOrigin?: string | null
): boolean {
  const want = nodeAppOrigin(tailnetHost, appOrigin);
  if (!want || !origin) return false;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`.toLowerCase() === want;
  } catch {
    return false;
  }
}
