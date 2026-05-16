import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import { resolveTailscaleHostname } from "../tailscale";

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

const CLASSIFY_TIER_REL = path.join("apm_modules", "_local", "tier-classifier", "scripts", "classify_tier.mjs");

export function buildSessionSettings(shortSid: string, compositionDir?: string): object {
  const flag = tierFlagPath(shortSid);
  // If compositionDir is known, guard the block on the classify_tier script existing.
  // This prevents a deadlock when the MCP gateway failed to connect: hooks stay active
  // but writes are not blocked when the tool is genuinely unavailable.
  const scriptCheck = compositionDir
    ? `! test -f ${path.join(compositionDir, CLASSIFY_TIER_REL)} || `
    : "";
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "mcp__garrison__classify_tier",
          hooks: [{ type: "command", command: `touch ${flag}` }],
        },
      ],
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [
            {
              type: "command",
              command: `${scriptCheck}test -f ${flag} || { echo "Garrison: call classify_tier({\\\"prompt\\\": \\\"<the user request>\\\"}) before making any changes."; exit 2; }`,
            },
          ],
        },
      ],
    },
  };
}

export async function writeSessionSettings(sessionId: string, compositionDir?: string): Promise<string> {
  const filePath = settingsFilePath(sessionId);
  await fs.writeFile(filePath, JSON.stringify(buildSessionSettings(sessionId.slice(0, 8), compositionDir), null, 2), "utf8");
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

  const hostname = resolveTailscaleHostname();
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

// ─────────────────────────────────────────── Strict-probe (opt-in)

/**
 * Invoke `mcp-gateway --probe --strict` for the given composition. Resolves
 * to `{ok: true}` only when both underlying probes (classify_tier and
 * run_tests) succeed; otherwise returns `{ok: false, stderr}` so the caller
 * can decide whether to abort the launch or continue with the lenient default.
 *
 * Workbench launches stay lenient by default (see docs/DECISIONS.md
 * 2026-05-16). Wire this in only behind an explicit `requireFullMcpSurface`
 * config flag.
 */
export async function probeMcpGatewayStrict(
  compositionDir: string
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const scriptPath = resolveGatewayScript(compositionDir);
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [scriptPath, "--probe", "--strict"],
      {
        env: { ...process.env, GARRISON_COMPOSITION_DIR: compositionDir },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve({ ok: false, stdout, stderr: stderr + "\nprobe timed out", exitCode: null });
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
  });
}
