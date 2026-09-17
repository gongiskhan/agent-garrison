// Capture service - text ingest for omi-channel (D24) and the
// active-conversation pin (D25).
//
// omi-channel forwards its realtime segments to POST /capture/ingest/text;
// this suite drives that route against a sandboxed GARRISON_HOME: the Bearer
// ladder, the 400s, the socket-less text session lifecycle (opened once per
// "<source>:<session_id>", extended on every call, closed by the idle timer
// with NO capture_event, transcript or session record behind it), the shared
// echo guard in front of everything, and a wake-word segment reaching the omi
// bus - a stub gateway records the classifier and delegate requests so the
// bus's identity (omi-wake:<session>) is observable. The pin endpoints round
// it off: GET / POST / DELETE and a pinned delegate.

import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";

const TOKEN = "text-ingest-token";
const OMI_SESSION = "omi-sess-0001";
const COMMAND = "Zeca, send Ana the report.";

// Stub gateway: a classifier reply for the pinned lane (the request carries a
// routing pin), a delegate reply WITH a session id for the full lane. Every
// request body is recorded.
function startStubGateway() {
  const requests: any[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push({ url: req.url, body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      if (parsed.routing) {
        res.end(JSON.stringify({ reply: JSON.stringify({ intent: "delegate", request: "send Ana the report", ack: "On it." }) }));
      } else {
        res.end(JSON.stringify({ reply: "Sent the report to Ana.", session_id: "gw-omi-1" }));
      }
    });
  });
  return new Promise<{ url: string; requests: any[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

async function waitFor(pred: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return pred();
}

type Handle = Awaited<ReturnType<typeof startServer>>;

describe("retired cloud ingress and the active-conversation pin", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-text-"));
    const gateway = await startStubGateway();
    const fullEnv = { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN, ...env };
    const cfg = loadConfig(fullEnv);
    const handle = await startServer({
      ...cfg,
      env: fullEnv,
      port: 0,
      enabled: true,
      wakeEnabled: true,
      gatewayUrl: gateway.url,
      wakeSilenceCloseMs: 150,
      wakeSettledCloseMs: 60,
      wakeMaxCaptureMs: 2000,
      ...overrides
    });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
      gateway.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { handle: handle as Handle, home, gateway, base: `http://127.0.0.1:${handle.cfg.port}` };
  }

  function post(base: string, route: string, body: unknown, token: string | null = TOKEN) {
    return fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: typeof body === "string" ? body : JSON.stringify(body)
    });
  }

  function ingest(base: string, sessionId: string, texts: string[], token: string | null = TOKEN) {
    return post(
      base,
      "/capture/ingest/text",
      { source: "omi", session_id: sessionId, segments: texts.map((text, i) => ({ text, speaker: 0, is_user: true, start: i, end: i + 1 })) },
      token
    );
  }

  it("has no Omi cloud transcript ingress", async () => {
    const { base } = await boot();
    const res = await ingest(base, OMI_SESSION, [COMMAND]);
    expect(res.status).toBe(404);
  });

  it("pins, reads and clears the active conversation", async () => {
    const { handle, base } = await boot();
    const headers = { authorization: `Bearer ${TOKEN}` };
    let res = await fetch(`${base}/capture/conversation/active`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: null, until: null });

    res = await post(base, "/capture/conversation/active", { session_id: "" });
    expect(res.status).toBe(400);
    res = await post(base, "/capture/conversation/active", "{nope");
    expect(res.status).toBe(400);

    const before = Date.now();
    res = await post(base, "/capture/conversation/active", { session_id: "gw-pinned-1" });
    expect(res.status).toBe(200);
    const pinned = await res.json();
    expect(pinned.session_id).toBe("gw-pinned-1");
    const until = Date.parse(pinned.until);
    expect(until).toBeGreaterThanOrEqual(before + 300000 - 50);
    expect(until).toBeLessThanOrEqual(Date.now() + 300000 + 50);

    res = await fetch(`${base}/capture/conversation/active`, { headers });
    expect(await res.json()).toEqual(pinned);

    res = await fetch(`${base}/capture/conversation/active`, { method: "PUT", headers });
    expect(res.status).toBe(405);

    res = await fetch(`${base}/capture/conversation/active`, { method: "DELETE", headers });
    expect(res.status).toBe(204);
    res = await fetch(`${base}/capture/conversation/active`, { headers });
    expect(await res.json()).toEqual({ session_id: null, until: null });
    const counters = handle.counters.read();
    expect(counters.conversation_pinned).toBe(1);
    expect(counters.conversation_pin_cleared).toBe(1);
  });

});
