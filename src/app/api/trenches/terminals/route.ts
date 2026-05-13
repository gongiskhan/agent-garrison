import { NextResponse, type NextRequest } from "next/server";
import { ensureWsServer, trenchesBaseUrl, trenchesWsUrl } from "@/lib/trenches/ws-server";
import {
  isMcpGatewayInstalled,
  writeMcpConfig,
  buildRemoteMcpConfig,
  writeSystemPromptFile,
  GARRISON_SYSTEM_PROMPT,
  startHttpGateway,
} from "@/lib/mcp-gateway/launch";
import { outpostRpc } from "@/lib/outpost-rpc";
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
        // Same-machine: write .mcp.json, write local prompt file, append flag to command
        const worktreePath = typeof body.cwd === "string" ? body.cwd : null;
        if (worktreePath) {
          const [promptPath] = await Promise.all([
            writeSystemPromptFile(sessionId),
            writeMcpConfig(worktreePath, compositionDir),
          ]);
          forwardBody = {
            ...forwardBody,
            initialCommand: appendClaudeFlags(
              body.initialCommand as string,
              `--append-system-prompt-file ${promptPath}`
            ),
          };
        }
      } else {
        // Remote outpost: start HTTP gateway on workbench host, write configs on remote
        const { url, token } = await startHttpGateway(sessionId, compositionDir);
        const remoteMcpConfigPath = `/tmp/garrison-mcp-${sessionId.slice(0, 8)}.json`;
        const remotePromptFilePath = `/tmp/garrison-prompt-${sessionId.slice(0, 8)}.txt`;
        const remoteMcpConfig = buildRemoteMcpConfig(url, token);
        forwardBody = { ...forwardBody, remoteMcpConfigPath, remotePromptFilePath };

        // Write MCP config and system prompt on remote (best-effort)
        await Promise.all([
          outpostRpc(outpostName, "fs.write", {
            path: remoteMcpConfigPath,
            content: JSON.stringify(remoteMcpConfig, null, 2),
          }).catch((err: Error) => {
            console.warn(`[mcp-gateway] fs.write MCP config failed on outpost ${outpostName}: ${err.message}`);
          }),
          outpostRpc(outpostName, "fs.write", {
            path: remotePromptFilePath,
            content: GARRISON_SYSTEM_PROMPT,
          }).catch((err: Error) => {
            console.warn(`[mcp-gateway] fs.write prompt failed on outpost ${outpostName}: ${err.message}`);
          }),
        ]);

        forwardBody = {
          ...forwardBody,
          initialCommand: appendClaudeFlags(
            body.initialCommand as string,
            `--mcp-config ${remoteMcpConfigPath} --append-system-prompt-file ${remotePromptFilePath}`
          ),
        };
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

// Append flags to the claude invocation inside a shell command string.
// Handles both `claude ...` and `cd <path> && claude ...` forms.
function appendClaudeFlags(command: string, flags: string): string {
  return command.replace(
    /(claude\s+--dangerously-skip-permissions(?:\s+--continue)?)/,
    `$1 ${flags}`
  );
}

