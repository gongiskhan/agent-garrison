import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

const OUTPOST_HOST = "http://127.0.0.1:3702";

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { name, garrison_host } = body as { name?: string; garrison_host?: string };
  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!garrison_host?.trim()) return NextResponse.json({ error: "garrison_host is required" }, { status: 400 });

  const token = randomBytes(32).toString("hex");
  const machineName = name.trim();
  const host = garrison_host.trim();

  let regRes: Response;
  try {
    regRes = await fetch(`${OUTPOST_HOST}/registry/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: machineName, token }),
    });
  } catch (err) {
    return NextResponse.json({ error: `outpost-host unreachable: ${String(err)}` }, { status: 503 });
  }

  if (!regRes.ok) {
    const data = (await regRes.json().catch(() => ({}))) as { error?: string };
    return NextResponse.json({ error: data.error ?? `outpost-host HTTP ${regRes.status}` }, { status: 500 });
  }

  const wsUrl = `ws://${host}:3702/bridge`;
  const scriptUrl = `http://${host}:3000/api/workbench/outposts/bootstrap-outpost`;
  const command = `GARRISON_HOST=${wsUrl} GARRISON_TOKEN=${token} GARRISON_MACHINE=${machineName} bash <(curl -fsSL ${scriptUrl})`;

  return NextResponse.json({ ok: true, name: machineName, token, command });
}
