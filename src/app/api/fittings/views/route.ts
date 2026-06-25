import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";
import { getTailnetServeMap } from "@/lib/tailnet-serve";

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

  const serveMap = await getTailnetServeMap();

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
        tailnetUrl: serveMap.get(parsed.port) ?? null,
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
