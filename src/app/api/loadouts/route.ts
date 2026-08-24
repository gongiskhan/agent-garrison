import { NextResponse, type NextRequest } from "next/server";
import {
  listLoadouts,
  normaliseLoadout,
  validateLoadout,
  vaultPrefixFor,
  writeLoadout
} from "@/lib/loadout";
import { readVaultSecrets } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Loadout authoring surface (brief D2/D3).
//
//   GET  /api/loadouts            -> { loadouts, coverage }
//   POST /api/loadouts { ... }    -> { loadout } (create or replace, by id)
//
// Until this existed, `writeLoadout` had no caller outside its own test and
// ~/.garrison/loadouts/ was never created — so the claim route always resolved
// a null loadout and NO dispatched card ever got a materialized checkout. The
// library was complete; nothing could reach it.
//
// `coverage` answers the only question that matters before dispatching: for each
// declared env var name, does the vault actually hold a value for it (either the
// PROJECT__VAR override or the bare name)? A missing one is not an error here —
// you author the Loadout first and fill the vault after — but it WILL fail
// materialization on the claiming node, so it is surfaced up front rather than
// discovered on a remote machine.
//
// NAMES ONLY, both ways. This endpoint never accepts or returns a secret VALUE;
// `coverage` reports presence and which vault key supplied it.
// Coverage is a CONVENIENCE, never a precondition. readVaultSecrets throws
// "Vault is locked" when the vault is sealed, and letting that escape would mean
// you cannot author a Loadout without unlocking — exactly backwards, since the
// normal order is "declare the names, then go fill the vault". A locked vault
// yields `present: null` (unknown) rather than a failed request or, worse, a
// confident `false` that reads as "you are missing this value".
async function coverageFor(envVars: string[], projectId: string) {
  let keys: Set<string> | null = null;
  try {
    keys = new Set((await readVaultSecrets()).map((s) => s.key));
  } catch {
    keys = null;
  }
  const prefix = vaultPrefixFor(projectId);
  return envVars.map((name) => {
    if (!keys) return { name, present: null, source: null };
    const prefixed = `${prefix}${name}`;
    if (keys.has(prefixed)) return { name, present: true, source: prefixed };
    if (keys.has(name)) return { name, present: true, source: name };
    return { name, present: false, source: null };
  });
}

export async function GET() {
  try {
    const loadouts = await listLoadouts();
    const coverage: Record<string, Awaited<ReturnType<typeof coverageFor>>> = {};
    for (const l of loadouts) coverage[l.id] = await coverageFor(l.env_vars, l.id);
    return NextResponse.json({ loadouts, coverage });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Validate BEFORE normalising: normaliseLoadout coerces with String(), so a
  // malformed field would become the literal "undefined" rather than an error.
  const errors = validateLoadout(body);
  if (errors.length) {
    return NextResponse.json({ error: "invalid loadout", errors }, { status: 400 });
  }

  try {
    const loadout = normaliseLoadout(body as Record<string, unknown>);
    await writeLoadout(loadout);
    return NextResponse.json({
      loadout,
      coverage: await coverageFor(loadout.env_vars, loadout.id)
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
