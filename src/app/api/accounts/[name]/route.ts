import { NextResponse } from "next/server";
import { removeAccount } from "@/lib/accounts";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_: Request, { params }: { params: { name: string } }) {
  try {
    await removeAccount(params.name);
    return NextResponse.json({ removed: params.name });
  } catch (error) {
    return jsonError(error, 400);
  }
}
