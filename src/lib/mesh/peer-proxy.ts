// The cross-node session control proxy: what a node is allowed to ask a peer,
// where that peer's surface actually lives, and how a request is forwarded.
//
// The route module (src/app/api/mesh/nodes/[node]/[...path]/route.ts) is
// transport and registry lookups; every decision worth testing is here.
//
// THE ALLOW-LIST IS THE WHOLE SECURITY MODEL. A generic peer proxy pointed at
// a fitting that trusts loopback is remote code execution with extra steps -
// the peer's web-channel surface also carries /api/attachments, /file and the
// remote-shell relay, and none of those may be reachable from another machine.
// So: a closed table of (shape, method) pairs, matched before anything else
// happens, and an unlisted path is refused without ever being resolved.
//
// Node-to-node auth, stated honestly: day one there is none beyond the tailnet.
// The proxy calls the peer's PUBLISHED web-channel serve port over HTTPS, which
// is the same browser-grade surface a person on the tailnet already reaches;
// the peer's fitting trusts loopback + tailnet exactly as it does today. A
// per-node mesh bearer (mint at registration, `$GARRISON_HOME/mesh-token`,
// resolved back to a node id by the state service) is the phase-4 hardening.
// State-service tokens are for the state service ONLY - see peer-auth.ts.

import type { SessionInfo } from "@garrison/state-client";

// ── The serve-port invariant ────────────────────────────────────────────────
// Every node runs the committed port map at offset 0, and
// `scripts/tailnet-serve-views.mjs` publishes local port P at 8400 + (P % 1000).
// Together those make a peer's view URL COMPUTABLE - https://<host>:<servePort>
// - without asking the peer anything. tests/mesh-serve-ports.test.ts pins the
// formula against the script; tests/mesh-proxy.test.ts pins this copy of it
// against the same source.
export const MESH_SERVE_PORT_BASE = 8400;

// The publisher skips these when it picks a serve port (443 and the funnel
// ports), so the computation must skip them identically or it would name a port
// nothing is listening on. It does NOT model the publisher's collision bump:
// every committed own-port default lands on a distinct serve port already
// (tests/mesh-serve-ports.test.ts), so a bump means a machine-local mapping
// this formula was never able to predict anyway.
export const RESERVED_SERVE_PORTS: ReadonlySet<number> = new Set([443, 8443, 8444, 8445]);

export function meshServePort(localPort: number): number {
  let p = MESH_SERVE_PORT_BASE + (localPort % 1000);
  while (RESERVED_SERVE_PORTS.has(p)) p += 1;
  return p;
}

// The web-channel fitting's committed default port, from
// fittings/seed/web-channel-default/apm.yml (`config.default_port`). It is the
// FALLBACK only: a session row's `body.controlPort` is what that node's
// web-channel actually bound and always wins. Pinned against the manifest by
// tests/mesh-proxy.test.ts, so a manifest edit fails the suite instead of
// silently pointing the mesh at a dead port.
export const WEB_CHANNEL_DEFAULT_PORT = 8083;

export const MAX_BODY_BYTES = 256 * 1024;
export const PROXY_TIMEOUT_MS = 20_000;
// SSE budget. Applied to the CONNECT + response-headers phase only - see
// forwardToPeer: a live turn stream legitimately outlives any fixed deadline,
// and cutting it at 125s would make cross-node watching lie about a session
// that went quiet. Once bytes are flowing, only the caller's own signal (the
// browser closing the tab) ends the stream.
export const SSE_CONNECT_TIMEOUT_MS = 125_000;

// ── The allow-list ──────────────────────────────────────────────────────────

/** Which surface on the peer answers a permitted path. */
export type PeerUpstream =
  // The peer's web-channel fitting, on its own published serve port.
  | "control"
  // The peer's Garrison app, published at the tailnet root.
  | "app"
  // Not the peer at all: answered from the shared registry, so it works while
  // the peer is down.
  | "registry";

const ID = Symbol("id-segment");
type Shape = readonly (string | typeof ID)[];

interface AllowRule {
  shape: Shape;
  methods: readonly string[];
  upstream: PeerUpstream;
  sse?: boolean;
}

// Exactly the endpoints cross-node watch / steer / stop / answer need. Adding a
// row here widens what every node in the mesh may do to every other node.
const ALLOW: readonly AllowRule[] = [
  { shape: ["threads"], methods: ["GET"], upstream: "control" },
  { shape: ["threads", ID], methods: ["GET"], upstream: "control" },
  { shape: ["threads", ID, "live"], methods: ["GET"], upstream: "control", sse: true },
  { shape: ["threads", ID, "inputs"], methods: ["GET", "POST"], upstream: "control" },
  { shape: ["threads", ID, "inputs", ID, "live"], methods: ["GET"], upstream: "control", sse: true },
  { shape: ["threads", ID, "interrupt"], methods: ["POST"], upstream: "control" },
  { shape: ["threads", ID, "routing"], methods: ["GET", "PUT"], upstream: "control" },
  { shape: ["threads", ID, "permissions", ID], methods: ["POST"], upstream: "control" },
  { shape: ["mesh", "self"], methods: ["GET"], upstream: "app" },
  { shape: ["sessions"], methods: ["GET"], upstream: "registry" }
];

