import { NextResponse, type NextRequest } from "next/server";
import { listAccounts, readPaymasterSettings } from "@/lib/accounts";
import {
  candidatesFrom,
  ensurePaymasterHeartbeat,
  readUsageCache,
  refreshUsage,
  resolvePaymaster
} from "@/lib/paymaster";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PAYMASTER D11: everything the panel needs in one read - accounts with
// policy, cached usage (numbers only, never tokens), and which account auto
// would pick right now. ?refresh=1 forces live probes (the "Probe now"
// button); a plain GET serves the cache and lets the background heartbeat
// (started here, lazily) keep it live.
export async function GET(request: NextRequest) {
  try {
    void ensurePaymasterHeartbeat().catch(() => undefined);
    let accounts = await listAccounts();
    const settings = await readPaymasterSettings();
    const force = request.nextUrl.searchParams.get("refresh") === "1";
    const usage = force
      ? await refreshUsage({ ttlMs: 0, force: true, accounts })
      : await readUsageCache();
    // A live refresh can flip needs_relogin either way - re-list so the panel
    // and the eligibility verdicts reflect the current flags.
    if (force) accounts = await listAccounts();
    const decision = resolvePaymaster(candidatesFrom(accounts, usage));
    return NextResponse.json({ accounts, decision, settings });
  } catch (error) {
    return jsonError(error, 400);
  }
}
