import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";
import { isValidFittingId } from "@/lib/own-port-lifecycle";
import { currentProfile } from "@/lib/instance-profile";
import { publishPortToTailnet } from "@/lib/tailnet-publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Publish now" for the embed page's not-published state: front a running
// own-port fitting's port on the HTTPS tailnet on demand (issue #6), instead of
// waiting for the next redeploy's batch publisher.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isValidFittingId(params.id)) {
    return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
  }
  // Only prod is fronted on the always-on tailnet address; publishing from a
  // dev/codex instance would remap it onto that instance's server.
  if (currentProfile() !== "prod") {
    return NextResponse.json(
      { error: "only the prod instance is published to the tailnet" },
      { status: 409 }
    );
  }
  let port: number | null = null;
  try {
    const raw = await readFile(path.join(garrisonDir(), "ui-fittings", `${params.id}.json`), "utf8");
    const parsed = JSON.parse(raw) as { port?: number };
    if (typeof parsed.port === "number" && Number.isFinite(parsed.port)) port = parsed.port;
  } catch {
    /* not running / no status file */
  }
  if (port === null) {
    return NextResponse.json(
      { error: `${params.id} is not running (no port to publish)` },
      { status: 409 }
    );
  }
  const result = await publishPortToTailnet(port);
  if (result.action === "failed") {
    return NextResponse.json({ error: result.error ?? "publish failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...result });
}
