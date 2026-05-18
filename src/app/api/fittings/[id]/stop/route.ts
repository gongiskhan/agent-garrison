import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Send SIGTERM to the running own-port Fitting identified by its discovery
// JSON file. The Fitting is expected to remove the JSON file on SIGTERM, but
// we delete it defensively in case it leaks.
export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    return await handle(params.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handle(fittingId: string): Promise<NextResponse> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(fittingId)) {
    return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
  }

  const jsonPath = path.join(os.homedir(), ".garrison", "ui-fittings", `${fittingId}.json`);
  if (!existsSync(jsonPath)) {
    return NextResponse.json({ ok: true, wasRunning: false });
  }

  let pid: number | null = null;
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid === "number") pid = parsed.pid;
  } catch {
    // fall through; we'll still delete the file
  }

  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ESRCH") {
        return NextResponse.json({ error: e.message ?? String(err) }, { status: 500 });
      }
    }
  }

  // Best-effort cleanup; the Fitting normally does this itself on SIGTERM.
  try {
    await unlink(jsonPath);
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true, wasRunning: pid !== null, pid });
}
