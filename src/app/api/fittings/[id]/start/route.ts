import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { startOwnPortFitting, isValidFittingId } from "@/lib/own-port-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    if (!isValidFittingId(params.id)) {
      return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
    }
    const library = await readLibrary();
    const entry = library.find((e) => e.id === params.id);
    if (!entry) {
      return NextResponse.json({ error: `fitting ${params.id} not in library` }, { status: 404 });
    }
    const result = await startOwnPortFitting(entry);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "start failed" }, { status: result.status ?? 500 });
    }
    if (result.alreadyRunning) {
      return NextResponse.json({ ok: true, alreadyRunning: true });
    }
    return NextResponse.json({ ok: true, pid: result.pid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
