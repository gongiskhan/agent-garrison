import { NextResponse, type NextRequest } from "next/server";
import { cancelLogin, loginStatus, sendLoginInput } from "@/lib/account-login";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Status poll — never contains a token value (the helper redacts its output
// tail and the server never puts the captured token in any response).
export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    const status = await loginStatus(params.id);
    if (!status) return NextResponse.json({ error: "unknown login id" }, { status: 404 });
    return NextResponse.json(status);
  } catch (error) {
    return jsonError(error, 400);
  }
}

// { action: "code", code: "…" } relays the OAuth code paste into the PTY;
// { action: "cancel" } kills the attempt.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const action = String(body.action ?? "");
    if (action === "code") {
      await sendLoginInput(params.id, String(body.code ?? ""));
      return NextResponse.json({ ok: true });
    }
    if (action === "cancel") {
      await cancelLogin(params.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
