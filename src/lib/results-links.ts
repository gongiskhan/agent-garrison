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

export async function resultLinks(request: Request, runId: string): Promise<ResultLinks> {
  const path = `/results/${encodeURIComponent(runId)}`;
  const origin = publicOrigin(request);
  let tailnet: string | null = null;
  try {
    tailnet = await tailnetUrlForPort(appPort());
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
