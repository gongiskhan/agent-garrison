import { NextRequest, NextResponse } from "next/server";
import { getConnectorAccountToken, listConnectorAccounts } from "@/lib/connector-auth";
import { createGoogleReadAdapter } from "../../../../../../../packages/messages/providers/google-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export async function GET(request: NextRequest) {
  try {
    const requested = new URL(request.url).searchParams.get("account");
    const accounts = (await listConnectorAccounts("google")).filter(account => account.status !== "revoked" && account.scopes.includes(MAIL_SCOPE));
    const selected = requested ? accounts.find(account => account.id === requested) : accounts[0];
    if (!selected) return NextResponse.json({ error: "Google needs setup: reconnect Google with mail read scope in Connectors" }, { status: 503 });
    const token = await getConnectorAccountToken("google", selected.id);
    const labels = await createGoogleReadAdapter({ token }).listLabels();
    return NextResponse.json({ account: selected.id, labels });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
