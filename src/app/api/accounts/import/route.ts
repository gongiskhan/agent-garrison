import { NextResponse, type NextRequest } from "next/server";
import { importNativeLogin } from "@/lib/account-login";
import { isValidAccountName, normalizePlatform, PLATFORM_SPECS } from "@/lib/account-env";
import { readMachineLogins } from "@/lib/machine-login";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RUNTIME-ACCOUNTS-V3: adopt the box's OWN native CLI login as a named, vaulted
// account. The path that always works - no browser, no device code - for the
// platforms whose credential is a file (Codex, Gemini).
//
// GET reports what is importable so the UI can offer it honestly.
export async function GET() {
  try {
    const logins = await readMachineLogins();
    const importable = logins
      .filter((login) => PLATFORM_SPECS[login.platform].authFile)
      .map((login) => ({
        platform: login.platform,
        available: login.loggedIn,
        configPath: login.configPath,
        label: PLATFORM_SPECS[login.platform].authFile!.label,
        loginHint: PLATFORM_SPECS[login.platform].authFile!.loginHint
      }));
    return NextResponse.json({ importable });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = String(body.name ?? "").trim().toLowerCase();
    if (!isValidAccountName(name)) {
      return NextResponse.json(
        { error: "invalid account name — use 1-32 lowercase letters/digits/dashes/underscores" },
        { status: 400 }
      );
    }
    const platform = normalizePlatform(body.platform);
    const result = await importNativeLogin({
      name,
      platform,
      label: body.label ? String(body.label) : undefined
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, 400);
  }
}
