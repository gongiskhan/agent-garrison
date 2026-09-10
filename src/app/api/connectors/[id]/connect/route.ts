import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { credentialNames, writeConnectorSecrets } from "@/lib/connector-auth";
import { saveCortexBase } from "@/lib/cortex-connection";
import { connectorIdOf } from "@/lib/connectors-view";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Connect an api_key connector: set ONLY its declared secret_scope secrets in the
// Vault (merged, never replacing the rest). Keys outside the connector's scope are
// rejected, so this route can't write arbitrary secrets. Values are written
// straight into the AES-256-GCM Vault and never returned.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const id = params.id;
    const body = (await request.json().catch(() => ({}))) as { secrets?: Record<string, string>; baseUrl?: string };
    const provided = body.secrets ?? {};

    const library = await readLibrary();
    const entry = library.find((e) => connectorIdOf(e) === id);
    if (!entry) return NextResponse.json({ error: "unknown connector" }, { status: 404 });

    if (entry.metadata.connector?.managed) return NextResponse.json({ error: "Managed internally" }, { status: 400 });
    const scope = entry.metadata.secret_scope ?? [];
    const hasBase = (id === "cortex" || id === "cortex-automations") && body.baseUrl !== undefined;
    const keys = Object.keys(provided);
    if (keys.length === 0 && !hasBase) return NextResponse.json({ error: "no secrets provided" }, { status: 400 });
    const outside = keys.filter((k) => !scope.includes(k));
    if (outside.length > 0) {
      return NextResponse.json({ error: `secrets outside this connector's scope: ${outside.join(", ")}` }, { status: 400 });
    }
    // Empty values are rejected — clearing a secret is a Vault action, not connect.
    const blank = keys.filter((k) => typeof provided[k] !== "string" || provided[k].trim() === "");
    if (blank.length > 0) return NextResponse.json({ error: `empty value(s): ${blank.join(", ")}` }, { status: 400 });

    if (hasBase) await saveCortexBase(body.baseUrl!);
    if (keys.length) await writeConnectorSecrets(provided);
    const present = new Set(await credentialNames());
    const sealed = scope.length > 0 && scope.every((k) => present.has(k));
    return NextResponse.json({ ok: true, connector: id, sealed });
  } catch (error) {
    return jsonError(error, 400);
  }
}
