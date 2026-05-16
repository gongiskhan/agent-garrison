import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Phase 9D — runner spawns mcp-gateway HTTP mode alongside http-gateway.
// We exercise the mcp-gateway sidecar pattern directly (the same code path the
// runner uses) and assert: (a) the process binds to a free port with bearer
// auth, (b) /healthz returns ok, (c) listing tools includes garrison-control
// when GARRISON_HTTP_GATEWAY_BASE_URL is set in the child env.

const MCP_GATEWAY_SCRIPT = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "mcp-gateway",
  "scripts",
  "gateway.mjs"
);

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

describe("Phase 9D — mcp-gateway sidecar launch", () => {
  it("boots in http mode with bearer auth, /healthz returns ok, advertises garrison-control tools", async () => {
    const port = await findFreePort();
    const token = "spike-token-9d";
    const compositionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-mcp-9d-"));

    const child = spawn(
      "node",
      [MCP_GATEWAY_SCRIPT, "http", "--port", String(port), "--token", token, "--host", "127.0.0.1"],
      {
        env: {
          ...process.env,
          GARRISON_COMPOSITION_DIR: compositionDir,
          GARRISON_HTTP_GATEWAY_BASE_URL: "http://127.0.0.1:65000"
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    try {
      // wait up to 5s for /healthz
      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 5000;
      let healthData: { ok?: boolean; tools?: string[] } | null = null;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${baseUrl}/healthz`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(500)
          });
          if (r.ok) {
            healthData = (await r.json()) as { ok?: boolean; tools?: string[] };
            break;
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(healthData).not.toBeNull();
      expect(healthData?.ok).toBe(true);
      expect(healthData?.tools).toContain("talk_to");
      expect(healthData?.tools).toContain("create_worktree");
      expect(healthData?.tools).toContain("close_worktree");

      // Unauthenticated request must 401
      const unauth = await fetch(`${baseUrl}/healthz`);
      expect(unauth.status).toBe(401);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.on("exit", r));
      await fsp.rm(compositionDir, { recursive: true, force: true }).catch(() => null);
    }
  }, 15_000);
});
