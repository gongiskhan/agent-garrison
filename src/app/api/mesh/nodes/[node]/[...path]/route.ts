import type { NextRequest } from "next/server";
import { StateUnavailableError, stateDegraded, withState } from "@/lib/state-client";
import { readNodeIdentity } from "@/lib/node-identity";
import { crossSiteBlocked } from "@/lib/mesh/peer-auth";
import { MAX_BODY_BYTES, classifyPeerPath, forwardToPeer, peerAppBase, peerThreadUrl } from "@/lib/mesh/peer-proxy";
import { healthAppOrigin } from "@/lib/mesh/node-row";
import type { SessionInfo } from "@garrison/state-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cross-node session control. `/api/mesh/nodes/<node>/<...path>` is how this
// node watches, steers, stops and answers a session running on another one.
//
// It lives in the Next app rather than in a fitting for three reasons:
//
//  1. it is the one process on every node that already holds the registry
//     client, so it can resolve a peer's address;
//  2. its responses are SAME-ORIGIN to the browser, which satisfies the tailnet
//     hard rule (relative URLs only) with no new host allowance - the peer's
//     cross-origin surface is never handed to the page as a fetch target;
//  3. a fitting dies with `down`, and session control is precisely what you
//     need when the operative on the other machine is down.
//
// The security model is the allow-list in src/lib/mesh/peer-proxy.ts. It is
// checked FIRST, before the node is even resolved, so an unlisted path cannot
// be used to probe which node names exist.

interface Params {
  params: { node: string; path?: string[] };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function sessionsFor(node: string): Promise<SessionInfo[]> {
  return withState((client) => client.listSessions({ node }));
}

async function handle(request: NextRequest, { params }: Params): Promise<Response> {
  const blocked = crossSiteBlocked(request);
  if (blocked) return blocked;

  const segments = (params.path ?? []).filter((segment) => segment.length > 0);
  const classified = classifyPeerPath(request.method, segments);
  if (!classified.ok) {
    return json(classified.status, {
      error: classified.error,
      path: segments.join("/"),
      hint: "Only the mesh session-control allow-list is relayed between nodes."
    });
  }
  const route = classified.route;

  const node = params.node;
  const self = readNodeIdentity();
  const isSelf = node === self.id;
  // A REGISTRY read is a node-scoped query, not a call to that node, so it is
  // answerable for this machine too - which is what lets one UI list sessions
  // uniformly across the roster. Only a genuine FORWARD to self is refused.
  if (isSelf && route.upstream !== "registry") {
    // Not an error the caller should paper over by proxying to itself: the
    // local API is same-process, has no tailnet dependency, and answers when
    // this machine's own tailnet publication is broken.
    return json(421, { error: "self", node, hint: "call the local API directly" });
  }

  let registryNode;
  try {
    const nodes = await withState((client) => client.listNodes());
    registryNode = nodes.find((row) => row.name === node);
  } catch (err) {
    if (err instanceof StateUnavailableError) {
      const { since } = stateDegraded();
      return json(503, {
        error: "state-unavailable",
        since: since ?? err.since ?? new Date().toISOString(),
        url: err.url,
        hint: "The mesh cannot resolve peer addresses while the state service is unreachable."
      });
    }
    return json(502, { error: "registry-read-failed", detail: err instanceof Error ? err.message : String(err) });
  }
  // node.json is authoritative for THIS machine and the registry is its
  // replica, so a node that has not enrolled yet can still answer about itself.
  const tailnetHost = registryNode?.tailnetHost ?? (isSelf ? self.tailnetHost : null);
  const appOrigin = healthAppOrigin(registryNode?.health as Record<string, unknown> | undefined) ?? (isSelf ? self.appOrigin : null);
  if (!registryNode && !isSelf) return json(404, { error: "unknown-node", node });

  // The convenience read: served from the REGISTRY, never from the peer, so a
  // node that is offline still lists what it was running. `openUrl` is computed
  // here so the browser gets a ready-to-navigate HTTPS tailnet URL on the peer's
  // app origin (a navigation, not an embed).
  if (route.upstream === "registry") {
    let sessions: SessionInfo[];
    try {
      sessions = await sessionsFor(node);
    } catch (err) {
      if (err instanceof StateUnavailableError) {
        const { since } = stateDegraded();
        return json(503, { error: "state-unavailable", since: since ?? err.since ?? null, url: err.url });
      }
      return json(502, { error: "sessions-read-failed", node, detail: err instanceof Error ? err.message : String(err) });
    }
    const base = peerAppBase(tailnetHost, appOrigin);
    return json(200, {
      node,
      isSelf,
      tailnetHost,
      controlBase: base,
      sessions: sessions.map((session) => ({
        ...session,
        openUrl: base ? peerThreadUrl(base, session.threadId) : null
      }))
    });
  }

  const base = peerAppBase(tailnetHost, appOrigin);
  if (!base) {
    return json(502, {
      error: "peer-unaddressable",
      node,
      hint: "This node has no tailnet host recorded, so it cannot be reached from here."
    });
  }

  let body: string | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json(413, { error: "body-too-large", limit: MAX_BODY_BYTES });
    }
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "body-too-large", limit: MAX_BODY_BYTES });
    }
    body = raw.toString("utf8");
  }

  const response = await forwardToPeer({
    node,
    base,
    path: route.path,
    search: new URL(request.url).search,
    method: request.method,
    body,
    contentType: request.headers.get("content-type"),
    accept: request.headers.get("accept"),
    sse: route.sse,
    // A closed tab must close the upstream connection. Without this an SSE
    // watch leaks its peer connection for the life of the process.
    signal: request.signal
  });
  return response;
}

export async function GET(request: NextRequest, ctx: Params) {
  return handle(request, ctx);
}

export async function POST(request: NextRequest, ctx: Params) {
  return handle(request, ctx);
}

export async function PUT(request: NextRequest, ctx: Params) {
  return handle(request, ctx);
}
