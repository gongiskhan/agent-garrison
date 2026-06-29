import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { scopedSecrets, setOAuthGrant } from "@/lib/vault";
import { connectorIdOf } from "@/lib/connectors-view";
import { consumeOAuthState } from "@/lib/oauth-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string, q: string) {
  return NextResponse.redirect(`${origin}/connectors?${q}`);
}

// OAuth provider redirect target: validate the CSRF state, exchange the code for
// tokens (with the user's client id/secret), and seal the grant in the Vault.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const providerError = url.searchParams.get("error");

  if (providerError) return back(origin, `connect_error=${encodeURIComponent(providerError)}`);
  if (!code) return back(origin, "connect_error=missing_code");

  // Single-use, connector-bound CSRF state.
  const bound = consumeOAuthState(state, id);
  if (!bound) return back(origin, "connect_error=invalid_state");

  try {
    const entry = (await readLibrary()).find((e) => connectorIdOf(e) === id);
    const oauth = entry?.metadata.connector?.oauth;
    if (!oauth) return back(origin, "connect_error=no_oauth_config");

    // Resolve by NAME, not array position — scopedSecrets does not guarantee
    // request order, so positional reads could swap id/secret.
    const byName = new Map((await scopedSecrets([oauth.clientIdSecret, oauth.clientSecretSecret])).map((s) => [s.key, s.value]));
    const clientId = byName.get(oauth.clientIdSecret)?.trim();
    const clientSecret = byName.get(oauth.clientSecretSecret)?.trim();
    if (!clientId || !clientSecret) return back(origin, "connect_error=client_credentials_missing");

    const res = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: bound.redirectUri
      })
    });
    if (!res.ok) return back(origin, `connect_error=token_exchange_${res.status}`);
    const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tok.access_token) return back(origin, "connect_error=no_access_token");

    await setOAuthGrant(id, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : undefined,
      tokenUrl: oauth.tokenUrl,
      clientId,
      clientSecretKey: oauth.clientSecretSecret,
      scopes: oauth.scopes,
      status: "valid"
    });

    return back(origin, `connected=${encodeURIComponent(id)}`);
  } catch {
    return back(origin, "connect_error=exchange_failed");
  }
}
