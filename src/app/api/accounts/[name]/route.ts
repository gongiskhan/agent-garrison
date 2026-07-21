import { NextResponse, type NextRequest } from "next/server";
import { removeAccount, setAccountPolicy } from "@/lib/accounts";
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

// PAYMASTER D7/D11: autosaved policy edits (enabled toggle, ceiling percent,
// label). Registry metadata only - the vault is never touched here.
export async function PATCH(request: NextRequest, { params }: { params: { name: string } }) {
  try {
    const body = await request.json();
    const meta = await setAccountPolicy(params.name, {
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.ceiling !== undefined ? { ceiling: Number(body.ceiling) } : {}),
      ...(body.label !== undefined ? { label: String(body.label) } : {})
    });
    return NextResponse.json({ account: meta });
  } catch (error) {
    return jsonError(error, 400);
  }
}
