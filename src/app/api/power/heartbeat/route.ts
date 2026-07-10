// POST /api/power/heartbeat — the Garrison shell's presence relay
// (GARRISON-UNIFY-V1 S14, D34). The browser posts here same-origin every 60s
// (only while visible + recently interacted); this relays to the Power
// fitting's own-port server, discovered via its status file (URL-link
// contract — never a hardcoded port). Power absent → 204 silently (the
// heartbeat is advisory; nothing depends on it existing).
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";

export async function POST(): Promise<NextResponse> {
  try {
    const statusFile = path.join(garrisonDir(), "ui-fittings", "power-default.json");
    const status = JSON.parse(await fs.readFile(statusFile, "utf8")) as { url?: string; port?: number };
    const base = status.url || `http://127.0.0.1:${status.port}`;
    await fetch(`${base}/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "garrison-shell" }),
      signal: AbortSignal.timeout(1500)
    });
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 }); // advisory — never surface an error
  }
}
