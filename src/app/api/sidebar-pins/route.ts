import { NextResponse, type NextRequest } from "next/server";
import { readSidebarPins, writeSidebarPins } from "@/lib/sidebar-pins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The sidebar Fittings menu's pinned list.
//   GET /api/sidebar-pins                 -> { pins }
//   PUT /api/sidebar-pins { pinned: [] }  -> { pins } (full replace: pin,
//     unpin, and reorder are all this one write; no save buttons anywhere)

export async function GET() {
  try {
    return NextResponse.json({ pins: await readSidebarPins() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  let body: { pinned?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.pinned)) {
    return NextResponse.json({ error: "body must be { pinned: string[] }" }, { status: 400 });
  }
  try {
    const pins = await writeSidebarPins(body.pinned as string[]);
    return NextResponse.json({ pins });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
