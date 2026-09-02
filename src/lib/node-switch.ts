// Where "the same page on another node" is. Every node publishes its app at
// its tailnet root (peerAppBase in src/lib/mesh/peer-proxy.ts), so a switch is
// the current pathname and query on the peer's https origin - a full
// navigation, never a fetch: the peer is a different origin with its own
// session, service worker and pins materialisation.
//
// Pure so the switcher's one decision is unit-testable without a DOM.

export function nodeAppOrigin(tailnetHost: string | null | undefined): string | null {
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
  search = ""
): string | null {
  const origin = nodeAppOrigin(tailnetHost);
  if (!origin) return null;
  const path = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  const query = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `${origin}${path}${query}`;
}

/** True when `origin` names the same app as `tailnetHost` (scheme and case
 *  insensitive on the host, trailing dot and slash tolerant). The app's node
 *  records store the origin the user typed; the mesh roster stores the host. */
export function sameNodeOrigin(origin: string | null | undefined, tailnetHost: string | null | undefined): boolean {
  const want = nodeAppOrigin(tailnetHost);
  if (!want || !origin) return false;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`.toLowerCase() === want;
  } catch {
    return false;
  }
}
