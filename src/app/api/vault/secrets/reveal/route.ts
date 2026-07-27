import { NextResponse, type NextRequest } from "next/server";
import { revealVaultSecret } from "@/lib/vault";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reveal ONE secret by name. POST, never GET: a GET would land in browser
// history, proxy logs and prefetchers, which is most of what masking the list
// was meant to stop. Every call is recorded in the vault audit log.
//
// Honest scope: this is blast-radius reduction, not authentication. Garrison
// ships with no auth layer (its positioning is single-user, localhost-only), so
// a caller that can reach the API can still reveal keys one at a time. What it
// removes is bulk and accidental exposure — the whole vault no longer rides an
// ordinary page load. Real access control is an app-level decision.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { key?: unknown };
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return jsonError(new Error("key is required"), 400);

    const value = await revealVaultSecret(key);
    if (value === null) return jsonError(new Error(`no such secret: ${key}`), 404);
    return NextResponse.json({ key, value });
  } catch (error) {
    return jsonError(error, 400);
  }
}
