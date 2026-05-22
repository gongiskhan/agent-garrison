import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the tail of the per-Fitting log file written by the start route.
// Capped so a noisy server can't flood the response.
const MAX_BYTES = 256 * 1024;

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const fittingId = params.id;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(fittingId)) {
    return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
  }

  const logPath = path.join(os.homedir(), ".garrison", "ui-fittings", `${fittingId}.log`);
  if (!existsSync(logPath)) {
    return NextResponse.json({ content: "", exists: false, size: 0, mtime: 0, truncated: false });
  }

  try {
    const stats = await stat(logPath);
    const raw = await readFile(logPath, "utf8");
    const truncated = raw.length > MAX_BYTES;
    const content = truncated ? raw.slice(raw.length - MAX_BYTES) : raw;
    return NextResponse.json({
      content,
      truncated,
      exists: true,
      size: stats.size,
      mtime: stats.mtimeMs
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
