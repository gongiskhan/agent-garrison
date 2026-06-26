import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { scopedSecrets, getAccessToken } from "@/lib/vault";
import { verifyInternalToken } from "@/lib/internal-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolve a connector's scoped auth env for the Automations engine. The engine
// (a separate own-port process) cannot read the Vault directly; it POSTs here
// and Garrison returns ONLY this connector's auth, freshly materialized:
//   - api_key  -> the connector's `secret_scope` secrets ({KEY: value})
//   - oauth2   -> a freshly-refreshed { <ID>_ACCESS_TOKEN: token }
// 409 means "not connected" (the engine then pauses awaiting_connector). The
// values are never logged; they live only in the one request + the one process.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const connectorId = params.id;
  if (!/^[a-zA-Z0-9_-]+$/.test(connectorId)) {
    return NextResponse.json({ error: "invalid connector id" }, { status: 400 });
  }
  // Caller capability check — this route returns secrets/tokens, so only a
  // process holding the 0600 internal token may call it.
  if (!(await verifyInternalToken(req.headers.get("x-garrison-internal")))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const library = await readLibrary();
    const entry = library.find((e) =>
      e.metadata.provides.some((p) => p.kind === "connector" && p.name === connectorId)
    );
    if (!entry) {
      return NextResponse.json({ error: `no connector provides "${connectorId}"` }, { status: 404 });
    }
    const auth = entry.metadata.connector?.auth ?? "api_key";

    if (auth === "oauth2") {
      try {
        const token = await getAccessToken(connectorId);
        return NextResponse.json({ env: { [`${connectorId.toUpperCase()}_ACCESS_TOKEN`]: token } });
      } catch {
        // missing/expired/revoked grant -> reconnect required
        return NextResponse.json({ awaiting_connector: true, service: connectorId }, { status: 409 });
      }
    }

    // auth: none -> no credentials to deliver.
    if (auth === "none") {
      return NextResponse.json({ env: {} });
    }

    // api_key: deliver ONLY the connector's scoped secrets.
    const scope = entry.metadata.secret_scope ?? [];
    const secrets = scope.length > 0 ? await scopedSecrets(scope) : [];
    if (secrets.length === 0) {
      return NextResponse.json({ awaiting_connector: true, service: connectorId }, { status: 409 });
    }
    const env = Object.fromEntries(secrets.map((s) => [s.key, s.value]));
    return NextResponse.json({ env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
