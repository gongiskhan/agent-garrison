import { NextResponse } from "next/server";
import { revokeOAuthGrant } from "@/lib/vault";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Revoke a connector's OAuth grant (the disconnect / re-auth action). The grant is
// marked revoked in the vault and the access is audited by the vault layer.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const id = params.id;
    await revokeOAuthGrant(id);
    return NextResponse.json({ ok: true, connector: id });
  } catch (error) {
    return jsonError(error, 400);
  }
}
