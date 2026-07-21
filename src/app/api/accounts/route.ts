import { NextResponse, type NextRequest } from "next/server";
import { listAccounts, addAccount } from "@/lib/accounts";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RUNTIME-ACCOUNTS-V1: the account registry. GET returns metadata only —
// token values never reach the browser (vault discipline, D1).
export async function GET() {
  try {
    return NextResponse.json({ accounts: await listAccounts() });
  } catch (error) {
    return jsonError(error, 400);
  }
}

// Manual add: paste a token obtained elsewhere (e.g. `claude setup-token` on
// another machine). The token arrives in the request body over the local/
// tailnet HTTPS origin, is sealed straight into the vault, and is never echoed.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const meta = await addAccount({
      name: String(body.name ?? ""),
      token: String(body.token ?? ""),
      label: body.label ? String(body.label) : undefined
    });
    return NextResponse.json({ account: meta });
  } catch (error) {
    return jsonError(error, 400);
  }
}
