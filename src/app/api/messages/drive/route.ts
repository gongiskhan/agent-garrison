import { NextRequest, NextResponse } from "next/server";
import { getConnectorAccountToken, listConnectorAccounts } from "@/lib/connector-auth";
import { uploadMessageAttachment } from "@/lib/messages-media";
import { createGoogleDriveAdapter } from "../../../../../packages/messages/providers/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

async function accountOptions(requested?: string | null) {
  const accounts = (await listConnectorAccounts("google")).filter(account => account.status !== "revoked" && account.scopes.includes(DRIVE_SCOPE));
  const selected = requested ? accounts.find(account => account.id === requested) : accounts[0];
  if (!selected) throw new Error("Google Drive is not connected. Connect it in Connectors.");
  const token = await getConnectorAccountToken("google", selected.id);
  return { selected, accounts: accounts.map(({ id, label, address }) => ({ id, label, address })), adapter: createGoogleDriveAdapter({ token }) };
}
export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    const { adapter, accounts, selected } = await accountOptions(params.get("account"));
    return NextResponse.json({ ...await adapter.listFiles(params.get("q") ?? "", params.get("pageToken") ?? undefined), accounts, account: selected.id });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) return NextResponse.json({ error: "Cross-origin changes are not allowed" }, { status: 403 });
    const input = await request.json();
    const { adapter, selected } = await accountOptions(input.account);
    const result = await adapter.downloadFile(String(input.fileId ?? ""));
    if ("link" in result) return NextResponse.json({ link: result.link, name: result.name });
    // The bytes are transferred directly to the owned file store, never to state.
    return NextResponse.json(await uploadMessageAttachment({ provider: input.targetProvider ?? "google", account: input.targetAccount ?? selected.id,
      name: result.name, mime: result.mime, base64: Buffer.from(result.bytes).toString("base64") }));
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 503 }); }
}
