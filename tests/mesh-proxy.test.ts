// Cross-node session control: the allow-list that IS the security model, the
// peer addressing (the app at the tailnet root), and the wire behaviour of a
// forwarded request.
//
// Two lanes:
//
//   - pure units for everything a decision depends on (allow-list, addressing,
//     body cap, self-detection), and
//   - a real stub peer over real HTTP for the things only a socket can prove:
//     that the method/body/headers arrive, that an SSE stream relays chunk by
//     chunk, that a 409 comes back VERBATIM, and that a client hanging up
//     actually closes the upstream connection instead of leaking it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { StateClient } from "@garrison/state-client";
import { startStateService } from "./state-service-harness";
import {
  MAX_BODY_BYTES,
  PROXY_TIMEOUT_MS,
  SSE_CONNECT_TIMEOUT_MS,
  allowListDescription,
  classifyPeerPath,
  forwardToPeer,
  peerAppBase,
  peerThreadUrl,
  validIdSegment
} from "@/lib/mesh/peer-proxy";
import { crossSiteVerdict, isTrustedHost, tokenMatches } from "@/lib/mesh/peer-auth";


// ── The allow-list ──────────────────────────────────────────────────────────

describe("peer proxy allow-list", () => {
  const allowed: [string, string[]][] = [
    ["GET", ["threads"]],
    ["GET", ["threads", "t-1"]],
    ["GET", ["threads", "t-1", "live"]],
    ["GET", ["threads", "t-1", "inputs"]],
    ["POST", ["threads", "t-1", "inputs"]],
    ["GET", ["threads", "t-1", "inputs", "in-9", "live"]],
    ["POST", ["threads", "t-1", "interrupt"]],
    ["GET", ["threads", "t-1", "routing"]],
    ["PUT", ["threads", "t-1", "routing"]],
    ["POST", ["threads", "t-1", "permissions", "req-4"]],
    ["GET", ["mesh", "self"]],
    ["GET", ["sessions"]],
    ["GET", ["sessions", "sess-1", "stream"]]
  ];

  it.each(allowed)("relays %s /%s", (method, segments) => {
    const result = classifyPeerPath(method, segments as string[]);
    expect(result.ok, `${method} ${(segments as string[]).join("/")} should be relayed`).toBe(true);
  });

  it("the shells session-stream row is distinct from the registry sessions row", () => {
    const list = classifyPeerPath("GET", ["sessions"]);
    const stream = classifyPeerPath("GET", ["sessions", "sess-1", "stream"]);
    expect(list.ok && list.route.upstream).toBe("registry");
    expect(stream.ok && stream.route.upstream).toBe("app");
    expect(stream.ok && stream.route.sse).toBe(true);
    expect(stream.ok && stream.route.path).toBe("/api/sessions/sess-1/stream");
  });

  it("every allowed path is described, and the description is the table", () => {
    // A cheap tripwire on the thing that must never grow by accident: if a row
    // is added to ALLOW, this count changes and the diff is visible in review.
    expect(allowListDescription()).toHaveLength(11);
  });

  // These are the paths a generic passthrough WOULD have exposed. The web
  // channel's own surface carries attachments, arbitrary file reads and the
  // remote-shell relay; the app carries the vault. None may cross a node
  // boundary.
  const refused = [
    ["GET", ["vault", "secrets"]],
    ["PUT", ["vault", "secrets"]],
    ["POST", ["attachments"]],
    ["GET", ["file"]],
    ["GET", ["remote-shell", "sessions"]],
    ["POST", ["remote-shell", "sessions", "s-1", "input"]],
    ["GET", ["host-map"]],
    ["POST", ["chat"]],
    ["GET", ["compositions"]],
    ["POST", ["runner", "default", "up"]],
    ["POST", ["threads", "t-1", "messages"]],
    ["GET", ["threads", "t-1", "..", "..", "vault"]],
    ["GET", ["mesh", "nodes"]],
    ["GET", ["secrets"]]
  ] as const;

  it.each(refused)("refuses %s /%s", (method, segments) => {
    const result = classifyPeerPath(method, segments as unknown as string[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("a permitted path with the wrong method is 405, not 403", () => {
    // DELETE /threads/:id exists on the web channel and deletes a conversation.
    // It is deliberately NOT relayed, and the distinction matters: 403 means
    // "no such relayed path", 405 means "that path, not that verb".
    const del = classifyPeerPath("DELETE", ["threads", "t-1"]);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.status).toBe(405);

    const put = classifyPeerPath("PUT", ["threads", "t-1", "inputs"]);
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.status).toBe(405);

    // Thread CREATE is deliberately not relayed: a peer may watch, steer and
    // stop what is already running there, not open new conversations on it.
    const create = classifyPeerPath("POST", ["threads"]);
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.status).toBe(405);
  });

  it("rejects traversal and separator smuggling in an id segment", () => {
    expect(validIdSegment("..")).toBe(false);
    expect(validIdSegment(".")).toBe(false);
    expect(validIdSegment("a/b")).toBe(false);
    expect(validIdSegment("a?b=c")).toBe(false);
    expect(validIdSegment("")).toBe(false);
    expect(validIdSegment("x".repeat(513))).toBe(false);
    expect(validIdSegment("thread-2026_08.24")).toBe(true);

    const traversal = classifyPeerPath("GET", ["threads", "..", "live"]);
    expect(traversal.ok).toBe(false);
  });

  it("routes each permitted path to the surface that actually answers it", () => {
    // Conversations live in the app since the talk engine moved into the shell,
    // so every thread path is answered by the peer's app origin.
    const thread = classifyPeerPath("GET", ["threads", "t-1", "live"]);
    expect(thread.ok && thread.route).toMatchObject({
      upstream: "app",
      path: "/api/threads/t-1/live",
      sse: true,
      threadId: "t-1"
    });

    const self = classifyPeerPath("GET", ["mesh", "self"]);
    expect(self.ok && self.route).toMatchObject({ upstream: "app", path: "/api/mesh/self", sse: false });

    // The registry read never touches the peer, which is exactly why it works
    // when the peer is offline.
    const sessions = classifyPeerPath("GET", ["sessions"]);
    expect(sessions.ok && sessions.route).toMatchObject({ upstream: "registry", path: "" });
  });

  it("only the live streams are marked SSE", () => {
    expect(classifyPeerPath("GET", ["threads", "t-1", "live"]).ok && true).toBe(true);
    const nonLive = classifyPeerPath("GET", ["threads", "t-1"]);
    expect(nonLive.ok && nonLive.route.sse).toBe(false);
    const inputLive = classifyPeerPath("GET", ["threads", "t-1", "inputs", "9", "live"]);
    expect(inputLive.ok && inputLive.route.sse).toBe(true);
  });
});

// ── Peer addressing ─────────────────────────────────────────────────────────

describe("peer addressing", () => {
  it("addresses the peer's app at its tailnet root", () => {
    expect(peerAppBase("mac-pro.tail31efa.ts.net")).toBe("https://mac-pro.tail31efa.ts.net");
    // Trailing dot: `tailscale status --json` reports DNSName with one.
    expect(peerAppBase("mac-pro.tail31efa.ts.net.")).toBe("https://mac-pro.tail31efa.ts.net");
  });

  it("is null - never a guess - when a node has no tailnet host", () => {
    expect(peerAppBase(null)).toBeNull();
    expect(peerAppBase("")).toBeNull();
    expect(peerAppBase(undefined)).toBeNull();
  });

  it("deep-links a thread on the peer's Conversations route", () => {
    expect(peerThreadUrl("https://mac-pro.tail31efa.ts.net", "t 1")).toBe(
      "https://mac-pro.tail31efa.ts.net/talk/t%201"
    );
    expect(peerThreadUrl("https://x", null)).toBe("https://x/talk");
  });

  it("holds the documented caps", () => {
    expect(MAX_BODY_BYTES).toBe(256 * 1024);
    expect(PROXY_TIMEOUT_MS).toBe(20_000);
    expect(SSE_CONNECT_TIMEOUT_MS).toBe(125_000);
  });
});

// ── The local-origin guard ──────────────────────────────────────────────────

describe("peer auth guard", () => {
  it("keeps the fittings' trusted-host behaviour exactly", () => {
    expect(isTrustedHost("127.0.0.1")).toBe(true);
    expect(isTrustedHost("localhost")).toBe(true);
    expect(isTrustedHost("dev-madrid.tail31efa.ts.net")).toBe(true);
    expect(isTrustedHost("100.64.1.9")).toBe(true);
    expect(isTrustedHost("192.168.1.4")).toBe(true);
    expect(isTrustedHost("8.8.8.8")).toBe(false);
    expect(isTrustedHost("evil.com")).toBe(false);
    // A hostname that merely starts like a ULA must not pass as one.
    expect(isTrustedHost("fd.evil.com")).toBe(false);
    expect(isTrustedHost("fd00::1")).toBe(true);
  });

  it("blocks a rebound Host and a cross-site Origin, allows same-origin", () => {
    expect(crossSiteVerdict({ host: "evil.com", origin: null }).blocked).toBe(true);
    expect(crossSiteVerdict({ host: "127.0.0.1:8777", origin: "https://evil.com" }).blocked).toBe(true);
    expect(crossSiteVerdict({ host: "127.0.0.1:8777", origin: "http://127.0.0.1:8777" }).blocked).toBe(false);
    expect(
      crossSiteVerdict({ host: "dev-madrid.tail31efa.ts.net", origin: "https://dev-madrid.tail31efa.ts.net" }).blocked
    ).toBe(false);
    expect(crossSiteVerdict({ host: "dev-madrid.tail31efa.ts.net", origin: null }).blocked).toBe(false);
  });

  it("compares tokens in constant time without throwing on a length mismatch", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });
});