// An id segment is opaque to us but must not be able to move the request: no
// slashes (Next already split on those), no traversal, no encoded surprises.
// The cap matches the web channel's own 512-char ceiling on request ids.
const ID_RE = /^[A-Za-z0-9._-]{1,512}$/;

export function validIdSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return false;
  return ID_RE.test(segment);
}

export interface PeerRoute {
  upstream: PeerUpstream;
  /** Path on the upstream, already encoded. Empty for `registry`. */
  path: string;
  sse: boolean;
  /** The thread id, when the path names one - used to pick the session row. */
  threadId: string | null;
}

export type ClassifyResult =
  | { ok: true; route: PeerRoute }
  | { ok: false; status: 403 | 405; error: string };

function shapeMatches(shape: Shape, segments: string[]): boolean {
  if (shape.length !== segments.length) return false;
  for (let i = 0; i < shape.length; i += 1) {
    const expected = shape[i];
    if (expected === ID) {
      if (!validIdSegment(segments[i])) return false;
    } else if (expected !== segments[i]) {
      return false;
    }
  }
  return true;
}

// 403 when no permitted shape matches at all - an unlisted path is refused
// flatly, without hinting which methods might have worked. 405 only when the
// path IS permitted and the method is not, which is a real client bug worth
// naming.
export function classifyPeerPath(method: string, segments: string[]): ClassifyResult {
  const verb = method.toUpperCase();
  const matched = ALLOW.filter((rule) => shapeMatches(rule.shape, segments));
  if (matched.length === 0) return { ok: false, status: 403, error: "not-relayed" };
  const rule = matched.find((candidate) => candidate.methods.includes(verb));
  if (!rule) {
    return { ok: false, status: 405, error: "method-not-relayed" };
  }
  const threadId = segments[0] === "threads" && segments.length > 1 ? segments[1] : null;
  return {
    ok: true,
    route: {
      upstream: rule.upstream,
      // Both peer surfaces mount these under /api/, and the segments are the
      // same ones we matched - re-encoded so a legal-but-odd id survives.
      path: rule.upstream === "registry" ? "" : `/api/${segments.map(encodeURIComponent).join("/")}`,
      sse: rule.sse === true,
      threadId
    }
  };
}

/** Every path this proxy relays, as strings, for tests and documentation. */
export function allowListDescription(): string[] {
  return ALLOW.map((rule) => {
    const path = rule.shape.map((s) => (s === ID ? ":id" : s)).join("/");
    return `${rule.methods.join("|")} ${path}${rule.sse ? " (SSE)" : ""}`;
  });
}

// ── Where the peer is ───────────────────────────────────────────────────────

// The peer's Garrison app. Each node publishes its app at the tailnet ROOT
// (the `tailscale serve` mapping the installer makes), which is why MeshPanel's
// "Open <node>" link is a bare https://<host> - same address, no port.
export function peerAppBase(tailnetHost: string | null | undefined): string | null {
  const host = String(tailnetHost ?? "").trim().replace(/\.$/, "");
  if (!host) return null;
  return `https://${host}`;
}

// The peer's web-channel surface, rehosted from the LOOPBACK url the session
// registry honestly records onto the address a peer can actually dial.
export function peerControlBase(
  tailnetHost: string | null | undefined,
  controlPort: number = WEB_CHANNEL_DEFAULT_PORT
): string | null {
  const host = String(tailnetHost ?? "").trim().replace(/\.$/, "");
  if (!host) return null;
  const port = Number.isFinite(controlPort) && controlPort > 0 ? Math.trunc(controlPort) : WEB_CHANNEL_DEFAULT_PORT;
  return `https://${host}:${meshServePort(port)}`;
}

// Which local port that node's web channel bound, per the session registry.
// Prefer the row for the thread being addressed, then any live row, then the
// committed default. `controlUrl` is deliberately NOT parsed for a host - it is
// a loopback URL and rehosting it is the entire job - but its port is a fine
// second source when an older row carries no `body.controlPort`.
export function resolvePeerControlPort(sessions: readonly SessionInfo[], threadId?: string | null): number {
  const ordered = threadId
    ? [...sessions].sort((a, b) => Number(b.threadId === threadId) - Number(a.threadId === threadId))
    : sessions;
  for (const session of ordered) {
    const fromBody = Number((session.body as { controlPort?: unknown } | undefined)?.controlPort);
    if (Number.isFinite(fromBody) && fromBody > 0) return Math.trunc(fromBody);
    let fromUrl = NaN;
    try {
      if (session.controlUrl) fromUrl = Number(new URL(session.controlUrl).port);
    } catch {
      /* a row with an unparseable controlUrl just does not vote */
    }
    if (Number.isFinite(fromUrl) && fromUrl > 0) return Math.trunc(fromUrl);
  }
  return WEB_CHANNEL_DEFAULT_PORT;
}

