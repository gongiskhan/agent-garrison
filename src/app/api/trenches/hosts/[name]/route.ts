import { NextResponse } from "next/server";
import { deleteHost } from "@/lib/hosts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: { name: string } }
) {
  try {
    const hosts = deleteHost(decodeURIComponent(params.name));
    return NextResponse.json({ hosts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