// ── A real peer on a real socket ────────────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("forwarding to a peer", () => {
  let server: http.Server;
  let base: string;
  let seen: Seen[] = [];
  // Set by the SSE case so the test can observe the upstream connection closing.
  let sseClosed: Promise<void>;
  let markSseClosed: () => void;

  beforeAll(async () => {
    sseClosed = new Promise<void>((resolve) => {
      markSseClosed = resolve;
    });
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const url = req.url ?? "";

        if (url.startsWith("/api/threads/t-1/live")) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache"
          });
          res.write("id: 1\nevent: status\ndata: {\"state\":\"running\"}\n\n");
          setTimeout(() => {
            if (!res.writableEnded) res.write("id: 2\nevent: text\ndata: hello from the peer\n\n");
          }, 30);
          // The whole point of wiring request.signal: when the caller aborts,
          // THIS fires. Without the wiring the stream sits open forever.
          res.on("close", () => markSseClosed());
          return;
        }

        if (url.startsWith("/api/threads/t-1/permissions/")) {
          // The expired-card case. Must arrive at the caller as a 409, not as a
          // retry, a queue entry or an optimistic success.
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "permission request is no longer pending" }));
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sawBody: body }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  it("forwards method, path, query, content-type and body", async () => {
    const response = await forwardToPeer({
      node: "mac-pro",
      base,
      path: "/api/threads/t-1/inputs",
      search: "?since=4",
      method: "POST",
      body: JSON.stringify({ message: "status?" }),
      contentType: "application/json",
      accept: "application/json"
    });
    expect(response.status).toBe(200);
    const record = seen.at(-1)!;
    expect(record.method).toBe("POST");
    expect(record.url).toBe("/api/threads/t-1/inputs?since=4");
    expect(record.headers["content-type"]).toBe("application/json");
    expect(record.headers.accept).toBe("application/json");
    expect(JSON.parse(record.body)).toEqual({ message: "status?" });
  });

  it("passes a 409 back verbatim - an expired permission card stays expired", async () => {
    const response = await forwardToPeer({
      node: "mac-pro",
      base,
      path: "/api/threads/t-1/permissions/req-9",
      method: "POST",
      body: JSON.stringify({ generationId: "g-1", decision: "allow_once" }),
      contentType: "application/json"
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "permission request is no longer pending" });
  });

  it("relays an SSE stream chunk by chunk", async () => {
    const controller = new AbortController();
    const response = await forwardToPeer({
      node: "mac-pro",
      base,
      path: "/api/threads/t-1/live",
      method: "GET",
      sse: true,
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-transform");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: status");
    // The second frame arrives 30ms later - proving frames flow as they are
    // produced rather than being buffered into one response.
    let second = "";
    while (!second.includes("hello from the peer")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      second += decoder.decode(chunk.value);
    }
    expect(second).toContain("hello from the peer");

    // The tab closes.
    controller.abort();
    await expect(sseClosed).resolves.toBeUndefined();
  });

  it("reports an unreachable peer as 502 rather than hanging or 500ing", async () => {
    const response = await forwardToPeer({
      node: "mac-pro",
      // Reserved TEST-NET-1, guaranteed not to answer; the timeout keeps it bounded.
      base: "http://192.0.2.1:9",
      path: "/api/threads",
      method: "GET",
      timeoutMs: 250
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("peer-unreachable");
    expect(body.node).toBe("mac-pro");
    expect(body.base).toBe("http://192.0.2.1:9");
  });

  it("reports a client that hung up as 499, not as a peer failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await forwardToPeer({
      node: "mac-pro",
      base,
      path: "/api/threads",
      method: "GET",
      signal: controller.signal
    });
    expect(response.status).toBe(499);
  });
});

