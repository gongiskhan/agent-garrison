import { NextResponse } from "next/server";
import { getCaptureState, startCapture, stopCapture } from "@/lib/screen/capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARE_ID = "primary";

export async function GET() {
  const state = getCaptureState();
  return NextResponse.json({
    id: SHARE_ID,
    running: state.running,
    permissionGranted: state.permissionGranted,
    lastError: state.lastError,
    lastCaptureAt: state.lastCaptureAt,
  });
}

export async function POST() {
  const result = await startCapture();
  if (!result.success) {
    return NextResponse.json(
      { error: result.error ?? "capture failed" },
      { status: 500 }
    );
  }
  return NextResponse.json({ id: SHARE_ID, running: true }, { status: 201 });
}

export async function DELETE() {
  await stopCapture();
  return NextResponse.json({ ok: true });
}
