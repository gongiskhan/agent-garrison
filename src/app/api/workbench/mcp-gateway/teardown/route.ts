import { NextResponse, type NextRequest } from "next/server";
import { stopHttpGateway, hasHttpGateway, removeSystemPromptFile, removeSessionSettings } from "@/lib/mcp-gateway/launch";
import { outpostRpc } from "@/lib/outpost-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      outpostName?: string;
      remoteMcpConfigPath?: string;
      remotePromptFilePath?: string;
      remoteSettingsPath?: string;
    };

    const { sessionId, outpostName, remoteMcpConfigPath, remotePromptFilePath, remoteSettingsPath } = body;
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    // Stop HTTP gateway process if running (remote/outpost sessions)
    if (hasHttpGateway(sessionId)) {
      stopHttpGateway(sessionId);
    }

    if (outpostName) {
      // Remote: delete all three temp files on the outpost (best-effort)
      const paths = [remoteMcpConfigPath, remotePromptFilePath, remoteSettingsPath].filter(Boolean) as string[];
      for (const p of paths) {
        outpostRpc(outpostName, "fs.delete", { path: p }).catch(() => { /* non-fatal */ });
      }
    } else {
      // Local: delete prompt and settings temp files
      void removeSystemPromptFile(sessionId);
      void removeSessionSettings(sessionId);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
