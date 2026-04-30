import { NextResponse, type NextRequest } from "next/server";
import { unlockVault } from "@/lib/vault";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return NextResponse.json(await unlockVault(String(body.passphrase ?? "")));
  } catch (error) {
    return jsonError(error, 400);
  }
}
