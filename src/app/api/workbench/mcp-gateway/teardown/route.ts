import { NextResponse, type NextRequest } from "next/server";
import { stopHttpGateway, hasHttpGateway } from "@/lib/mcp-gateway/launch";
import { outpostRpc } from "@/lib/outpost-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      outpostName?: string;
      remoteMcpConfigPath?: string;
    };

    const { sessionId, outpostName, remoteMcpConfigPath } = body;
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    // Stop the HTTP gateway process if running
    if (hasHttpGateway(sessionId)) {
      stopHttpGateway(sessionId);
    }

    // Clean up the remote /tmp config file (best-effort)
    if (outpostName && remoteMcpConfigPath) {
      outpostRpc(outpostName, "fs.delete", { path: remoteMcpConfigPath }).catch(() => {
        // non-fatal
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
