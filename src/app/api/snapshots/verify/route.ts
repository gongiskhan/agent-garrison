import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { jsonError } from "@/lib/http";
import { resolveScriptsDir } from "../core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/snapshots/verify
// Runs `restic check` (via verify.sh) and returns the result. Read-only; can be
// slow on a large repo, so the timeout is generous.
export async function POST() {
  try {
    const scriptsDir = resolveScriptsDir();
    const res = spawnSync("bash", [path.join(scriptsDir, "verify.sh")], {
      env: process.env,
      encoding: "utf8",
      timeout: 120000
    });
    if (res.error) {
      return NextResponse.json({ ok: false, output: res.error.message });
    }
    const ok = res.status === 0;
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    return NextResponse.json({ ok, output });
  } catch (error) {
    return jsonError(error, 500);
  }
}
