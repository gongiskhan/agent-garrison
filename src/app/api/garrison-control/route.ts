import { NextResponse, type NextRequest } from "next/server";
import { getResolvedModel, getResolvedSequence, getReadiness } from "@/lib/garrison-control";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/garrison-control — the READ-ONLY garrison-control surface (S4b, D15
// acceptance 9). It exposes the active composition's resolved model so DOOR 3 (the
// garrison skill) consults the SAME (duty, level) -> sequence the Kanban board
// (door 2) and the gateway dispatch (door 1) do — divergence zero.
//
//   ?composition=<id>            override the active-composition pointer (tests / switcher)
//   (no other params)            -> the whole resolved model { duties, selectedDuties,
//                                   kanbanLists, sequences, rules, ready, errors }
//   ?view=readiness              -> { rules, ready }
//   ?duty=<id>&level=<n>         -> { duty, level, sequence } — the ordered phase-list
//                                   ids a card carrying this (duty, level) VISITS
//
// This route has NO POST/PATCH/DELETE by design: garrison-control is read-only, and
// every composition write goes through Muster (/api/muster).
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const composition = params.get("composition")?.trim() || undefined;

    if (params.get("view") === "readiness") {
      return NextResponse.json(await getReadiness(composition));
    }

    const duty = params.get("duty")?.trim();
    const levelRaw = params.get("level")?.trim();
    if (duty) {
      const level = Number.parseInt(levelRaw ?? "", 10);
      if (!Number.isInteger(level) || level < 1) {
        return jsonError(new Error("level must be a positive integer when a duty is given"), 400);
      }
      return NextResponse.json(await getResolvedSequence(duty, level, composition));
    }

    return NextResponse.json(await getResolvedModel(composition));
  } catch (error) {
    return jsonError(error, 400);
  }
}
