import { NextResponse, type NextRequest } from "next/server";
import { getCaptureState, startCapture, stopCapture } from "@/lib/screen/capture";
import { startRemoteCapture, stopRemoteCapture, getRemoteCaptureState } from "@/lib/screen/remote-capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARE_ID = "primary";

export async function GET(request: NextRequest) {
  const outpost = request.nextUrl.searchParams.get("outpost");
  if (outpost) {
    const state = await getRemoteCaptureState(outpost);
    return NextResponse.json({
      id: SHARE_ID,
      running: state.running,
      permissionGranted: true,
      lastError: state.lastError,
      lastCaptureAt: state.lastCaptureAt,
    });
  }
  const state = getCaptureState();
  return NextResponse.json({
    id: SHARE_ID,
    running: state.running,
    permissionGranted: state.permissionGranted,
    lastError: state.lastError,
    lastCaptureAt: state.lastCaptureAt,
  });
}

export async function POST(request: NextRequest) {
  const outpost = request.nextUrl.searchParams.get("outpost") ??
    (await request.json().then((b: { outpost?: string }) => b.outpost ?? null).catch(() => null));
  if (outpost) {
    const result = await startRemoteCapture(outpost);
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "capture failed" }, { status: 500 });
    }
    return NextResponse.json({ id: `${SHARE_ID}:${outpost}`, running: true, outpost }, { status: 201 });
  }
  const result = await startCapture();
  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "capture failed" }, { status: 500 });
  }
  return NextResponse.json({ id: SHARE_ID, running: true }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const outpost = request.nextUrl.searchParams.get("outpost") ??
    (await request.json().then((b: { outpost?: string }) => b.outpost ?? null).catch(() => null));
  if (outpost) {
    await stopRemoteCapture(outpost);
    return NextResponse.json({ ok: true });
  }
  await stopCapture();
  return NextResponse.json({ ok: true });
}
