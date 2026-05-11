import { NextResponse } from "next/server";
import { ensureWsServer, trenchesBaseUrl, trenchesWsUrl } from "@/lib/trenches/ws-server";
import { getCaptureState } from "@/lib/screen/capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UpstreamSession {
  id: string;
  name: string;
  type: "terminal" | "screen-share";
  busy: boolean;
}

function screenShareSession(): UpstreamSession | null {
  const state = getCaptureState();
  if (!state.running) return null;
  const fresh = state.lastCaptureAt && Date.now() - state.lastCaptureAt < 2_000;
  return {
    id: "primary",
    name: "screen-share",
    type: "screen-share",
    busy: Boolean(fresh),
  };
}

export async function GET() {
  try {
    await ensureWsServer();
    const res = await fetch(`${trenchesBaseUrl()}/sessions`, {
      cache: "no-store",
    });
    const sessions: UpstreamSession[] = res.ok ? ((await res.json()).sessions ?? []) : [];
    const ss = screenShareSession();
    if (ss) sessions.push(ss);
    if (!res.ok) {
      return NextResponse.json(
        { sessions, wsUrl: trenchesWsUrl(), error: `upstream ${res.status}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ sessions, wsUrl: trenchesWsUrl() });
  } catch (err) {
    const ss = screenShareSession();
    return NextResponse.json(
      {
        sessions: ss ? [ss] : [],
        wsUrl: trenchesWsUrl(),
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
