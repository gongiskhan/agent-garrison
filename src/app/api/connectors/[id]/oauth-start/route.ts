import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { scopedSecrets } from "@/lib/vault";
import { connectorIdOf } from "@/lib/connectors-view";
import { createOAuthState } from "@/lib/oauth-state";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Begin the OAuth authorization-code flow: build the provider authorize URL from
// the connector's declared oauth block + the user's own client id (a Vault
// secret). Returns { authUrl, redirectUri } — the panel sends the browser to
// authUrl; redirectUri is shown so the user can register it in their OAuth app.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const id = params.id;
    const entry = (await readLibrary()).find((e) => connectorIdOf(e) === id);
    if (!entry) return NextResponse.json({ error: "unknown connector" }, { status: 404 });
    const oauth = entry.metadata.connector?.oauth;
    if (!oauth) return NextResponse.json({ error: "connector has no oauth config" }, { status: 400 });

    // Resolve by NAME (scopedSecrets order is not guaranteed).
    const clientId = (await scopedSecrets([oauth.clientIdSecret])).find((s) => s.key === oauth.clientIdSecret)?.value?.trim();
    if (!clientId) {
      // Client credentials not set yet — the panel shows the client-id/secret form.
      return NextResponse.json({ error: "client-credentials-missing", needs: [oauth.clientIdSecret, oauth.clientSecretSecret] }, { status: 409 });
    }

    // Derive the origin from the Host the browser actually used, NOT
    // new URL(request.url): under `next -H 0.0.0.0` (npm run start:mobile)
    // request.url reports the 0.0.0.0 bind address even when the user opened
    // 127.0.0.1, producing redirect_uri=http://0.0.0.0:... which Google rejects
    // with "invalid_request" (http on a non-loopback host). The Host header
    // carries the real address navigated to (127.0.0.1, a tailnet name, …).
    const reqUrl = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto") ?? reqUrl.protocol.replace(/:$/, "");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? reqUrl.host;
    const origin = `${proto}://${host}`;
    const redirectUri = `${origin}/api/connectors/${encodeURIComponent(id)}/oauth-callback`;
    const state = createOAuthState(id, redirectUri);

    const authUrl = new URL(oauth.authUrl);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", oauth.scopes.join(" "));
    authUrl.searchParams.set("access_type", "offline"); // request a refresh token
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);

    return NextResponse.json({ authUrl: authUrl.toString(), redirectUri });
  } catch (error) {
    return jsonError(error, 400);
  }
}
