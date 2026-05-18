import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readLibrary } from "@/lib/library";
import { ROOT_DIR } from "@/lib/paths";
import { isOwnPortFaculty } from "@/lib/faculties";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Spawn an own-port tool Fitting's start.mjs in the background. The Fitting
// writes ~/.garrison/ui-fittings/<id>.json on boot; the discovery hook in the
// client picks it up on the next poll (or via an explicit refresh).
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

  const library = await readLibrary();
  const entry = library.find((e) => e.id === fittingId);
  if (!entry) {
    return NextResponse.json({ error: `fitting ${fittingId} not in library` }, { status: 404 });
  }
  if (!isOwnPortFaculty(entry.faculty)) {
    return NextResponse.json({ error: `fitting ${fittingId} is not an own-port Fitting` }, { status: 400 });
  }

  if (await isAlreadyRunning(fittingId)) {
    return NextResponse.json({ ok: true, alreadyRunning: true });
  }

  if (!entry.localPath) {
    return NextResponse.json({ error: `fitting ${fittingId} has no localPath` }, { status: 400 });
  }
  const fittingDir = path.resolve(ROOT_DIR, entry.localPath);
  if (!fittingDir.startsWith(ROOT_DIR + path.sep)) {
    return NextResponse.json({ error: "fitting path escapes repo root" }, { status: 400 });
  }
  const startScript = path.join(fittingDir, "scripts", "start.mjs");
  if (!existsSync(startScript)) {
    return NextResponse.json(
      { error: `no start script at ${startScript}` },
      { status: 400 }
    );
  }

  const child = spawn(process.execPath, [startScript], {
    cwd: fittingDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env }
  });
  child.unref();

  if (typeof child.pid !== "number") {
    return NextResponse.json({ error: "spawn failed (no pid)" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, pid: child.pid });
}

async function isAlreadyRunning(fittingId: string): Promise<boolean> {
  const jsonPath = path.join(os.homedir(), ".garrison", "ui-fittings", `${fittingId}.json`);
  if (!existsSync(jsonPath)) return false;
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid !== "number") return false;
    // process.kill(pid, 0) throws if the process is gone.
    try {
      process.kill(parsed.pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
