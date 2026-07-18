import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = path.join(REPO_ROOT, "fittings", "seed", "http-gateway", "scripts", "gateway-pty.mjs");
const CODEX_ADAPTER = path.join(REPO_ROOT, "fittings", "seed", "codex-runtime", "lib", "codex-adapter.mjs");
const CLAUDE_STUB = path.join(REPO_ROOT, "tests", "fixtures", "gateway-runtime-stub.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

describe("gateway with a Codex primary", () => {
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (!child || child.exitCode != null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child?.once("exit", () => resolve());
      setTimeout(resolve, 3_000).unref();
    });
  });

  it("serves runtime-neutral health, persists a marker, and rejects Claude-only controls cleanly", async () => {
    const compositionDir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-codex-health-"));
    const runtimeDir = path.join(compositionDir, "codex-runtime-fixture");
    fs.mkdirSync(path.join(compositionDir, ".garrison"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "scripts"), { recursive: true });
    // Use the production CodexAdapter session shape ({alive, config}, no Claude
    // session methods), but replace only its warm-time CLI probe with a free stub.
    fs.copyFileSync(CODEX_ADAPTER, path.join(runtimeDir, "lib", "codex-adapter.mjs"));
    fs.writeFileSync(path.join(runtimeDir, "scripts", "bridge.mjs"), 'process.stdout.write("ok\\n");\n');

    const port = await freePort();
    let logs = "";
    child = spawn(process.execPath, [GATEWAY], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_HOST: "127.0.0.1",
        GARRISON_GATEWAY_PORT: String(port),
        GARRISON_COMPOSITION_DIR: compositionDir,
        GARRISON_HOME: compositionDir,
        GARRISON_MODEL: "gpt-5.6-sol",
        GARRISON_PRIMARY_ENGINE: "codex",
        GARRISON_CODEX_DIR: runtimeDir,
        // The non-primary classifier stays deterministic and does not call a
        // live Claude model; the primary itself is the real Codex adapter.
        GARRISON_GATEWAY_RUNTIME_STUB: CLAUDE_STUB,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (logs += chunk.toString()));
    child.stderr?.on("data", (chunk) => (logs += chunk.toString()));

    let health: Record<string, unknown> | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const body = (await response.json()) as Record<string, unknown>;
        if (response.ok && body.pty_status === "ready") {
          health = body;
          break;
        }
        if (body.pty_status === "failed") throw new Error(String(body.error));
      } catch (error) {
        if (Date.now() + 100 >= deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(health, logs).toMatchObject({
      ok: true,
      engine: "pty",
      primary_runtime: "codex",
      pty_status: "ready",
      session_id: null,
    });
    expect(fs.readFileSync(path.join(compositionDir, ".garrison", "operative-session-id"), "utf8")).toBe("continue");

    for (const [pathname, init] of [
      ["/claude/status", undefined],
      ["/claude/stream", undefined],
      [
        "/chat/answer",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool_use_id: "question-1", label: "Yes" }),
        },
      ],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
      expect(response.status, pathname).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "RICH_PTY_UNAVAILABLE",
        primary_runtime: "codex",
      });
    }
    expect(logs).not.toContain("getClaudeSessionId is not a function");
  }, 30_000);
});
