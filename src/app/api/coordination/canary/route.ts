import { NextResponse } from "next/server";
import { runCoord } from "@/lib/coord-cli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/coordination/canary — runs the PTY-safe canary (the SAME `coord canary`
// the CLI runs: write -> detect -> inject self-test). No model call.
export async function POST() {
  try {
    const { code, stdout, stderr } = await runCoord(["canary"], 20000);
    const out = `${stdout}${stderr}`;
    const ok = code === 0 && /COORD-CANARY OK/.test(out);
    return NextResponse.json({ ok, code, output: out.trim().slice(-2000), at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message, at: new Date().toISOString() }, { status: 200 });
  }
}
