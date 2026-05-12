import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_PATH = path.join(homedir(), ".garrison", "vault-sync-status.json");
// sync.py writes to this same path (~/.garrison/vault-sync-status.json).

export async function GET() {
  try {
    const raw = await fsp.readFile(STATUS_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return NextResponse.json(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({});
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
