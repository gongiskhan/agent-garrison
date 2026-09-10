import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";
import { ensureCaptureCredential } from "@/lib/capture-credential";
import { voiceProviderId } from "@/lib/voice-provider";
import { readNodeIdentity } from "@/lib/node-identity";
import { publicOrigin } from "@/lib/public-origin";
import { tailnetUrlForPort } from "@/lib/tailnet-serve";
import { healthAppOrigin } from "@/lib/mesh/node-row";
import { stateEnrolled, withState } from "@/lib/state-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Native URLSession bootstrap on the same private tailnet as the shell. No
// CORS and no browser clients: the credential travels straight into AppGroup,
// never through Capacitor's JavaScript bridge or the connector form.
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store", "Vary": "Origin, Sec-Fetch-Site" };
  if (request.headers.get("x-garrison-native") !== "capture-bootstrap" || request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return NextResponse.json({ error: "Native bootstrap only" }, { status: 403, headers });
  }
  try {
    const provider = await voiceProviderId();
    if (!provider) return NextResponse.json({ error: "Capture is not available on this node" }, { status: 503, headers });
    const status = JSON.parse(await readFile(path.join(garrisonDir(), "ui-fittings", `${provider}.json`), "utf8"));
    const port = Number(new URL(status.url).port);
    const captureBaseURL = await tailnetUrlForPort(port);
    if (!captureBaseURL) return NextResponse.json({ error: "Capture has no HTTPS address yet" }, { status: 503, headers });
    const shellOrigin = publicOrigin(request);
    if (new URL(captureBaseURL).hostname !== new URL(shellOrigin).hostname) {
      return NextResponse.json({ error: "Open this node using its HTTPS tailnet address" }, { status: 400, headers });
    }
    const nodes = stateEnrolled() ? await withState(async (client) => (await client.listNodes()).map((node) => ({ name: node.name, origin: healthAppOrigin(node.health) ?? (node.tailnetHost ? `https://${node.tailnetHost}` : null) }))) : [];
    const token = await ensureCaptureCredential();
    return NextResponse.json({ name: readNodeIdentity().id, shellOrigin, captureBaseURL, token, nodes }, { headers });
  } catch {
    return NextResponse.json({ error: "Mesh capture setup is unavailable; retry when the node is ready" }, { status: 503, headers });
  }
}
