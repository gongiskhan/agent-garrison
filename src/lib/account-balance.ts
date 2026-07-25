// account-balance.ts — RUNTIME-ACCOUNTS-V4: "how much is left on this key?"
//
// Only some providers answer that question, and it is worth being precise about
// WHY rather than showing a blank number:
//
//   openrouter  — yes. /api/v1/credits returns purchased credits and usage, so a
//                 real remaining balance (and a ratio) is knowable.
//   huggingface — partly. There is no credit-balance endpoint; whoami-v2 returns
//                 the identity and plan behind the token, which is the useful
//                 half (WHOSE quota is being spent).
//   anthropic   — no, not for a standard API key. Spend lives behind the Admin
//                 API (an sk-ant-admin- key). We try, and say what came back.
//   openai      — same shape: /v1/organization/costs needs an admin key.
//   google      — no endpoint at all; Gemini API billing is a GCP concern.
//
// Plan/subscription accounts are NOT handled here: their "balance" is rate-limit
// utilization, which the Paymaster already probes and renders as usage bars.
//
// The token travels only to its own provider, and never appears in the result.

import type { AccountPlatform } from "./account-env";

export interface AccountBalance {
  /** The headline, e.g. "$12.34 left of $20.00" or "signed in as ggomes (pro)". */
  label: string;
  /** Consumed percentage 0-100 when a ratio is knowable; null otherwise. */
  usedPct: number | null;
  /** Secondary line: what the number means, or why there isn't one. */
  detail: string;
  /** available = a real answer · identity = who, not how much · unavailable. */
  kind: "available" | "identity" | "unavailable";
  fetchedAt: string;
}

const TIMEOUT_MS = 12_000;

/** Providers whose keys can be asked anything useful at all. */
export function balanceSupported(platform: AccountPlatform): boolean {
  return platform === "openrouter" || platform === "huggingface";
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Read what the provider will tell us about an API key. Never throws: an
 * unreachable provider is reported as unavailable, not as a broken account.
 */
export async function fetchAccountBalance(
  platform: AccountPlatform,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<AccountBalance> {
  const fetchedAt = new Date().toISOString();
  const unavailable = (detail: string): AccountBalance => ({
    label: "no balance available",
    usedPct: null,
    detail,
    kind: "unavailable",
    fetchedAt
  });

  try {
    if (platform === "openrouter") {
      const { status, body } = await getJson(
        "https://openrouter.ai/api/v1/credits",
        { authorization: `Bearer ${token}` },
        fetchImpl
      );
      if (status === 401 || status === 403) return unavailable("OpenRouter refused this key.");
      const data = (body?.data ?? {}) as Record<string, unknown>;
      const granted = num(data.total_credits);
      const used = num(data.total_usage);
      if (granted !== null && used !== null) {
        const remaining = granted - used;
        return {
          label: `${money(remaining)} left of ${money(granted)}`,
          usedPct: granted > 0 ? Math.min(100, Math.max(0, (used / granted) * 100)) : null,
          detail: `${money(used)} spent on this key`,
          kind: "available",
          fetchedAt
        };
      }
      // Older keys answer on the auth/key endpoint with a spend limit instead.
      const key = await getJson(
        "https://openrouter.ai/api/v1/auth/key",
        { authorization: `Bearer ${token}` },
        fetchImpl
      );
      const info = (key.body?.data ?? {}) as Record<string, unknown>;
      const usage = num(info.usage);
      const limit = num(info.limit);
      if (usage !== null && limit !== null && limit > 0) {
        return {
          label: `${money(limit - usage)} left of ${money(limit)}`,
          usedPct: Math.min(100, Math.max(0, (usage / limit) * 100)),
          detail: "key spend limit",
          kind: "available",
          fetchedAt
        };
      }
      if (usage !== null) {
        return {
          label: `${money(usage)} spent`,
          usedPct: null,
          detail: info.is_free_tier ? "free tier - no purchased credits" : "no spend limit set on this key",
          kind: "available",
          fetchedAt
        };
      }
      return unavailable(`OpenRouter answered ${status} without credit fields.`);
    }

    if (platform === "huggingface") {
      const { status, body } = await getJson(
        "https://huggingface.co/api/whoami-v2",
        { authorization: `Bearer ${token}` },
        fetchImpl
      );
      if (status === 401 || status === 403) return unavailable("Hugging Face refused this token.");
      const name = typeof body?.name === "string" ? body.name : null;
      if (!name) return unavailable(`Hugging Face answered ${status} without an identity.`);
      const plan =
        typeof body?.plan === "string"
          ? body.plan
          : typeof (body?.periodEnd ?? null) === "string"
            ? "pro"
            : null;
      const role = ((body?.auth as Record<string, unknown> | undefined)?.accessToken as
        | Record<string, unknown>
        | undefined)?.role;
      return {
        label: `signed in as ${name}${plan ? ` (${plan})` : ""}`,
        usedPct: null,
        detail:
          `Hugging Face exposes no credit balance for tokens${typeof role === "string" ? ` · token role: ${role}` : ""}` +
          " - inference spend is on the account's own billing page.",
        kind: "identity",
        fetchedAt
      };
    }

    if (platform === "anthropic") {
      // Only an Admin API key can read spend. A normal key 401s here, which is
      // the answer, not an error.
      const { status } = await getJson(
        "https://api.anthropic.com/v1/organizations/cost_report",
        { "x-api-key": token, "anthropic-version": "2023-06-01" },
        fetchImpl
      );
      return unavailable(
        status === 401 || status === 403
          ? "Anthropic exposes spend only to Admin API keys (sk-ant-admin-…), not to this key."
          : `Anthropic's cost report answered ${status}.`
      );
    }

    if (platform === "openai") {
      const { status } = await getJson(
        "https://api.openai.com/v1/organization/costs?start_time=0&limit=1",
        { authorization: `Bearer ${token}` },
        fetchImpl
      );
      return unavailable(
        status === 401 || status === 403
          ? "OpenAI exposes spend only to Admin keys (sk-admin-…), not to this key."
          : `OpenAI's costs endpoint answered ${status}.`
      );
    }

    if (platform === "google") {
      return unavailable("Google exposes no balance for Gemini API keys - billing lives in GCP.");
    }

    return unavailable("Garrison has no balance probe for a custom platform.");
  } catch (error) {
    return unavailable(
      `could not reach the provider (${error instanceof Error ? error.message : String(error)}).`
    );
  }
}
