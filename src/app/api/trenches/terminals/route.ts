import { NextResponse, type NextRequest } from "next/server";
import { ensureWsServer, trenchesBaseUrl, trenchesWsUrl } from "@/lib/trenches/ws-server";
import {
  isMcpGatewayInstalled,
  writeMcpConfig,
  injectClaudeMd,
  startHttpGateway,
  buildRemoteMcpConfig,
} from "@/lib/mcp-gateway/launch";
import { outpostRpc } from "@/lib/outpost-rpc";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await ensureWsServer();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // MCP config injection — only when compositionDir is provided and mcp-gateway is installed
    const compositionDir = typeof body.compositionDir === "string" ? body.compositionDir : null;
    const isClaudeLaunch =
      typeof body.initialCommand === "string" && body.initialCommand.includes("claude ");
    const outpostName = typeof body.outpost === "string" ? body.outpost : null;

    let sessionId: string | null = null;
    let forwardBody = { ...body };

    if (compositionDir && isClaudeLaunch && isMcpGatewayInstalled(compositionDir)) {
      sessionId = randomUUID();
      forwardBody = { ...forwardBody, mcpSessionId: sessionId };

      if (!outpostName) {
        // Same-machine: write .mcp.json and CLAUDE.md into the worktree
        const worktreePath = typeof body.cwd === "string" ? body.cwd : null;
        if (worktreePath) {
          await Promise.all([
            writeMcpConfig(worktreePath, compositionDir),
            injectClaudeMd(worktreePath),
          ]);
        }
      } else {
        // Remote outpost: start HTTP gateway on workbench host, write config on remote
        const { url, token } = await startHttpGateway(sessionId, compositionDir);
        const remoteMcpConfigPath = `/tmp/garrison-mcp-${sessionId.slice(0, 8)}.json`;
        const remoteMcpConfig = buildRemoteMcpConfig(url, token);
        forwardBody = { ...forwardBody, remoteMcpConfigPath };

        // Write .mcp.json and CLAUDE.md on the remote via outpost RPC (best-effort)
        const remoteWorktreePath = extractRemotePath(body.initialCommand as string);
        await Promise.all([
          outpostRpc(outpostName, "fs.write", {
            path: remoteMcpConfigPath,
            content: JSON.stringify(remoteMcpConfig, null, 2),
          }).catch((err: Error) => {
            console.warn(`[mcp-gateway] fs.write failed on outpost ${outpostName}: ${err.message}`);
          }),
          remoteWorktreePath
            ? outpostRpc(outpostName, "fs.write", {
                path: path.join(remoteWorktreePath, "CLAUDE.md"),
                content: buildClaudeMdContent(await readRemoteClaudeMd(outpostName, remoteWorktreePath)),
              }).catch((err: Error) => {
                console.warn(`[mcp-gateway] CLAUDE.md write failed on outpost ${outpostName}: ${err.message}`);
              })
            : Promise.resolve(),
        ]);

        // Append --mcp-config flag to the claude command
        const newCommand = appendMcpConfig(body.initialCommand as string, remoteMcpConfigPath);
        forwardBody = { ...forwardBody, initialCommand: newCommand };
      }
    }

    const res = await fetch(`${trenchesBaseUrl()}/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardBody),
    });
    const json = await res.json();
    if (!res.ok) {
      return NextResponse.json(json, { status: res.status });
    }
    return NextResponse.json(
      { ...json, wsUrl: trenchesWsUrl(), mcpSessionId: sessionId ?? undefined },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

// Append --mcp-config <path> to the claude invocation inside a shell command string.
// Handles both `claude ...` and `cd <path> && claude ...` forms.
function appendMcpConfig(command: string, mcpConfigPath: string): string {
  return command.replace(
    /(claude\s+--dangerously-skip-permissions(?:\s+--continue)?)/,
    `$1 --mcp-config ${mcpConfigPath}`
  );
}

// Extract the remote worktree path from `cd <path> && claude ...` commands.
function extractRemotePath(command: string): string | null {
  const m = command.match(/^cd\s+(.+?)\s+&&/);
  if (!m) return null;
  // Un-escape single-quoted path component
  return m[1].replace(/^~\//, `~/`);
}

const MCP_CLAUDE_MD_MARKER = "<!-- garrison-mcp-tools:begin -->";
const MCP_CLAUDE_MD_FRAGMENT = `\n<!-- garrison-mcp-tools:begin -->
## Garrison MCP tools

Two MCP tools are wired into this session by Agent Garrison:

- \`classify_tier\` — classify the user's request into tier 1-7. Use
  before committing to a plan. T3+ requires plan-then-reclassify-then-route.
- \`run_tests\` — run the worktree project's native test command
  (npm/pytest/cargo/go). Use to verify work before declaring it done.

Call these tools instead of synthesising the answer. If a tool is
absent from the tool list, the corresponding Faculty is not installed.
<!-- garrison-mcp-tools:end -->`;

async function readRemoteClaudeMd(outpostName: string, worktreePath: string): Promise<string> {
  try {
    const result = await outpostRpc<{ content?: string }>(outpostName, "fs.read", {
      path: path.join(worktreePath, "CLAUDE.md"),
    });
    return result?.content ?? "";
  } catch {
    return "";
  }
}

function buildClaudeMdContent(existing: string): string {
  if (existing.includes(MCP_CLAUDE_MD_MARKER)) return existing;
  return existing ? existing + MCP_CLAUDE_MD_FRAGMENT : MCP_CLAUDE_MD_FRAGMENT.trimStart();
}
