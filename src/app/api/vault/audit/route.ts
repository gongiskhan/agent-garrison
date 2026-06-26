import { NextResponse, type NextRequest } from "next/server";
import { readVaultAudit } from "@/lib/vault-audit";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Vault access audit log (deliver/read/refresh/revoke/denied). Records carry
// secret NAMES only, never values, so this is safe to surface.
export async function GET(request: NextRequest) {
  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "100");
    return NextResponse.json({ entries: await readVaultAudit(Number.isFinite(limit) ? limit : 100) });
  } catch (error) {
    return jsonError(error, 400);
  }
}
