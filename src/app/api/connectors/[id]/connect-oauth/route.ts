import { NextResponse } from "next/server";
import { setOAuthGrant } from "@/lib/vault";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual OAuth connect: seal a token the user already holds (e.g. from gcloud or a
// service account) directly as a grant, for connectors where running the full
// redirect flow isn't worth it. The token goes straight into the Vault.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const id = params.id;
    const body = (await request.json().catch(() => ({}))) as {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: string;
    };
    const accessToken = (body.accessToken ?? "").trim();
    if (!accessToken) return NextResponse.json({ error: "accessToken required" }, { status: 400 });

    await setOAuthGrant(id, {
      accessToken,
      refreshToken: body.refreshToken?.trim() || undefined,
      expiresAt: body.expiresAt || undefined,
      status: "valid"
    });
    return NextResponse.json({ ok: true, connector: id });
  } catch (error) {
    return jsonError(error, 400);
  }
}
