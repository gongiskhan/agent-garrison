import { NextResponse, type NextRequest } from "next/server";

// A proxied fitting's bundle (kanban, monitor, ports, power, automations,
// file-browser, ...) issues its runtime data fetches root-absolute
// (fetch("/board"), fetch("/api/ports"), ...) because it has no idea it is
// being served under /api/fittings/proxy/<id>/ rather than its own origin.
// Those requests resolve against the SHELL origin and 404
// (AGENTS.md "Instances, ports, and deploying" — a proxied document must
// stay same-origin; this is the runtime-fetch half of that same problem,
// the HTML/CSS half is handled in the proxy route itself).
//
// The signal that a request came from a proxied fitting page is its
// Referer: only a page actually served at /api/fittings/proxy/<id>/...
// carries that Referer, so a genuine shell page (e.g. /host-map,
// /api/conversation) is never touched — its Referer is a shell URL.
const PROXY_PREFIX = "/api/fittings/proxy/";
const FITTING_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith(PROXY_PREFIX) || pathname.startsWith("/_next/")) {
    return NextResponse.next();
  }

  const referer = req.headers.get("referer");
  if (!referer) return NextResponse.next();

  let refererPath: string;
  try {
    refererPath = new URL(referer).pathname;
  } catch {
    return NextResponse.next();
  }
  if (!refererPath.startsWith(PROXY_PREFIX)) return NextResponse.next();

  const fittingId = refererPath.slice(PROXY_PREFIX.length).split("/")[0];
  if (!fittingId || !FITTING_ID_RE.test(fittingId)) return NextResponse.next();

  const rewritten = req.nextUrl.clone();
  rewritten.pathname = `${PROXY_PREFIX}${fittingId}${pathname}`;
  return NextResponse.rewrite(rewritten);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
