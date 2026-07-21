import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseUnifiedHeaders,
  probeAccountUsage,
  refreshUsage,
  readUsageCache,
  resolvePaymaster,
  resolveAutoAccount,
  formatDecisionLines,
  PaymasterHoldError,
  PaymasterProbeAuthError,
  type AccountUsage,
  type ResolveCandidate
} from "@/lib/paymaster";
import { addAccount, listAccounts, setAccountPolicy } from "@/lib/accounts";
import { unlockVault } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

// PAYMASTER (RUNTIME-ACCOUNTS-V1): header probes + deterministic D7 selection.
// Header fixture mirrors the live FINDING-A4 capture (2026-07-21): utilization
// is a 0-1 fraction, resets are unix seconds, the weekly window is "7d".

const LIVE_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-5h-reset": "1784659200",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.46",
  "anthropic-ratelimit-unified-7d-reset": "1785232800",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.17",
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-reset": "1784659200"
};

const headerGet = (headers: Record<string, string>) => (name: string) =>
  headers[name.toLowerCase()] ?? null;

function fakeResponse(status: number, headers: Record<string, string>): Response {
  return { status, headers: { get: headerGet(headers) } } as unknown as Response;
}

function usageOf(fiveHourPct: number, weeklyPct: number, extra?: Partial<AccountUsage>): AccountUsage {
  return {
    fiveHour: { pct: fiveHourPct, resetAt: "2026-07-21T16:00:00.000Z", status: "allowed" },
    weekly: { pct: weeklyPct, resetAt: "2026-07-27T10:00:00.000Z", status: "allowed" },
    status: "allowed",
    probedAt: "2026-07-21T15:00:00.000Z",
    ...extra
  };
}

function candidate(
  name: string,
  fiveHourPct: number,
  weeklyPct: number,
  overrides?: Partial<ResolveCandidate>
): ResolveCandidate {
  return {
    name,
    enabled: true,
    ceiling: 100,
    tokenReady: true,
    needsRelogin: false,
    usage: usageOf(fiveHourPct, weeklyPct),
    ...overrides
  };
}

describe("parseUnifiedHeaders (FINDING-A4 shape)", () => {
  it("parses both windows: fraction → percent, unix seconds → ISO", () => {
    const usage = parseUnifiedHeaders(headerGet(LIVE_HEADERS), () => new Date("2026-07-21T15:00:00Z"));
    expect(usage).not.toBeNull();
    expect(usage?.fiveHour.pct).toBe(46);
    expect(usage?.weekly.pct).toBe(17);
    expect(usage?.fiveHour.resetAt).toBe(new Date(1784659200 * 1000).toISOString());
    expect(usage?.weekly.resetAt).toBe(new Date(1785232800 * 1000).toISOString());
    expect(usage?.status).toBe("allowed");
    expect(usage?.probedAt).toBe("2026-07-21T15:00:00.000Z");
  });

  it("returns null when either window's utilization header is missing", () => {
    const { "anthropic-ratelimit-unified-7d-utilization": _dropped, ...noWeekly } = LIVE_HEADERS;
    expect(parseUnifiedHeaders(headerGet(noWeekly))).toBeNull();
    expect(parseUnifiedHeaders(() => null)).toBeNull();
  });
});

describe("probeAccountUsage", () => {
  it("parses a 200 and a 429 alike (a scorched window is a valid probe)", async () => {
    for (const status of [200, 429]) {
      const fetchImpl = vi.fn(async () => fakeResponse(status, LIVE_HEADERS));
      const usage = await probeAccountUsage("work1", "sk-ant-oat01-x", fetchImpl as unknown as typeof fetch);
      expect(usage.fiveHour.pct).toBe(46);
    }
  });

  it("throws PaymasterProbeAuthError on 401/403 (flags re-login upstream)", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(401, {}));
    await expect(
      probeAccountUsage("work1", "sk-ant-oat01-x", fetchImpl as unknown as typeof fetch)
    ).rejects.toBeInstanceOf(PaymasterProbeAuthError);
  });

  it("throws on a response without unified headers", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, {}));
    await expect(
      probeAccountUsage("work1", "sk-ant-oat01-x", fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/without unified ratelimit headers/);
  });
});

