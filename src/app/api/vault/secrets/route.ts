import { NextResponse, type NextRequest } from "next/server";
import { vaultView, writeVaultSecrets } from "@/lib/vault";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await vaultView());
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const secrets = await writeVaultSecrets(body.secrets ?? []);
    return NextResponse.json({ unlocked: true, secrets });
  } catch (error) {
    return jsonError(error, 400);
  }
}
