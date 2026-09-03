// The cross-node session control proxy: what a node is allowed to ask a peer,
// where that peer's surface actually lives, and how a request is forwarded.
//
// The route module (src/app/api/mesh/nodes/[node]/[...path]/route.ts) is
// transport and registry lookups; every decision worth testing is here.
//
// THE ALLOW-LIST IS THE WHOLE SECURITY MODEL. A generic peer proxy pointed at
// an app that trusts loopback is remote code execution with extra steps - the
// peer's app also carries /api/attachments, /api/file, the remote-shell relay
// and every other Garrison API, and none of those may be reachable from another
// machine. So: a closed table of (shape, method) pairs, matched before anything
// else happens, and an unlisted path is refused without ever being resolved.
//
// Node-to-node auth, stated honestly: day one there is none beyond the tailnet.
// The proxy calls the peer's PUBLISHED app origin over HTTPS, which is the same
// browser-grade surface a person on the tailnet already reaches; the peer trusts
// loopback + tailnet exactly as it does today. A per-node mesh bearer (mint at
// registration, `$GARRISON_HOME/mesh-token`, resolved back to a node id by the
// state service) is the phase-4 hardening. State-service tokens are for the
// state service ONLY - see peer-auth.ts.

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
  // The peer's Garrison app, published at the tailnet root. Conversations
  // (threads, live streams, inputs, interrupt, routing, permissions) are served
  // by the app itself since the talk engine moved into the shell, so the whole
  // control surface is one origin per node - no per-fitting serve port to
  // resolve, and nothing that dies with `down`.
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
  { shape: ["threads"], methods: ["GET"], upstream: "app" },
  { shape: ["threads", ID], methods: ["GET"], upstream: "app" },
  { shape: ["threads", ID, "live"], methods: ["GET"], upstream: "app", sse: true },
  { shape: ["threads", ID, "inputs"], methods: ["GET", "POST"], upstream: "app" },
  { shape: ["threads", ID, "inputs", ID, "live"], methods: ["GET"], upstream: "app", sse: true },
  { shape: ["threads", ID, "interrupt"], methods: ["POST"], upstream: "app" },
  { shape: ["threads", ID, "routing"], methods: ["GET", "PUT"], upstream: "app" },
  { shape: ["threads", ID, "permissions", ID], methods: ["POST"], upstream: "app" },
  { shape: ["mesh", "self"], methods: ["GET"], upstream: "app" },
  { shape: ["sessions"], methods: ["GET"], upstream: "registry" },
  // The Shells session list's live transcript for one of THIS peer's OWN
  // sessions (packages/talk/src/router.mjs GET /api/sessions/:id/stream) -
  // distinct from the row above, which reads the gateway's unrelated session
  // registry. Not the same "sessions" concept; kept apart on purpose.
  { shape: ["sessions", ID, "stream"], methods: ["GET"], upstream: "app", sse: true }
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

/** The Conversations deep link for a thread on a peer - the "Open on <node>"
 *  target. Same route the local shell uses, on the peer's app origin. */
export function peerThreadUrl(base: string, threadId: string | null | undefined): string {
  return threadId ? `${base}/talk/${encodeURIComponent(threadId)}` : `${base}/talk`;
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
