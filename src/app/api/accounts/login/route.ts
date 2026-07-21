import { NextResponse, type NextRequest } from "next/server";
import { startLogin } from "@/lib/account-login";
import { readLibrary } from "@/lib/library";
import { isValidAccountName } from "@/lib/account-env";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RUNTIME-ACCOUNTS-V1 D2/D6: start a login attempt.
// - Anthropic (default): a `claude setup-token` PTY; the token is captured
//   into the vault under the given account name.
// - Generic (D6): { fittingId } — the login command comes from the fitting's
//   x-garrison.login block, resolved SERVER-SIDE. The client never supplies a
//   command line (the API is unauthenticated-by-design on the tailnet; an
//   arbitrary-command endpoint would be a remote shell).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const fittingId = body.fittingId ? String(body.fittingId) : null;

    if (fittingId) {
      const library = await readLibrary();
      const entry = library.find((candidate) => candidate.id === fittingId);
      const login = entry?.metadata.login;
      if (!login?.command) {
        return NextResponse.json(
          { error: `fitting ${fittingId} declares no x-garrison.login block` },
          { status: 400 }
        );
      }
      const { id } = await startLogin({
        accountName: fittingId,
        mode: "generic",
        command: login.command
      });
      return NextResponse.json({ id, mode: "generic" });
    }

    const name = String(body.name ?? "").trim().toLowerCase();
    if (!isValidAccountName(name)) {
      return NextResponse.json(
        { error: "invalid account name — use 1-32 lowercase letters/digits/dashes/underscores" },
        { status: 400 }
      );
    }
    const { id } = await startLogin({
      accountName: name,
      label: body.label ? String(body.label) : undefined,
      mode: "setup-token"
    });
    return NextResponse.json({ id, mode: "setup-token" });
  } catch (error) {
    return jsonError(error, 400);
  }
}
