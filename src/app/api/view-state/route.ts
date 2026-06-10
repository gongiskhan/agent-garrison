import { NextResponse, type NextRequest } from "next/server";
import { isValidInstanceId } from "@/lib/view-instances";
import {
  deleteViewState,
  listFittingIds,
  listInstanceIds,
  readViewState,
  writeViewState
} from "@/lib/view-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The generic view-state store over HTTP — the persistence path for embedded
// (in-browser) views. Own-port fittings write the same on-disk files directly.
//
//   GET    /api/view-state                       -> { fittings: string[] }
//   GET    /api/view-state?fitting=f             -> { instances: string[] }
//   GET    /api/view-state?fitting=f&instance=i  -> { exists, envelope? }
//   PUT    /api/view-state {fitting, instance, state} -> { envelope }
//   DELETE /api/view-state?fitting=f&instance=i  -> { deleted }
//
// Writes are immediate + atomic here; the ~500ms debounce lives client-side
// in usePersistedViewState (no save buttons anywhere — state flows
// continuously).

function badId(value: string | null): boolean {
  return value !== null && !isValidInstanceId(value);
}

export async function GET(request: NextRequest) {
  const fitting = request.nextUrl.searchParams.get("fitting");
  const instance = request.nextUrl.searchParams.get("instance");
  if (badId(fitting) || badId(instance)) {
    return NextResponse.json({ error: "invalid fitting or instance id" }, { status: 400 });
  }
  try {
    if (!fitting) {
      return NextResponse.json({ fittings: await listFittingIds() });
    }
    if (!instance) {
      return NextResponse.json({ instances: await listInstanceIds(fitting) });
    }
    const result = await readViewState(fitting, instance);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  let body: { fitting?: unknown; instance?: unknown; state?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { fitting, instance } = body;
  if (
    typeof fitting !== "string" ||
    typeof instance !== "string" ||
    !isValidInstanceId(fitting) ||
    !isValidInstanceId(instance) ||
    !("state" in body)
  ) {
    return NextResponse.json(
      { error: "body must be { fitting, instance, state } with path-safe ids" },
      { status: 400 }
    );
  }
  try {
    const envelope = await writeViewState(fitting, instance, body.state);
    return NextResponse.json({ envelope });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const fitting = request.nextUrl.searchParams.get("fitting");
  const instance = request.nextUrl.searchParams.get("instance");
  if (!fitting || !instance || !isValidInstanceId(fitting) || !isValidInstanceId(instance)) {
    return NextResponse.json({ error: "fitting and instance query params required" }, { status: 400 });
  }
  try {
    const deleted = await deleteViewState(fitting, instance);
    return NextResponse.json({ deleted });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
