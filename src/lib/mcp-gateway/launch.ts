import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";

const GATEWAY_SCRIPT_REL = path.join("apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs");

export function resolveGatewayScript(compositionDir: string): string {
  return path.join(compositionDir, GATEWAY_SCRIPT_REL);
}

export function isMcpGatewayInstalled(compositionDir: string): boolean {
  return existsSync(resolveGatewayScript(compositionDir));
}

export function buildLocalMcpConfig(compositionDir: string): object {
  return {
    mcpServers: {
      garrison: {
        command: "node",
        args: [resolveGatewayScript(compositionDir), "stdio"],
        env: { GARRISON_COMPOSITION_DIR: compositionDir }
      }
    }
  };
}

export function buildRemoteMcpConfig(gatewayUrl: string, token: string): object {
  return {
    mcpServers: {
      garrison: {
        type: "http",
        url: gatewayUrl,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  };
}

export async function writeMcpConfig(worktreePath: string, compositionDir: string): Promise<void> {
  const config = buildLocalMcpConfig(compositionDir);
  await fs.writeFile(path.join(worktreePath, ".mcp.json"), JSON.stringify(config, null, 2), "utf8");
}

// Garrison MCP CLAUDE.md fragment — injected at session launch.
const MCP_CLAUDE_MD_FRAGMENT = `
<!-- garrison-mcp-tools:begin -->
## Garrison MCP tools

Two MCP tools are wired into this session by Agent Garrison:

- \`classify_tier\` — classify the user's request into tier 1-7. Use
  before committing to a plan. T3+ requires plan-then-reclassify-then-route.
- \`run_tests\` — run the worktree project's native test command
  (npm/pytest/cargo/go). Use to verify work before declaring it done.

Call these tools instead of synthesising the answer. If a tool is
absent from the tool list, the corresponding Faculty is not installed.
<!-- garrison-mcp-tools:end -->
`.trimStart();

export async function injectClaudeMd(worktreePath: string): Promise<void> {
  const filePath = path.join(worktreePath, "CLAUDE.md");
  const marker = "<!-- garrison-mcp-tools:begin -->";
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // file doesn't exist — will create
  }
  if (existing.includes(marker)) return; // already injected
  const updated = existing ? existing + "\n" + MCP_CLAUDE_MD_FRAGMENT : MCP_CLAUDE_MD_FRAGMENT;
  await fs.writeFile(filePath, updated, "utf8");
}

export async function removeClaudeMd(worktreePath: string): Promise<void> {
  const filePath = path.join(worktreePath, "CLAUDE.md");
  try {
    const existing = await fs.readFile(filePath, "utf8");
    const cleaned = existing
      .replace(/\n?<!-- garrison-mcp-tools:begin -->[\s\S]*?<!-- garrison-mcp-tools:end -->\n?/g, "")
      .trimEnd();
    if (cleaned) {
      await fs.writeFile(filePath, cleaned + "\n", "utf8");
    } else {
      await fs.unlink(filePath).catch(() => { /* ignore */ });
    }
  } catch {
    // file missing — nothing to do
  }
}

// ─────────────────────────────────────────── HTTP gateway lifecycle

interface GatewayRecord {
  process: ChildProcess;
  port: number;
  token: string;
}

const httpGateways = new Map<string, GatewayRecord>();

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

function getWorkbenchHostname(): string {
  // Prefer Tailscale hostname file if present (set by outpost-tailscale-host Fitting)
  const tailscaleFile = path.join(os.homedir(), ".garrison", "tailscale-self.json");
  if (existsSync(tailscaleFile)) {
    try {
      const data = JSON.parse(readFileSync(tailscaleFile, "utf8")) as { hostname?: string };
      if (data?.hostname) return data.hostname;
    } catch { /* fall through */ }
  }
  return os.hostname();
}

export async function startHttpGateway(
  sessionId: string,
  compositionDir: string
): Promise<{ url: string; token: string; port: number }> {
  const token = randomBytes(32).toString("hex");
  const port = await findFreePort();
  const scriptPath = resolveGatewayScript(compositionDir);

  const child = spawn(
    "node",
    [scriptPath, "http", "--port", String(port), "--token", token, "--host", "0.0.0.0"],
    {
      env: { ...process.env, GARRISON_COMPOSITION_DIR: compositionDir },
      detached: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[mcp-gw/${sessionId.slice(0, 8)}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[mcp-gw/${sessionId.slice(0, 8)}] ${chunk}`);
  });
  child.on("exit", () => httpGateways.delete(sessionId));

  httpGateways.set(sessionId, { process: child, port, token });

  // Give the server a moment to bind
  await new Promise((resolve) => setTimeout(resolve, 400));

  const hostname = getWorkbenchHostname();
  const url = `http://${hostname}:${port}`;
  return { url, token, port };
}

export function stopHttpGateway(sessionId: string): void {
  const gw = httpGateways.get(sessionId);
  if (!gw) return;
  httpGateways.delete(sessionId);
  try { gw.process.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => {
    try { gw.process.kill("SIGKILL"); } catch { /* ignore */ }
  }, 5000).unref();
}

export function hasHttpGateway(sessionId: string): boolean {
  return httpGateways.has(sessionId);
}
