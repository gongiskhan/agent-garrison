import { NextResponse, type NextRequest } from "next/server";
import { listAccounts, accountTokenForSpawn } from "@/lib/accounts";
import { fetchAccountBalance, type AccountBalance } from "@/lib/account-balance";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RUNTIME-ACCOUNTS-V4: credits/spend for API-KEY accounts. Subscription accounts
// are excluded on purpose - their "how much is left" is rate-limit utilization,
// which the Paymaster already owns.
//
// Balances are fetched on demand (?refresh=1) or served from a short-lived
// in-process cache, because each one is a live provider round trip and the
// Accounts page polls every minute.
interface CacheEntry {
  balance: AccountBalance;
  at: number;
}

/**
 * The cache key must identify the CREDENTIAL, not just the account name.
 * Keying on the name alone let a new account inherit a previous one's balance:
 * re-using a name on a different platform showed the old provider's dollars
 * against the new key (observed live 2026-07-25). `created_at` is restamped on
 * every add/replace, so folding it in also expires the entry the moment a token
 * is swapped - a replaced key can never report its predecessor's balance.
 */
function cacheKeyFor(account: { name: string; platform: string; created_at: string }): string {
  return `${account.platform}:${account.name}:${account.created_at}`;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonBalances: Map<string, CacheEntry> | undefined;
}

const CACHE_TTL_MS = 5 * 60_000;

function cache(): Map<string, CacheEntry> {
  globalThis.__agentGarrisonBalances ??= new Map();
  return globalThis.__agentGarrisonBalances;
}

export async function GET(request: NextRequest) {
  try {
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const only = request.nextUrl.searchParams.get("account")?.trim() || null;
    const accounts = (await listAccounts()).filter(
      (account) =>
        account.credential_kind === "token" &&
        account.status === "ready" &&
        account.platform !== "custom" &&
        (!only || account.name === only)
    );
    const now = Date.now();
    const balances: Record<string, AccountBalance> = {};
    await Promise.all(
      accounts.map(async (account) => {
        const key = cacheKeyFor(account);
        const hit = cache().get(key);
        if (!refresh && hit && now - hit.at < CACHE_TTL_MS) {
          balances[account.name] = hit.balance;
          return;
        }
        try {
          const token = await accountTokenForSpawn(account.name, "accounts-balance", account.platform);
          const balance = await fetchAccountBalance(account.platform, token);
          cache().set(key, { balance, at: now });
          balances[account.name] = balance;
        } catch {
          // A locked vault or an absent token is already visible as the row's
          // status chip - don't duplicate it as a balance error.
        }
      })
    );
    return NextResponse.json({ balances });
  } catch (error) {
    return jsonError(error, 400);
  }
}
