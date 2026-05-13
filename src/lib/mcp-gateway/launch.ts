import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

// System prompt fragment injected into every workbench-launched Claude Code session.
export const GARRISON_SYSTEM_PROMPT = `## REQUIRED: Garrison workflow — follow exactly, no exceptions

### Step 1 — classify every request (MANDATORY, do this first)

Before responding to ANY user request that involves making a change, writing code, editing files, running commands, or producing any output beyond a direct clarifying question, you MUST call:

  classify_tier({"prompt": "<the user's exact request>"})

Do not paraphrase it yourself. Do not skip this step for "simple" tasks. Small changes are still T1 and take two seconds to classify.

### Step 2 — act on the tier

- **T1–T2**: State the tier, then proceed immediately.
- **T3–T4**: State the tier. Write a concise plan (bullets). Wait for user approval before executing.
- **T5–T7**: State the tier. Write a detailed plan. Re-classify the plan summary. Wait for explicit approval.

### Step 3 — verify (after any code change)

After making code changes, call:

  run_tests({"cwd": "<absolute path to the project>"})

Report the result before declaring the work done.

---

If a tool is absent from the tool list, the corresponding Faculty is not installed — skip that step and note it.`;

export function systemPromptFilePath(sessionId: string): string {
  return path.join(os.tmpdir(), `garrison-prompt-${sessionId}.txt`);
}

export async function writeSystemPromptFile(sessionId: string): Promise<string> {
  const filePath = systemPromptFilePath(sessionId);
  await fs.writeFile(filePath, GARRISON_SYSTEM_PROMPT, "utf8");
  return filePath;
}

export async function removeSystemPromptFile(sessionId: string): Promise<void> {
  try {
    await fs.unlink(systemPromptFilePath(sessionId));
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────── Per-session hook enforcement

function tierFlagPath(shortSid: string): string {
  return `/tmp/garrison-tier-done-${shortSid}`;
}

export function settingsFilePath(sessionId: string): string {
  return path.join(os.tmpdir(), `garrison-settings-${sessionId}.txt`);
}

export function buildSessionSettings(shortSid: string): object {
  const flag = tierFlagPath(shortSid);
  return {
    hooks: {
      // Set the flag when classify_tier is called successfully
      PostToolUse: [
        {
          matcher: "mcp__garrison__classify_tier",
          hooks: [{ type: "command", command: `touch ${flag}` }],
        },
      ],
      // Block write/edit tools until classify_tier has been called
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [
            {
              type: "command",
              command: `test -f ${flag} || { echo "Garrison: call classify_tier({\\\"prompt\\\": \\\"<the user request>\\\"}) before making any changes."; exit 2; }`,
            },
          ],
        },
      ],
    },
  };
}

export async function writeSessionSettings(sessionId: string): Promise<string> {
  const filePath = settingsFilePath(sessionId);
  await fs.writeFile(filePath, JSON.stringify(buildSessionSettings(sessionId.slice(0, 8)), null, 2), "utf8");
  return filePath;
}

export async function removeSessionSettings(sessionId: string): Promise<void> {
  try { await fs.unlink(settingsFilePath(sessionId)); } catch { /* ignore */ }
  try { await fs.unlink(tierFlagPath(sessionId.slice(0, 8))); } catch { /* ignore */ }
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
  // Try Tailscale CLI — gives a routable IP for cross-machine HTTP (unlike .local mDNS)
  try {
    const result = spawnSync("tailscale", ["ip", "--4"], { encoding: "utf8", timeout: 2000 });
    const ip = result.stdout?.trim();
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch { /* fall through */ }
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