/** The web-channel deep link for a thread - the "Open on <node>" target. */
export function peerThreadUrl(base: string, threadId: string | null | undefined): string {
  return threadId ? `${base}/?thread=${encodeURIComponent(threadId)}` : base;
}

// A resolved control port per peer, cached briefly. Without it every proxied
// call would cost a second state round trip just to learn a port that only
// changes when that node's web channel restarts.
//
// It lives here rather than in the route module because a Next route file may
// only export handlers and the framework's config keys - an extra export there
// fails `next build`'s generated type check - and a cache with no way to clear
// it is untestable.
export const CONTROL_PORT_TTL_MS = 60_000;
const controlPorts = new Map<string, { at: number; port: number }>();

export function cachedPeerControlPort(node: string, now = Date.now()): number | null {
  const hit = controlPorts.get(node);
  if (!hit || now - hit.at >= CONTROL_PORT_TTL_MS) return null;
  return hit.port;
}

export function rememberPeerControlPort(node: string, port: number, now = Date.now()): void {
  controlPorts.set(node, { at: now, port });
}

/** Called when a peer stops answering, so a restarted node heals on the next
 *  attempt instead of 502ing for the rest of the TTL. */
export function forgetPeerControlPort(node: string): void {
  controlPorts.delete(node);
}

export function resetPeerControlPortCache(): void {
  controlPorts.clear();
}

// ── Forwarding ──────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// One controller aborted by any of its inputs. `AbortSignal.any` would do this
// on Node >= 20.3, but the timeout half has to be RELEASABLE for SSE (below),
// so the controller is explicit either way.
function linkSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    }
  };
}

export interface ForwardInput {
  /** Only for the 502 body - the caller already resolved the base from it. */
  node: string;
  base: string;
  path: string;
  /** Raw query string including the leading "?", or "". */
  search?: string;
  method: string;
  body?: string | null;
  contentType?: string | null;
  accept?: string | null;
  sse?: boolean;
  /** The browser's request signal. Wiring it is not optional: without it a
   *  closed tab leaks the upstream connection for the life of the process. */
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// Forward one request and hand back the peer's answer.
//
// STATUS IS PASSED THROUGH VERBATIM, and the 409 is the reason that rule is
// written down: permission resolver closures are process-local, so a decision
// answered after the peer's gateway restarted is genuinely unanswerable. The
// honest surface is the peer's own 409 - never a retry, never a queue, never an
// optimistic "resolved" in this process.
export async function forwardToPeer(input: ForwardInput): Promise<Response> {
  const doFetch = input.fetchImpl ?? fetch;
  const sse = input.sse === true;
  const timeoutMs = input.timeoutMs ?? (sse ? SSE_CONNECT_TIMEOUT_MS : PROXY_TIMEOUT_MS);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("peer timeout")), timeoutMs);
  const linked = linkSignals([input.signal, timeout.signal]);

  const headers: Record<string, string> = {};
  if (input.body != null) headers["content-type"] = input.contentType || "application/json";
  if (input.accept) headers.accept = input.accept;
  else if (sse) headers.accept = "text/event-stream";

  const target = `${input.base}${input.path}${input.search ?? ""}`;

  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method: input.method,
      headers,
      body: input.body ?? undefined,
      signal: linked.signal,
      // Never follow a redirect off the node we resolved: the allow-list is
      // about which SURFACE is reachable, and a 302 would route around it.
      redirect: "manual",
      cache: "no-store"
    });
  } catch (err) {
    clearTimeout(timer);
    linked.dispose();
    if (input.signal?.aborted) {
      // The client hung up. 499 is nginx's, not the standard's, but nothing in
      // the RFC range describes it and the caller is gone to read it anyway.
      return json(499, { error: "client-closed", node: input.node });
    }
    return json(502, {
      error: "peer-unreachable",
      node: input.node,
      base: input.base,
      detail: err instanceof Error ? err.message : String(err)
    });
  }

  const upstreamType = upstream.headers.get("content-type") ?? "";

  if (sse && upstream.body && upstreamType.includes("text/event-stream")) {
    // Headers are in; the stream may now run as long as the client wants it.
    // The timeout was a CONNECT budget, and holding it here would truncate a
    // quiet-but-live turn at exactly the moment watching matters most.
    //
    // `linked` is deliberately NOT disposed: its listener on the client's
    // signal is what aborts the upstream fetch - and with it the response body
    // - when the tab closes. Dropping it here is exactly the leak the wiring
    // exists to prevent.
    clearTimeout(timer);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstreamType,
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  }

  try {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": upstreamType || "application/json",
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    return json(502, {
      error: "peer-read-failed",
      node: input.node,
      base: input.base,
      detail: err instanceof Error ? err.message : String(err)
    });
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }
}

export const peerProxyResponses = { json };
