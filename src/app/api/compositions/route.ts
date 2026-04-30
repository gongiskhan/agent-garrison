import { NextResponse } from "next/server";
import { listCompositions, readCompositionWithDerivedTasks } from "@/lib/compositions";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const compositions = await listCompositions();
    const withDerived = await Promise.all(
      compositions.map((composition) => readCompositionWithDerivedTasks(composition.id))
    );
    return NextResponse.json({ compositions: withDerived });
  } catch (error) {
    return jsonError(error, 500);
  }
}