// ── The route, against a real registry ──────────────────────────────────────

describe("the mesh proxy route", () => {
  let harness: Awaited<ReturnType<typeof startStateService>>;
  let home: string;
  let priorHome: string | undefined;
  let priorUrl: string | undefined;
  let priorToken: string | undefined;
  let route: typeof import("@/app/api/mesh/nodes/[node]/[...path]/route");

  beforeAll(async () => {
    harness = await startStateService({ nodes: ["alpha", "beta"] });

    // Beta announces itself with a tailnet host and one live session, exactly
    // as its own gateway would.
    const beta = new StateClient({ url: harness.url, token: harness.tokens.beta, node: "beta" });
    await beta.hello({
      clientVersion: "garrison-node/1",
      minSchema: 1,
      maxSchema: 2,
      localTime: new Date().toISOString(),
      tailnetHost: "beta.tail31efa.ts.net",
      platform: "darwin"
    });
    await beta.upsertSession("run-7", {
      threadId: "t-1",
      compositionId: "default",
      cwd: "/home/ggomes/dev/garrison",
      status: "running",
      runtime: "agent-sdk",
      model: "claude-opus-5",
      controlUrl: "http://localhost:8083",
      body: { controlPort: 8083 }
    });

    home = mkdtempSync(path.join(tmpdir(), "mesh-proxy-route-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, "node.json"),
      JSON.stringify({ id: "alpha", name: "Alpha", accent: "moss", tailnetHost: "alpha.tail31efa.ts.net" })
    );

    priorHome = process.env.GARRISON_HOME;
    priorUrl = process.env.GARRISON_STATE_URL;
    priorToken = process.env.GARRISON_STATE_TOKEN;
    process.env.GARRISON_HOME = home;
    process.env.GARRISON_STATE_URL = harness.url;
    process.env.GARRISON_STATE_TOKEN = harness.tokens.alpha;

    const { resetStateClient } = await import("@/lib/state-client");
    resetStateClient();
    const { resetNodeIdentityCache } = await import("@/lib/node-identity");
    resetNodeIdentityCache();
    route = await import("@/app/api/mesh/nodes/[node]/[...path]/route");
  }, 30_000);

  afterAll(async () => {
    await harness?.stop();
    if (priorHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = priorHome;
    if (priorUrl === undefined) delete process.env.GARRISON_STATE_URL;
    else process.env.GARRISON_STATE_URL = priorUrl;
    if (priorToken === undefined) delete process.env.GARRISON_STATE_TOKEN;
    else process.env.GARRISON_STATE_TOKEN = priorToken;
    rmSync(home, { recursive: true, force: true });
    const { resetStateClient } = await import("@/lib/state-client");
    resetStateClient();
    const { resetNodeIdentityCache } = await import("@/lib/node-identity");
    resetNodeIdentityCache();
  });

  function req(url: string, init: RequestInit = {}) {
    return new Request(`http://127.0.0.1:8777${url}`, {
      headers: { host: "127.0.0.1:8777", ...(init.headers as Record<string, string>) },
      ...init
    }) as never;
  }

  it("refuses an unlisted path before it ever resolves the node", async () => {
    const response = await route.GET(req("/api/mesh/nodes/nonexistent-node/vault/secrets"), {
      params: { node: "nonexistent-node", path: ["vault", "secrets"] }
    });
    // 403, not 404: the refusal must not double as a node-name oracle.
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("not-relayed");
  });

  it("405s a relayed path asked with an unrelayed verb", async () => {
    const response = await route.PUT(req("/api/mesh/nodes/beta/threads/t-1", { method: "PUT" }), {
      params: { node: "beta", path: ["threads", "t-1"] }
    });
    expect(response.status).toBe(405);
  });

  it("421s a call aimed at this node - the local API is right there", async () => {
    const response = await route.GET(req("/api/mesh/nodes/alpha/threads"), {
      params: { node: "alpha", path: ["threads"] }
    });
    expect(response.status).toBe(421);
    const body = await response.json();
    expect(body.error).toBe("self");
    expect(body.hint).toContain("local API");
  });

  it("still answers a REGISTRY read about this node - a query is not a call", async () => {
    // Uniformity matters here: the roster lists sessions for every node through
    // one endpoint, and a self row that 421s would force a second code path in
    // the UI for no gain. Only a genuine forward to self is refused.
    const response = await route.GET(req("/api/mesh/nodes/alpha/sessions"), {
      params: { node: "alpha", path: ["sessions"] }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.isSelf).toBe(true);
    // node.json is authoritative for this machine even when the registry row
    // has not been filled in by a beat yet.
    expect(body.tailnetHost).toBe("alpha.tail31efa.ts.net");
  });

  it("404s an unknown node", async () => {
    const response = await route.GET(req("/api/mesh/nodes/gamma/threads"), {
      params: { node: "gamma", path: ["threads"] }
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown-node");
  });

  it("413s a body over the cap without opening a peer connection", async () => {
    const oversized = "x".repeat(MAX_BODY_BYTES + 1);
    const response = await route.POST(
      req("/api/mesh/nodes/beta/threads/t-1/inputs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: oversized })
      }),
      { params: { node: "beta", path: ["threads", "t-1", "inputs"] } }
    );
    expect(response.status).toBe(413);
    expect((await response.json()).limit).toBe(MAX_BODY_BYTES);
  });

  it("serves the sessions list from the REGISTRY, with a computed open link", async () => {
    const response = await route.GET(req("/api/mesh/nodes/beta/sessions"), {
      params: { node: "beta", path: ["sessions"] }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.node).toBe("beta");
    expect(body.tailnetHost).toBe("beta.tail31efa.ts.net");
    expect(body.controlBase).toBe("https://beta.tail31efa.ts.net");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("run-7");
    expect(body.sessions[0].homeNode).toBe("beta");
    expect(body.sessions[0].cwd).toBe("/home/ggomes/dev/garrison");
    // The registry keeps the loopback URL it was honestly given; the open link
    // is the peer's app origin, where Conversations answer.
    expect(body.sessions[0].controlUrl).toBe("http://localhost:8083");
    expect(body.sessions[0].openUrl).toBe("https://beta.tail31efa.ts.net/talk/t-1");
  });

  it("blocks a cross-site call before anything else", async () => {
    const response = await route.GET(
      req("/api/mesh/nodes/beta/threads", { headers: { origin: "https://evil.example" } }),
      { params: { node: "beta", path: ["threads"] } }
    );
    expect(response.status).toBe(403);
    expect((await response.json()).reason).toContain("Origin");
  });
});
