// Regression + contract test for the web-channel's new /api/attachments proxy
// (the chat composer's paste/attach feature): a POST of {filename,
// content_base64} must reach the gateway's own POST /attachments unchanged and
// the gateway's {path, bytes} response must come straight back to the browser.
// Boots the REAL web-channel server (the same startServer() path a live
// composition runs) against a stub gateway, mirroring the pattern in
// tests/kanban-view-route.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";

const ROOT = path.resolve(__dirname, "..");
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "wca-home-"));
process.env.GARRISON_HOME = GARRISON_HOME;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

let webHandle: { server: http.Server };
let gateway: http.Server;
let gatewayReceived: { path: string; method: string; body: any } | null = null;
let gatewayStatus = 200;
let webBase = "";

beforeAll(async () => {
  gateway = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      gatewayReceived = { path: req.url || "", method: req.method || "", body };
      res.statusCode = gatewayStatus;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: "/home/user/.garrison/.garrison/uploads/1-shot.png", bytes: 12 }));
    });
  });
  const gwPort = await freePort();
  await new Promise<void>((resolve) => gateway.listen(gwPort, "127.0.0.1", resolve));

  const { startServer } = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/web-channel-default/scripts/server.mjs")).href
  );
  const port = await freePort();
  webHandle = await startServer({
    port,
    host: "127.0.0.1",
    gatewayUrl: `http://127.0.0.1:${gwPort}`,
    tlsCert: "",
    tlsKey: ""
  });
  webBase = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => webHandle.server.close(resolve));
  await new Promise((resolve) => gateway.close(resolve));
});

describe("web-channel: POST /api/attachments proxies to the gateway", () => {
  it("forwards filename + content_base64 and relays the gateway's {path, bytes} back", async () => {
    gatewayStatus = 200;
    const res = await fetch(`${webBase}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "shot.png", content_base64: "aGVsbG8=" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("/home/user/.garrison/.garrison/uploads/1-shot.png");
    expect(body.bytes).toBe(12);
    expect(gatewayReceived?.path).toBe("/attachments");
    expect(gatewayReceived?.method).toBe("POST");
    expect(gatewayReceived?.body).toEqual({ filename: "shot.png", content_base64: "aGVsbG8=" });
  });

  it("relays a gateway error status instead of masking it", async () => {
    gatewayStatus = 413;
    const res = await fetch(`${webBase}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "huge.png", content_base64: "aGVsbG8=" })
    });
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON with 400 rather than hanging or 500ing", async () => {
    const res = await fetch(`${webBase}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(res.status).toBe(400);
  });
});

describe("createHttpTransport uploads gating", () => {
  it("exposes uploadFile only when opts.uploads is set, and posts the gateway wire shape", async () => {
    const { createHttpTransport } = await import(
      path.join(ROOT, "packages/claude-chat/src/transport.ts")
    );
    // Default (dev-env sessions): no uploads endpoint on the host, so the
    // composer's attach affordance must stay hidden (canAttach gates on this).
    expect(createHttpTransport("/api").uploadFile).toBeUndefined();

    const t = createHttpTransport(`${webBase}/api`, { uploads: true });
    expect(typeof t.uploadFile).toBe("function");
    gatewayStatus = 200;
    const up = await t.uploadFile!({ name: "shot.png", mime: "image/png", base64: "aGVsbG8=" });
    expect(up.path).toBe("/home/user/.garrison/.garrison/uploads/1-shot.png");
    expect(up.bytes).toBe(12);
    expect(gatewayReceived?.path).toBe("/attachments");
    expect(gatewayReceived?.body).toEqual({ filename: "shot.png", content_base64: "aGVsbG8=" });
  });
});
