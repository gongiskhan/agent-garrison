import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HTTP_GATEWAY_SCRIPT = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "http-gateway",
  "scripts",
  "gateway.mjs"
);
const MOCK_CLAUDE_SCRIPT = path.resolve(
  __dirname,
  "..",
  "scripts",
  "spike",
  "phase9",
  "mock-claude.mjs"
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

let gateway: ChildProcessWithoutNullStreams | undefined;
let gatewayPort: number;
let gatewayUrl: string;
let testDir: string;
let claudeShimDir: string;
let nextStub: Server | undefined;
let nextStubPort: number;
let nextStubCalls: Array<{ method: string; pathname: string; body: unknown }> = [];
let worktreeStub: http.Server | undefined;
let worktreeStubPort: number;
let worktreeStubCalls: Array<{ method: string; pathname: string; body: unknown }> = [];

beforeAll(async () => {
  // Working dir for the test composition (fake apm_modules layout for mcp-gateway lookup).
  testDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-l3-"));
  await fsp.mkdir(path.join(testDir, ".garrison"), { recursive: true });

  // Fake orchestrator prompt + base path so spawn-soul finds something.
  const orchestratorDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-l3-orch-"));
  await fsp.mkdir(path.join(orchestratorDir, ".apm", "prompts"), { recursive: true });
  const orchPromptPath = path.join(orchestratorDir, ".apm", "prompts", "garrison-orchestrator.prompt.md");
  await fsp.writeFile(orchPromptPath, "# Test Orchestrator\n");

  // Fake engineer soul.
  const soulDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-l3-soul-"));
  await fsp.mkdir(path.join(soulDir, ".apm", "prompts"), { recursive: true });
  const soulPromptPath = path.join(soulDir, ".apm", "prompts", "soul-engineer.prompt.md");
  await fsp.writeFile(soulPromptPath, "# Engineer Soul\n");
  const soulBasePath = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-l3-base-"));
  // Drop a couple of subdirs so /workdirs returns something.
  await fsp.mkdir(path.join(soulBasePath, "alpha-project"), { recursive: true });
  await fsp.mkdir(path.join(soulBasePath, "beta-project"), { recursive: true });

  // Shim PATH so `claude` resolves to our mock node script.
  claudeShimDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-l3-shim-"));
  const claudeShim = path.join(claudeShimDir, "claude");
  await fsp.writeFile(
    claudeShim,
    `#!/bin/sh\nexec node ${MOCK_CLAUDE_SCRIPT} "$@"\n`,
    { mode: 0o755 }
  );

  // Mini Next.js stub for interactive spawn-soul-tab passthrough (the
  // post-Workbench-dissolution endpoint name).
  nextStubPort = await findFreePort();
  nextStub = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const pathname = req.url ?? "/";
    nextStubCalls.push({ method: req.method ?? "GET", pathname, body });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    if (pathname.startsWith("/api/interactive/spawn-soul-tab") ||
        pathname.startsWith("/api/interactive/respawn-soul-tab")) {
      res.end(JSON.stringify({ terminal_tab_id: "tab-test-123" }));
      return;
    }
    res.end("{}");
  });
  await new Promise<void>((resolve) => nextStub!.listen(nextStubPort, "127.0.0.1", resolve));

  // Mini worktree-management fitting stub (production calls this on port 7080
  // via WORKTREE_FITTING_BASE_URL).
  worktreeStubPort = await findFreePort();
  worktreeStub = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = u.pathname;
    worktreeStubCalls.push({ method: req.method ?? "GET", pathname, body });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && pathname === "/worktrees") {
      res.end(JSON.stringify({
        id: "worktree-uuid-1",
        title: body && typeof body === "object"
          ? (body as { title?: string }).title ?? null
          : null,
        urls: { frontend: "http://localhost:50000" }
      }));
      return;
    }
    if (req.method === "GET" && pathname === "/worktrees") {
      res.end(JSON.stringify({ worktrees: [] }));
      return;
    }
    const closeMatch = pathname.match(/^\/worktrees\/([^/]+)$/);
    if (req.method === "DELETE" && closeMatch) {
      res.end(JSON.stringify({ ok: true, id: closeMatch[1] }));
      return;
    }
    res.end("{}");
  });
  await new Promise<void>((resolve) => worktreeStub!.listen(worktreeStubPort, "127.0.0.1", resolve));

  gatewayPort = await findFreePort();
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  const soulsConfig = {
    orchestratorFittingId: "garrison-orchestrator",
    orchestrator: {
      fittingId: "garrison-orchestrator",
      preset: "none",
      allowed_tools: [],
      exclude_dynamic_sections: true,
      base_path: orchestratorDir,
      mcp: ["garrison-control"],
      promptPath: orchPromptPath,
      resolvedBasePath: orchestratorDir
    },
    souls: {
      "soul-engineer": {
        fittingId: "soul-engineer",
        preset: "claude_code",
        exclude_dynamic_sections: false,
        base_path: soulBasePath,
        promptPath: soulPromptPath,
        resolvedBasePath: soulBasePath
      }
    }
  };

  gateway = spawn("node", [HTTP_GATEWAY_SCRIPT], {
    cwd: testDir,
    env: {
      ...process.env,
      PATH: `${claudeShimDir}:${process.env.PATH ?? ""}`,
      GARRISON_GATEWAY_HOST: "127.0.0.1",
      GARRISON_GATEWAY_PORT: String(gatewayPort),
      GARRISON_COMPOSITION_DIR: testDir,
      GARRISON_MCP_GATEWAY_BASE_URL: "http://127.0.0.1:65000", // fake; gateway just writes it into .mcp.json
      GARRISON_MCP_GATEWAY_TOKEN: "test-token",
      GARRISON_NEXT_BASE_URL: `http://127.0.0.1:${nextStubPort}`,
      WORKTREE_FITTING_BASE_URL: `http://127.0.0.1:${worktreeStubPort}`,
      GARRISON_ORCHESTRATOR_FITTING_ID: "garrison-orchestrator",
      GARRISON_SOULS_CONFIG: JSON.stringify(soulsConfig),
      GARRISON_JSONL_IDLE_MS: "200" // shorten for tests
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  gateway.stdout.on("data", (b) => process.stdout.write(`[gw] ${b}`));
  gateway.stderr.on("data", (b) => process.stderr.write(`[gw-err] ${b}`));

  // Wait for /health to come up.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${gatewayUrl}/health`);
      if (r.ok) {
        const data = await r.json();
        if (data.mode === "orchestrator") return;
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not boot in 8s");
}, 30000);

afterAll(async () => {
  if (gateway) {
    gateway.kill("SIGTERM");
    await new Promise((r) => gateway!.on("exit", r));
  }
  if (nextStub) {
    await new Promise<void>((resolve) => nextStub!.close(() => resolve()));
  }
  if (worktreeStub) {
    await new Promise<void>((resolve) => worktreeStub!.close(() => resolve()));
  }
  await fsp.rm(testDir, { recursive: true, force: true }).catch(() => null);
  await fsp.rm(claudeShimDir, { recursive: true, force: true }).catch(() => null);
});

describe("Phase 9I L3 — http-gateway orchestrator mode (mock claude)", () => {
  it("/health reports orchestrator mode with an active session id", async () => {
    const r = await fetch(`${gatewayUrl}/health`);
    expect(r.ok).toBe(true);
    const data = (await r.json()) as { mode: string; orchestrator_session_id: string };
    expect(data.mode).toBe("orchestrator");
    expect(data.orchestrator_session_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("writes the shared .mcp.json on boot wiring an mcp-gateway stdio child", async () => {
    const filePath = path.join(testDir, ".garrison", "mcp.json");
    const raw = await fsp.readFile(filePath, "utf8");
    const cfg = JSON.parse(raw);
    // Gateway now wires mcp-gateway as a stdio child (proven-good transport;
    // HTTP transport was dropped because Claude Code's HTTP MCP assumes
    // OAuth and doesn't always honour raw Bearer headers).
    expect(cfg.mcpServers.garrison.command).toBe("node");
    expect(Array.isArray(cfg.mcpServers.garrison.args)).toBe(true);
    expect(cfg.mcpServers.garrison.args.join(" ")).toContain("gateway.mjs");
    expect(cfg.mcpServers.garrison.args).toContain("stdio");
    expect(cfg.mcpServers.garrison.env.GARRISON_COMPOSITION_DIR).toBe(testDir);
    expect(cfg.mcpServers.garrison.env.GARRISON_HTTP_GATEWAY_BASE_URL).toContain(String(gatewayPort));
  });

  it("POST /chat with X-Garrison-Origin: channel includes the prefix in orchestrator stdin (echoed via assistant text)", async () => {
    const r = await fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
      body: JSON.stringify({ message: "what time in lisbon" })
    });
    expect(r.ok).toBe(true);
    const data = (await r.json()) as { reply: string };
    expect(data.reply).toContain("MOCK[");
    // The mock echoes the user content verbatim, so we should see the prefix
    // bracketed line in the reply text.
    expect(data.reply).toContain("[origin: channel, channel: main]");
    expect(data.reply).toContain("what time in lisbon");
  });

  it("POST /sessions/spawn (headless engineer) registers a session and surfaces it via GET /sessions", async () => {
    const spawnRes = await fetch(`${gatewayUrl}/sessions/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        soul: "engineer",
        message: "hello engineer",
        mode: "headless",
        tier_hint: { model: "claude-haiku-4-5" },
        tier_flags: ["--model", "claude-haiku-4-5"]
      })
    });
    expect(spawnRes.ok).toBe(true);
    const spawnData = (await spawnRes.json()) as { session_id: string; mode: string; status: string };
    expect(spawnData.mode).toBe("headless");
    expect(spawnData.session_id).toMatch(/^[0-9a-f-]{36}$/i);

    // Wait briefly for mock to emit the result and SessionRegistry to mark completed.
    await new Promise((r) => setTimeout(r, 300));

    const list = await fetch(`${gatewayUrl}/sessions?soul=engineer`).then((r) => r.json()) as { sessions: Array<{ soul: string; mode: string }> };
    expect(list.sessions.length).toBeGreaterThanOrEqual(1);
    expect(list.sessions[0].soul).toBe("engineer");
  });

  it("channel SSE replays the engineer's events to subscribers", async () => {
    // End any prior engineer session so the new spawn binds to a fresh channel.
    await fetch(`${gatewayUrl}/sessions/by-soul/engineer/end`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 100));

    await fetch(`${gatewayUrl}/sessions/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        soul: "engineer",
        message: "@@MULTICHUNK",
        mode: "headless",
        channel: "test-replay",
        tier_hint: { model: "claude-haiku-4-5" },
        tier_flags: ["--model", "claude-haiku-4-5"]
      })
    });
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${gatewayUrl}/channels/test-replay/stream`);
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let chunkSeen = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !chunkSeen) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("chunk-1") || buf.includes("chunk-2") || buf.includes("chunk-3")) chunkSeen = true;
    }
    await reader.cancel().catch(() => null);
    expect(chunkSeen).toBe(true);
  }, 10000);

  it("POST /sessions/by-soul/<soul>/end kills the active session", async () => {
    // Spawn a slow session that won't return on its own.
    await fetch(`${gatewayUrl}/sessions/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        soul: "engineer",
        message: "@@SLOW 10000",
        mode: "headless"
      })
    });
    const endRes = await fetch(`${gatewayUrl}/sessions/by-soul/engineer/end`, { method: "POST" });
    expect(endRes.ok).toBe(true);
    const endData = (await endRes.json()) as { ok: boolean };
    expect(endData.ok).toBe(true);
  });

  it("GET /workdirs?soul=engineer enumerates subdirs of the soul's base_path", async () => {
    const res = await fetch(`${gatewayUrl}/workdirs?soul=engineer`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { workdirs: Array<{ name: string }> };
    const names = data.workdirs.map((w) => w.name);
    expect(names).toContain("alpha-project");
    expect(names).toContain("beta-project");
  });

  it("POST /worktrees proxies to the worktree-management Fitting on its own port", async () => {
    worktreeStubCalls.length = 0;
    const res = await fetch(`${gatewayUrl}/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "agent-garrison", task_title: "test feature" })
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toMatchObject({ id: "worktree-uuid-1" });
    expect(worktreeStubCalls.some((c) => c.method === "POST" && c.pathname === "/worktrees")).toBe(true);
  });

  it("POST /worktrees/<id>/close action='discard' proxies through to the worktree Fitting's DELETE", async () => {
    worktreeStubCalls.length = 0;
    const res = await fetch(`${gatewayUrl}/worktrees/abc-123/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "discard" })
    });
    expect(res.ok).toBe(true);
    expect(worktreeStubCalls.some((c) => c.method === "DELETE" && c.pathname === "/worktrees/abc-123")).toBe(true);
  });
});
