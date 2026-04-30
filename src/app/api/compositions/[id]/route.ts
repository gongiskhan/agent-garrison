import { NextResponse, type NextRequest } from "next/server";
import { readCompositionWithDerivedTasks, writeComposition } from "@/lib/compositions";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ composition: await readCompositionWithDerivedTasks(params.id) });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const composition = await writeComposition(params.id, {
      name: body.name,
      selections: body.selections,
      globalConfig: body.globalConfig
    });
    return NextResponse.json({ composition });
  } catch (error) {
    return jsonError(error, 400);
  }
}