describe("resolvePaymaster (D7 deterministic selection)", () => {
  it("picks the lowest effective utilization = max(5h, weekly)", () => {
    const decision = resolvePaymaster([
      candidate("hot", 80, 10),
      candidate("cool", 20, 15),
      candidate("mid", 40, 30)
    ]);
    expect(decision.pick).toBe("cool");
    expect(decision.candidates.every((judged) => judged.eligible)).toBe(true);
  });

  it("a cool 5h window on a scorched weekly still scores high (weekly drives effective)", () => {
    const decision = resolvePaymaster([
      candidate("scorched-weekly", 5, 90),
      candidate("steady", 50, 40)
    ]);
    expect(decision.pick).toBe("steady");
  });

  it("ceiling applies to BOTH windows; at-or-over blocks", () => {
    const decision = resolvePaymaster([
      candidate("blocked-5h", 80, 10, { ceiling: 80 }),
      candidate("blocked-weekly", 10, 55, { ceiling: 50 }),
      candidate("ok", 60, 40, { ceiling: 80 })
    ]);
    expect(decision.pick).toBe("ok");
    expect(decision.candidates.find((judged) => judged.name === "blocked-5h")?.reason).toMatch(/over ceiling/);
    expect(decision.candidates.find((judged) => judged.name === "blocked-weekly")?.reason).toMatch(/over ceiling/);
  });

  it("tie on effective breaks on lower weekly, then name", () => {
    const byWeekly = resolvePaymaster([
      candidate("higher-weekly", 50, 50),
      candidate("lower-weekly", 50, 20)
    ]);
    expect(byWeekly.pick).toBe("lower-weekly");
    const byName = resolvePaymaster([candidate("bravo", 50, 50), candidate("alpha", 50, 50)]);
    expect(byName.pick).toBe("alpha");
  });

  it("disabled / token-missing / usage-missing accounts are skipped with reasons", () => {
    const decision = resolvePaymaster([
      candidate("off", 1, 1, { enabled: false }),
      candidate("no-token", 1, 1, { tokenReady: false }),
      candidate("no-usage", 0, 0, { usage: null }),
      candidate("works", 70, 60)
    ]);
    expect(decision.pick).toBe("works");
    expect(decision.candidates.find((judged) => judged.name === "off")?.reason).toBe("disabled");
    expect(decision.candidates.find((judged) => judged.name === "no-token")?.reason).toMatch(/no token/);
    expect(decision.candidates.find((judged) => judged.name === "no-usage")?.reason).toMatch(/no usage/);
  });

  it("an auth-dead account (needs_relogin) is ineligible even with frozen low numbers", () => {
    // A revoked token 401s on every probe, so its cached numbers freeze at the
    // last good (low) values - without the flag it would win deterministically.
    const decision = resolvePaymaster([
      candidate("dead", 10, 5, { needsRelogin: true }),
      candidate("live", 60, 40)
    ]);
    expect(decision.pick).toBe("live");
    expect(decision.candidates.find((judged) => judged.name === "dead")?.reason).toMatch(/re-login/);
  });

  it("nothing eligible → pick null + nearest reset among ceiling-blocked windows (D9)", () => {
    const decision = resolvePaymaster([
      {
        ...candidate("a", 90, 10, { ceiling: 80 }),
        usage: {
          ...usageOf(90, 10),
          fiveHour: { pct: 90, resetAt: "2026-07-21T18:00:00.000Z", status: "allowed" }
        }
      },
      {
        ...candidate("b", 10, 95, { ceiling: 80 }),
        usage: {
          ...usageOf(10, 95),
          weekly: { pct: 95, resetAt: "2026-07-21T17:00:00.000Z", status: "allowed" }
        }
      }
    ]);
    expect(decision.pick).toBeNull();
    expect(decision.nearestResetAt).toBe("2026-07-21T17:00:00.000Z");
    const lines = formatDecisionLines(decision);
    expect(lines.join("\n")).toMatch(/skipped: over ceiling/);
  });
});

