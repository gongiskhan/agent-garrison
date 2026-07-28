import { NextResponse, type NextRequest } from "next/server";
import { listAccounts, addAccount } from "@/lib/accounts";
import { normalizeCredentialKind, normalizePlatform } from "@/lib/account-env";
import { verifyAccountToken, applyVerifyToRegistry } from "@/lib/account-login";
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
//
// `verify: true` additionally probes the provider before answering, so a pasted
// key gets the same honest verdict as the guided flow (and a typo'd one is
// caught here rather than at the next spawn). The token is already sealed by
// then — a failed probe reports, it does not roll the account back.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const platform = normalizePlatform(body.platform);
    const credentialKind = normalizeCredentialKind(body.credential_kind);
    const token = String(body.token ?? "");
    const meta = await addAccount({
      name: String(body.name ?? ""),
      token,
      label: body.label ? String(body.label) : undefined,
      platform,
      credential_kind: credentialKind,
      env_keys: Array.isArray(body.env_keys) ? body.env_keys.map((k: unknown) => String(k)) : undefined
    });
    if (!body.verify) return NextResponse.json({ account: meta });
    const verify = await verifyAccountToken(meta.name, token, platform, fetch, credentialKind);
    await applyVerifyToRegistry(meta.name, verify);
    return NextResponse.json({ account: meta, verify });
  } catch (error) {
    return jsonError(error, 400);
  }
}
