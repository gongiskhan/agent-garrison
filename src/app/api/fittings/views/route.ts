import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";
import { getTailnetServeMap } from "@/lib/tailnet-serve";
import { readNodeIdentity } from "@/lib/node-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads ~/.garrison/ui-fittings/*.json. Each file is written by a Fitting
// whose UI runs on its own port (Monitor pattern) and removed on SIGTERM.
// The body is {fittingId, port, url, pid, startedAt}. We probe /health
// server-side so the browser can avoid cross-origin requests.

interface ViewEntry {
  fittingId: string;
  port: number;
  url: string;
  // The HTTPS tailnet URL this view's port is exposed at via `tailscale serve`,
  // or null when it isn't serve-mapped. The browser uses this when reached over
  // Tailscale (the loopback `url` is unreachable + mixed-content there).
  tailnetUrl: string | null;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean;
}

export async function GET() {
  const dir = path.join(garrisonDir(), "ui-fittings");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return NextResponse.json({ views: [] });
    return NextResponse.json({ error: e.message ?? String(err) }, { status: 500 });
  }

  const identity = readNodeIdentity();
  // A tethered node has no tailnet listener of its own. Its local Tailscale
  // config can be stale; only the tether owner's published origin is usable.
  const serveMap = identity.tetherHost ? new Map<number, string>() : await getTailnetServeMap();

  const probes: Promise<ViewEntry | null>[] = names.map(async (name) => {
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as Partial<ViewEntry>;
      if (typeof parsed.fittingId !== "string" || typeof parsed.port !== "number" || typeof parsed.url !== "string") {
        return null;
      }
      const healthy = await probeHealth(parsed.url);
      return {
        fittingId: parsed.fittingId,
        port: parsed.port,
        url: parsed.url,
        tailnetUrl: tailnetUrlFor(identity, serveMap, parsed.fittingId, parsed.port),
        pid: typeof parsed.pid === "number" ? parsed.pid : null,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
        healthy
      };
    } catch {
      return null;
    }
  });
  const settled = await Promise.all(probes);
  const views = settled.filter((v): v is ViewEntry => v !== null);
  return NextResponse.json({ views });
}

// A tethered node has no tailnet listener of its own, so it has no origin to
// hand out for any own-port view except the one the tether itself forwards
// (remote-shell-runtime, at identity.shellOrigin). Every other view is
// reached through this app's own /api/fittings/proxy route instead — that
// path is relative (same-origin), so it works over whatever origin the tether
// already publishes for the app, with no new tailscale serve mapping and no
// tether.forwards change required. A non-tethered node keeps using the real
// tailscale serve map, unchanged.
function tailnetUrlFor(
  identity: { tetherHost: string | null; shellOrigin: string | null },
  serveMap: Map<number, string>,
  fittingId: string,
  port: number
): string | null {
  if (!identity.tetherHost) return serveMap.get(port) ?? null;
  if (fittingId === "remote-shell-runtime") return identity.shellOrigin;
  return `/api/fittings/proxy/${encodeURIComponent(fittingId)}`;
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url}/health`, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