describe("refreshUsage + resolveAutoAccount (sandboxed home + vault)", () => {
  let dir: string;
  const TOKEN_A = "sk-ant-oat01-test-token-account-a-0123456789";
  const TOKEN_B = "sk-ant-oat01-test-token-account-b-9876543210";

  function resetRuntimes(): void {
    (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
    (globalThis as unknown as { __agentGarrisonPaymaster?: unknown }).__agentGarrisonPaymaster =
      undefined;
    resetMasterKeyCache();
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "garrison-paymaster-"));
    process.env.GARRISON_HOME = dir;
    process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
    resetRuntimes();
    await unlockVault();
    await addAccount({ name: "alpha", token: TOKEN_A });
    await addAccount({ name: "bravo", token: TOKEN_B });
  });

  afterEach(() => {
    delete process.env.GARRISON_HOME;
    delete process.env.GARRISON_VAULT_PATH;
    resetRuntimes();
    rmSync(dir, { recursive: true, force: true });
  });

  function fetchWithUtilization(perToken: Record<string, { fiveHour: string; weekly: string }>) {
    return vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const bearer = init?.headers?.authorization ?? "";
      const token = Object.keys(perToken).find((key) => bearer.includes(key));
      if (!token) return fakeResponse(401, {});
      return fakeResponse(200, {
        ...LIVE_HEADERS,
        "anthropic-ratelimit-unified-5h-utilization": perToken[token].fiveHour,
        "anthropic-ratelimit-unified-7d-utilization": perToken[token].weekly
      });
    });
  }

  it("probes stale accounts, persists the cache, and honors the TTL", async () => {
    const fetchImpl = fetchWithUtilization({
      [TOKEN_A]: { fiveHour: "0.30", weekly: "0.20" },
      [TOKEN_B]: { fiveHour: "0.10", weekly: "0.05" }
    });
    const cache = await refreshUsage({ ttlMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(cache.alpha?.fiveHour.pct).toBe(30);
    expect(cache.bravo?.weekly.pct).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Within the TTL nothing re-probes.
    await refreshUsage({ ttlMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The cache file survives a fresh read.
    expect((await readUsageCache()).alpha?.fiveHour.pct).toBe(30);
  });

  it("a failed probe keeps the last numbers with a staleness marker (D8)", async () => {
    const good = fetchWithUtilization({
      [TOKEN_A]: { fiveHour: "0.30", weekly: "0.20" },
      [TOKEN_B]: { fiveHour: "0.10", weekly: "0.05" }
    });
    await refreshUsage({ ttlMs: 0, force: true, fetchImpl: good as unknown as typeof fetch });
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const cache = await refreshUsage({ ttlMs: 0, force: true, fetchImpl: failing as unknown as typeof fetch });
    expect(cache.alpha?.fiveHour.pct).toBe(30); // stale numbers survive
    expect(cache.alpha?.error).toMatch(/network down/);
  });

  it("a 401 probe flags the account needs-relogin (D5); a later good probe clears it", async () => {
    const rejecting = vi.fn(async () => fakeResponse(401, {}));
    await refreshUsage({ ttlMs: 0, force: true, fetchImpl: rejecting as unknown as typeof fetch });
    expect((await listAccounts()).find((account) => account.name === "alpha")?.needs_relogin).toBe(
      true
    );
    const good = fetchWithUtilization({
      [TOKEN_A]: { fiveHour: "0.30", weekly: "0.20" },
      [TOKEN_B]: { fiveHour: "0.10", weekly: "0.05" }
    });
    await refreshUsage({ ttlMs: 0, force: true, fetchImpl: good as unknown as typeof fetch });
    expect(
      (await listAccounts()).find((account) => account.name === "alpha")?.needs_relogin
    ).toBeUndefined();
  });

  it("auto skips an auth-dead account whose frozen numbers would otherwise win", async () => {
    // alpha probes fine at LOW numbers first, then its token dies (401s):
    // rotation must move to bravo instead of deterministically picking the
    // frozen-low dead account.
    const initial = fetchWithUtilization({
      [TOKEN_A]: { fiveHour: "0.10", weekly: "0.05" },
      [TOKEN_B]: { fiveHour: "0.50", weekly: "0.40" }
    });
    await refreshUsage({ ttlMs: 0, force: true, fetchImpl: initial as unknown as typeof fetch });
    const alphaDead = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const bearer = init?.headers?.authorization ?? "";
      if (bearer.includes(TOKEN_A)) return fakeResponse(401, {});
      return fakeResponse(200, {
        ...LIVE_HEADERS,
        "anthropic-ratelimit-unified-5h-utilization": "0.50",
        "anthropic-ratelimit-unified-7d-utilization": "0.40"
      });
    });
    // Past the freshness TTL the resolver re-probes; alpha's 401 flags it
    // needs-relogin and eligibility must see the flag in the same resolution.
    const pastTtl = () => new Date(Date.now() + 4 * 60_000);
    const resolution = await resolveAutoAccount({
      fetchImpl: alphaDead as unknown as typeof fetch,
      now: pastTtl
    });
    expect(resolution.mode).toBe("account");
    if (resolution.mode === "account") expect(resolution.name).toBe("bravo");
    expect(
      (await listAccounts()).find((account) => account.name === "alpha")?.needs_relogin
    ).toBe(true);
  });

  it("rejects a token-shaped label (plaintext registry defense)", async () => {
    await expect(
      addAccount({ name: "oops", token: TOKEN_A, label: TOKEN_B })
    ).rejects.toThrow(/label looks like a token/);
    await expect(setAccountPolicy("alpha", { label: TOKEN_A })).rejects.toThrow(
      /label looks like a token/
    );
  });

  it("resolveAutoAccount picks per D7 from live-probed numbers and logs candidates", async () => {
    const fetchImpl = fetchWithUtilization({
      [TOKEN_A]: { fiveHour: "0.60", weekly: "0.40" },
      [TOKEN_B]: { fiveHour: "0.20", weekly: "0.10" }
    });
    const resolution = await resolveAutoAccount({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(resolution.mode).toBe("account");
    if (resolution.mode === "account") {
      expect(resolution.name).toBe("bravo");
      expect(resolution.decision.candidates).toHaveLength(2);
    }
  });

  it("HOLDS (D9) when every account is over its ceiling; a pin still works", async () => {
    await setAccountPolicy("alpha", { ceiling: 1 });
    await setAccountPolicy("bravo", { ceiling: 1 });
    const fetchImpl = fetchWithUtilization({
      [TOKEN_A]: { fiveHour: "0.60", weekly: "0.40" },
      [TOKEN_B]: { fiveHour: "0.20", weekly: "0.10" }
    });
    await expect(
      resolveAutoAccount({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toBeInstanceOf(PaymasterHoldError);
    try {
      await resolveAutoAccount({ fetchImpl: fetchImpl as unknown as typeof fetch });
    } catch (error) {
      const hold = error as PaymasterHoldError;
      expect(hold.message).toMatch(/Paymaster HOLD/);
      expect(hold.message).toMatch(/alpha/);
      expect(hold.message).toMatch(/bravo/);
      expect(hold.message).toMatch(/Pin an account to override/);
      expect(hold.decision.nearestResetAt).not.toBeNull();
    }
  });

  it("policy fields round-trip and survive a token re-add (re-login)", async () => {
    await setAccountPolicy("alpha", { enabled: false, ceiling: 50 });
    let alpha = (await listAccounts()).find((account) => account.name === "alpha");
    expect(alpha).toMatchObject({ enabled: false, ceiling: 50 });
    await addAccount({ name: "alpha", token: TOKEN_A }); // re-login replaces the token
    alpha = (await listAccounts()).find((account) => account.name === "alpha");
    expect(alpha).toMatchObject({ enabled: false, ceiling: 50 });
    await setAccountPolicy("alpha", { enabled: true, ceiling: 100 });
    alpha = (await listAccounts()).find((account) => account.name === "alpha");
    expect(alpha).toMatchObject({ enabled: true, ceiling: 100 });
  });
});
