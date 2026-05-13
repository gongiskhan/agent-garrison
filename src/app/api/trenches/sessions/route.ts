import { NextResponse } from "next/server";
import { ensureWsServer, trenchesBaseUrl, trenchesWsUrl } from "@/lib/trenches/ws-server";
import { getCaptureState } from "@/lib/screen/capture";
import { getRemoteCaptureState } from "@/lib/screen/remote-capture";
import { listOutposts } from "@/lib/outpost-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UpstreamSession {
  id: string;
  name: string;
  type: "terminal" | "screen-share";
  source?: "local" | "outpost";
  outpost?: string | null;
  busy: boolean;
}

function localScreenShareSession(): UpstreamSession | null {
  const state = getCaptureState();
  if (!state.running) return null;
  const fresh = state.lastCaptureAt && Date.now() - state.lastCaptureAt < 2_000;
  return { id: "primary", name: "screen-share", type: "screen-share", source: "local", busy: Boolean(fresh) };
}

async function remoteScreenShareSessions(): Promise<UpstreamSession[]> {
  try {
    const outposts = await listOutposts();
    const connected = outposts.filter((o) => o.connected);
    const results = await Promise.allSettled(
      connected.map(async (o): Promise<UpstreamSession | null> => {
        const state = await getRemoteCaptureState(o.name);
        if (!state.running) return null;
        return {
          id: `screen-share:${o.name}`,
          name: `screen-share@${o.name}`,
          type: "screen-share",
          source: "outpost",
          outpost: o.name,
          busy: false,
        };
      })
    );
    return results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((s): s is UpstreamSession => s !== null);
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    await ensureWsServer();
    const [termRes, remoteSS] = await Promise.all([
      fetch(`${trenchesBaseUrl()}/sessions`, { cache: "no-store" }),
      remoteScreenShareSessions(),
    ]);
    const sessions: UpstreamSession[] = termRes.ok
      ? ((await termRes.json()).sessions ?? [])
      : [];
    const localSS = localScreenShareSession();
    if (localSS) sessions.push(localSS);
    sessions.push(...remoteSS);
    if (!termRes.ok) {
      return NextResponse.json(
        { sessions, wsUrl: trenchesWsUrl(), error: `upstream ${termRes.status}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ sessions, wsUrl: trenchesWsUrl() });
  } catch (err) {
    const localSS = localScreenShareSession();
    return NextResponse.json(
      {
        sessions: localSS ? [localSS] : [],
        wsUrl: trenchesWsUrl(),
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
