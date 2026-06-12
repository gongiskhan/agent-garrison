import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Self-booting live integration test for the PTY gateway. Gated behind
// GARRISON_INTEGRATION=1 (it spawns a real interactive `claude`). Boots the
// gateway in a throwaway composition dir — no full composition needed.
//
// Run: GARRISON_INTEGRATION=1 npx vitest run tests/gateway-pty.integration.test.ts

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = path.join(REPO_ROOT, "fittings", "seed", "http-gateway", "scripts", "gateway.mjs");
const WEB_CHANNEL = path.join(REPO_ROOT, "fittings", "seed", "web-channel-default", "scripts", "server.mjs");
const RUN = process.env.GARRISON_INTEGRATION === "1";
const MODEL = process.env.GARRISON_INTEGRATION_MODEL ?? "sonnet";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitReady(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      const j = (await r.json()) as { pty_status?: string; error?: string };
      if (j.pty_status === "ready") return;
      if (j.pty_status === "failed") throw new Error(`gateway failed: ${j.error}`);
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("gateway did not become ready in time");
}

async function chat(port: number, message: string, timeoutMs = 120_000): Promise<{ reply: string; session_id: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`/chat ${r.status}: ${await r.text()}`);
  return (await r.json()) as { reply: string; session_id: string };
}

describe.skipIf(!RUN)("gateway PTY engine (live)", () => {
  let proc: ChildProcess | undefined;
  let tmp: string;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-gw-it-"));
    fs.mkdirSync(path.join(tmp, ".garrison"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "system-prompt.md"), "You are a test operative. Be terse and obedient.\n");
    fs.writeFileSync(path.join(tmp, ".claude", "commands", "garrison-ping.md"), "Reply with exactly: garrison-cmd-ok\n");
    proc = spawn("node", [GATEWAY], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_PORT: String(port),
        GARRISON_GATEWAY_HOST: "127.0.0.1",
        GARRISON_COMPOSITION_DIR: tmp,
        GARRISON_SYSTEM_PROMPT_PATH: path.join(tmp, "system-prompt.md"),
        GARRISON_PERMISSION_MODE: "bypassPermissions",
        GARRISON_MODEL: MODEL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitReady(port);
  }, 90_000);

  afterAll(() => {
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });

  it("health reports the pty engine", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const j = (await r.json()) as { engine: string; pty_status: string };
    expect(j.engine).toBe("pty");
    expect(j.pty_status).toBe("ready");
  }, 30_000);

  it("returns an exact-marker reply", async () => {
    const { reply } = await chat(port, "Reply with exactly: garrison-pty-ok and nothing else.");
    expect(reply).toContain("garrison-pty-ok");
  }, 120_000);

  it("performs a tool action through the PTY (writes a file)", async () => {
    await chat(port, "Create a file named hello.html in the current directory containing exactly: <h1>garrison-hello-world</h1>");
    const content = fs.readFileSync(path.join(tmp, "hello.html"), "utf8");
    expect(content).toContain("garrison-hello-world");
  }, 150_000);

  it("runs a custom slash command (model-turn) and returns its output", async () => {
    const { reply } = await chat(port, "/garrison-ping", 90_000);
    expect(reply).toContain("garrison-cmd-ok");
  }, 120_000);

  it("streams chunks and a done event over /chat/stream", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Reply with exactly: stream-ok" }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await r.text();
    expect(text).toContain("event: done");
    const doneLine = text.split("\n").find((l) => l.startsWith("data:") && l.includes('"reply"'));
    expect(doneLine && doneLine.includes("stream-ok")).toBe(true);
  }, 120_000);

  it("relays through the web-channel fitting unchanged", async () => {
    const wcPort = await freePort();
    const wc = spawn("node", [WEB_CHANNEL], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_URL: `http://127.0.0.1:${port}`,
        WEB_CHANNEL_PORT: String(wcPort),
        WEB_CHANNEL_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      // wait for web-channel health
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        try {
          const h = await fetch(`http://127.0.0.1:${wcPort}/api/health`);
          if (h.ok) break;
        } catch {
          /* not up */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      const r = await fetch(`http://127.0.0.1:${wcPort}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Reply with exactly: web-pty-ok" }),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await r.text();
      expect(text).toContain("event: done");
      expect(text).toContain("web-pty-ok");
    } finally {
      try {
        wc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }, 120_000);
});
