import { describe, expect, it, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import http from "node:http";

let stubServer: http.Server | undefined;
let stubBaseUrl: string;
let captured: Array<{ origin: string | null; body: string }> = [];

async function startStub(): Promise<string> {
  return new Promise((resolve, reject) => {
    stubServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      captured.push({
        origin: (req.headers["x-garrison-origin"] as string | undefined) ?? null,
        body
      });
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(`event: chunk\ndata: ${JSON.stringify({ text: "ack" })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "ok" })}\n\n`);
      res.end();
    });
    stubServer.listen(0, "127.0.0.1", () => {
      const addr = stubServer!.address();
      if (typeof addr === "object" && addr) {
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        reject(new Error("could not bind stub server"));
      }
    });
    stubServer.on("error", reject);
  });
}

afterEach(async () => {
  if (stubServer) {
    await new Promise<void>((r) => stubServer!.close(() => r()));
    stubServer = undefined;
  }
  captured = [];
  vi.restoreAllMocks();
});

describe("Phase 9I L2 — /api/runner/[id]/chat origin forwarding", () => {
  it("forwards X-Garrison-Origin: workbench to the upstream gateway", async () => {
    stubBaseUrl = await startStub();
    const runner = await import("@/lib/runner");
    vi.spyOn(runner, "getGatewayBaseUrl").mockReturnValue(stubBaseUrl);

    const { POST } = await import("@/app/api/runner/[id]/chat/route");
    const req = new NextRequest("http://localhost/api/runner/c1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Garrison-Origin": "workbench" },
      body: JSON.stringify({ message: "fix the bug" })
    });
    const res = await POST(req, { params: { id: "c1" } });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].origin).toBe("workbench");
    expect(captured[0].body).toContain("fix the bug");
  });

  it("forwards X-Garrison-Origin: channel when set explicitly", async () => {
    stubBaseUrl = await startStub();
    const runner = await import("@/lib/runner");
    vi.spyOn(runner, "getGatewayBaseUrl").mockReturnValue(stubBaseUrl);

    const { POST } = await import("@/app/api/runner/[id]/chat/route");
    const req = new NextRequest("http://localhost/api/runner/c1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Garrison-Origin": "channel" },
      body: JSON.stringify({ message: "what time" })
    });
    const res = await POST(req, { params: { id: "c1" } });
    expect(res.status).toBe(200);
    expect(captured[0].origin).toBe("channel");
  });

  it("defaults origin to 'workbench' when header is absent", async () => {
    stubBaseUrl = await startStub();
    const runner = await import("@/lib/runner");
    vi.spyOn(runner, "getGatewayBaseUrl").mockReturnValue(stubBaseUrl);

    const { POST } = await import("@/app/api/runner/[id]/chat/route");
    const req = new NextRequest("http://localhost/api/runner/c1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "no header" })
    });
    const res = await POST(req, { params: { id: "c1" } });
    expect(res.status).toBe(200);
    expect(captured[0].origin).toBe("workbench");
  });

  it("returns 503 when the operative is not running (no gateway base URL)", async () => {
    const runner = await import("@/lib/runner");
    vi.spyOn(runner, "getGatewayBaseUrl").mockReturnValue(null);

    const { POST } = await import("@/app/api/runner/[id]/chat/route");
    const req = new NextRequest("http://localhost/api/runner/c1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" })
    });
    const res = await POST(req, { params: { id: "c1" } });
    expect(res.status).toBe(503);
  });
});
