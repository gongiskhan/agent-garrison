import { NextResponse } from "next/server";
import { listConnectorAccounts, setConnectorOAuthAccount } from "@/lib/connector-auth";
import { SLACK_MESSAGES_SCOPES } from "../../../../../../packages/messages/providers/slack-common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!["google", "slack"].includes(params.id)) return NextResponse.json({ error: "This connector has no Messages accounts" }, { status: 404 });
  const accounts = await listConnectorAccounts(params.id);
  return NextResponse.json({ accounts: accounts.map(({ grantId: _grantId, ...account }) => account) });
}

/** An explicit connector setup action, separate from the Messages ingest lane. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (params.id !== "slack") return NextResponse.json({ error: "Use the connector's OAuth sign-in flow" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.token !== "string" || !body.token.startsWith("xoxp-") || body.token.length > 1024) {
    return NextResponse.json({ error: "Enter a Slack User OAuth Token" }, { status: 400 });
  }
  try {
    const response = await fetch("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${body.token}` }, signal: AbortSignal.timeout(10_000) });
    const identity = await response.json();
    if (!response.ok || !identity.ok || !identity.team_id || !identity.user_id) return NextResponse.json({ error: "Slack could not verify this user token" }, { status: 400 });
    const scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map(scope => scope.trim()).filter(Boolean);
    const account = { id: String(identity.team_id), label: String(identity.team ?? identity.team_id), address: String(identity.user_id) };
    await setConnectorOAuthAccount("slack", account, { accessToken: body.token, scopes, status: "valid" });
    return NextResponse.json({ account, missingScopes: SLACK_MESSAGES_SCOPES.filter(scope => !scopes.includes(scope)) });
  } catch {
    return NextResponse.json({ error: "Slack could not connect. Try again." }, { status: 502 });
  }
}
