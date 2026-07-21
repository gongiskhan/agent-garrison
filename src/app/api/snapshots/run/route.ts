import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { jsonError } from "@/lib/http";
import { resolveScriptsDir } from "../core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/snapshots/run
// Fire-and-forget: spawn backup.sh detached so the snapshot survives the request
// (and the browser tab). Progress is not streamed; the outcome lands in
// state.json, which GET status surfaces.
export async function POST() {
  try {
    const scriptsDir = resolveScriptsDir();
    const child = spawn("bash", [path.join(scriptsDir, "backup.sh")], {
      env: process.env,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return NextResponse.json({ started: true });
  } catch (error) {
    return jsonError(error, 500);
  }
}
