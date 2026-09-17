import { NextResponse, type NextRequest } from "next/server";
import { readCompositionWithDerivedTasks } from "@/lib/compositions";
import { readLibrary } from "@/lib/library";
import { fittingSharingInfo } from "@/lib/fitting-sharing";
import { jsonError } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const composition = await readCompositionWithDerivedTasks(request.nextUrl.searchParams.get("composition") || undefined);
    const library = await readLibrary(); const entry = library.find(item => item.id === params.id);
    if (!entry) return NextResponse.json({ error: "Fitting not found" }, { status: 404 });
    return NextResponse.json(await fittingSharingInfo(entry, composition, library));
  } catch (error) { return jsonError(error, 400); }
}
