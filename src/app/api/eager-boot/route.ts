import { NextResponse, type NextRequest } from "next/server";
import { readEagerBootPrefs, setEagerBoot } from "@/lib/eager-boot";
import { isValidInstanceId } from "@/lib/view-instances";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-fitting eager-boot toggles for the Run panel's Views card.
//
//   GET /api/eager-boot                  -> { prefs }
//   PUT /api/eager-boot {fitting, eager} -> { prefs } (updated)
//
// Persistence itself is always on (view-state, Layer 2); these prefs only
// control whether a view boots with the server. Writes land immediately —
// no save buttons anywhere.

export async function GET() {
  try {
    return NextResponse.json({ prefs: await readEagerBootPrefs() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  let body: { fitting?: unknown; eager?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { fitting, eager } = body;
  if (typeof fitting !== "string" || !isValidInstanceId(fitting) || typeof eager !== "boolean") {
    return NextResponse.json(
      { error: "body must be { fitting, eager } with a path-safe fitting id and boolean eager" },
      { status: 400 }
    );
  }
  try {
    const prefs = await setEagerBoot(fitting, eager);
    return NextResponse.json({ prefs });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
