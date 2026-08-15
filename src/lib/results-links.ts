import { publicOrigin } from "./public-origin";
import { tailnetUrlForPort } from "./tailnet-serve";
import { appPort } from "./instance-profile";

// Where a report link points. The reporting session prints this as the last
// line of its output so it is tappable from the phone the moment the session
// ends - which means the DEFAULT must be the tailnet URL, not the loopback one
// the ingest call happened to arrive on. Ingest normally arrives over
// 127.0.0.1 (the MCP wrapper, or curl from a bash tool), so publicOrigin alone
// would hand the phone an unreachable link.
//
// Only prod is published to the tailnet, so a dev instance has no mapping and
// honestly falls back to the origin the request came in on.

export interface ResultLinks {
  path: string; // always relative - safe for anything embedded same-origin
  url: string; // the one to print: tailnet when published, else this origin
  tailnetUrl: string | null;
  localUrl: string;
}

// The serve map keys the app's root mapping as `host:443`, so the raw form is
// `https://host:443/...`. Valid, but this link is printed for a human to read
// and tap, and an explicit default port reads as a mistake. URL parsing drops
// it for us; anything unparseable is returned untouched rather than mangled.
export function tidyOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

export async function resultLinks(request: Request, runId: string): Promise<ResultLinks> {
  const path = `/results/${encodeURIComponent(runId)}`;
  const origin = tidyOrigin(publicOrigin(request));
  let tailnet: string | null = null;
  try {
    const mapped = await tailnetUrlForPort(appPort());
    tailnet = mapped ? tidyOrigin(mapped) : null;
  } catch {
    // tailscale missing or unreadable - the loopback/origin form still works
  }
  return {
    path,
    url: `${tailnet ?? origin}${path}`,
    tailnetUrl: tailnet ? `${tailnet}${path}` : null,
    localUrl: `${origin}${path}`
  };
}
