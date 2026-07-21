import { NextResponse } from "next/server";
import { listTours } from "@/lib/tours-registry";

// GET /api/tours — every discoverable tour as a lightweight summary (the Assistant
// Guide + any future tour picker read this).
export async function GET() {
  try {
    const tours = await listTours();
    return NextResponse.json({ tours });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
