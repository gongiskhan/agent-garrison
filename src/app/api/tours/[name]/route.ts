import { NextResponse } from "next/server";
import { getTour } from "@/lib/tours-registry";

// GET /api/tours/<name> — the full descriptor the TourEngine plays. 404 when the
// name is unknown so the engine can surface a clean "tour not found".
export async function GET(_request: Request, { params }: { params: { name: string } }) {
  try {
    const tour = await getTour(params.name);
    if (!tour) {
      return NextResponse.json({ error: `unknown tour "${params.name}"` }, { status: 404 });
    }
    return NextResponse.json({ tour });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
