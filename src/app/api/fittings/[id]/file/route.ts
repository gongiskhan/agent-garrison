import { NextResponse, type NextRequest } from "next/server";
import { FittingFileError, readFile, writeFile } from "@/lib/fitting-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userPath = request.nextUrl.searchParams.get("path") ?? "";
    const result = await readFile(params.id, userPath);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FittingFileError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const userPath = String(body?.path ?? "");
    const content = typeof body?.content === "string" ? body.content : "";
    const result = await writeFile(params.id, userPath, content);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof FittingFileError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
