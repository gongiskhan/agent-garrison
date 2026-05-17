import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads ~/.garrison/ui-fittings/*.json. Each file is written by a tool
// Fitting on boot ({fittingId, port, url, pid, startedAt}) and removed on
// SIGTERM. Returns the list as-is; the client probes /health to surface
// reachability.

interface ToolEntry {
  fittingId: string;
  port: number;
  url: string;
  pid: number | null;
  startedAt: string | null;
}

export async function GET() {
  const dir = path.join(os.homedir(), ".garrison", "ui-fittings");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return NextResponse.json({ tools: [] });
    return NextResponse.json({ error: e.message ?? String(err) }, { status: 500 });
  }

  const tools: ToolEntry[] = [];
  for (const name of names) {
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as Partial<ToolEntry>;
      if (typeof parsed.fittingId === "string" && typeof parsed.port === "number" && typeof parsed.url === "string") {
        tools.push({
          fittingId: parsed.fittingId,
          port: parsed.port,
          url: parsed.url,
          pid: typeof parsed.pid === "number" ? parsed.pid : null,
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null
        });
      }
    } catch {
      // skip malformed entries
    }
  }
  return NextResponse.json({ tools });
}
