// The ChatGPT-subscription provider for openai-agents: credential resolution +
// refresh, the outbound body/header contract the Codex backend demands, and the
// account plumbing that lets a subscription account be pinned to this runtime.
//
// Every constant asserted here was verified against the live backend on
// 2026-08-23 (models catalog 200, /responses reaching a real
// usage_limit_reached), so these tests pin a contract that was observed, not one
// that was assumed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore - pure .mjs runtime layer
import {
  OPENAI_PROVIDERS,
  resolveEndpoint,
  wireApiFor,
  authModeFor,
  capabilityRecord,
  CHATGPT_BASE_URL
  // @ts-ignore
} from "../fittings/seed/openai-agents-runtime/lib/providers.mjs";
// @ts-ignore
import {
  authFilePath,
  accountIdOf,
  resolveChatGptCredential,
  resetChatGptAuthCache,
  ChatGptAuthError
  // @ts-ignore
} from "../fittings/seed/openai-agents-runtime/lib/chatgpt-auth.mjs";
// @ts-ignore
import {
  createChatGptFetch,
  normalizeResponsesBody,
  ChatGptUsageLimitError,
  CHATGPT_ORIGINATOR
  // @ts-ignore
} from "../fittings/seed/openai-agents-runtime/lib/chatgpt-transport.mjs";
import { primaryAccountRoute } from "@/lib/runner";
import { runtimeAccountContract } from "@/components/accounts/shared";

/** Build a JWT whose payload carries exp (seconds) and optional auth claims. */
function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.sig`;
}

const HOUR = 3600;

function authFileBody(opts: { expSecondsFromNow: number; accountId?: string; claimId?: string }) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt(
        opts.claimId ? { "https://api.openai.com/auth": { chatgpt_account_id: opts.claimId } } : {}
      ),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + opts.expSecondsFromNow }),
      refresh_token: "refresh-original",
      ...(opts.accountId ? { account_id: opts.accountId } : {})
    },
    last_refresh: "2026-08-16T12:34:36.311752580Z"
  };
}

describe("chatgpt-subscription provider", () => {
  it("is the Codex backend, keyless, on the responses wire API", () => {
    const spec = OPENAI_PROVIDERS["chatgpt-subscription"];
    expect(spec.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(CHATGPT_BASE_URL).toBe(spec.baseUrl);
    expect(spec.needsKey).toBe(false);
    expect(wireApiFor({ provider: "chatgpt-subscription" })).toBe("responses");
    expect(authModeFor({ provider: "chatgpt-subscription" })).toBe("subscription");
  });

  it("resolves an endpoint with no vault key at all", () => {
    // A vault key that is never sent must never be REQUIRED either: a locked
    // vault has to leave this provider fully usable.
    const ep = resolveEndpoint({ provider: "chatgpt-subscription" }, { secrets: null });
    expect(ep.baseUrl).toBe(CHATGPT_BASE_URL);
    expect(ep.apiKeyEnv).toBeNull();
    expect(ep.apiKey).toBeTruthy(); // the OpenAI constructor rejects an empty key
  });

  it("reports vision and reasoning effort, matching the live gpt-5.6 catalog", () => {
    const rec = capabilityRecord({ provider: "chatgpt-subscription" });
    expect(rec.text).toBe(true);
    expect(rec.toolUse).toBe(true);
    expect(rec.image).toBe(true); // catalog: input_modalities text+image
    expect(rec.effort).toBe("supported"); // catalog: low..max reasoning levels
    // Not wired by this runtime, so they stay false however capable the backend is.
    expect(rec.webSearch).toBe(false);
    expect(rec.mcp).toBe(false);
  });
});

describe("chatgpt credential resolution", () => {
  let dir: string;

  beforeEach(async () => {
    resetChatGptAuthCache();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-chatgpt-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("reads the auth file out of the account home CODEX_HOME names", () => {
    // This is the whole reason pinning an account works for this runtime: the
    // account layer already sets CODEX_HOME per account, so the resolver simply
    // obeys it instead of inventing a second selection mechanism.
    expect(authFilePath({ CODEX_HOME: "/homes/acct-a" })).toBe("/homes/acct-a/auth.json");
    expect(authFilePath({ HOME: "/home/u" })).toBe("/home/u/.codex/auth.json");
    expect(authFilePath({ GARRISON_CHATGPT_AUTH_FILE: "/x/y.json", CODEX_HOME: "/ignored" })).toBe("/x/y.json");
  });

  it("prefers the explicit account id and falls back to the id_token claim", () => {
    expect(accountIdOf({ account_id: "acct-explicit", id_token: jwt({}) })).toBe("acct-explicit");
    expect(
      accountIdOf({ id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-claim" } }) })
    ).toBe("acct-claim");
    expect(accountIdOf({})).toBe("");
  });

  it("uses a still-valid token without refreshing", async () => {
    const file = path.join(dir, "auth.json");
    await fsp.writeFile(file, JSON.stringify(authFileBody({ expSecondsFromNow: 2 * HOUR, accountId: "acct-1" })));
    const cred = await resolveChatGptCredential({ file });
    expect(cred.refreshed).toBe(false);
    expect(cred.accountId).toBe("acct-1");
  });

  it("refreshes an expiring token and persists the ROTATED refresh token", async () => {
    // The rotation is the dangerous part: dropping the new refresh token on the
    // floor logs the account out on the next process start.
    const file = path.join(dir, "auth.json");
    await fsp.writeFile(file, JSON.stringify(authFileBody({ expSecondsFromNow: 60, accountId: "acct-1" })));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 8 * HOUR }),
          refresh_token: "refresh-rotated"
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const cred = await resolveChatGptCredential({ file });
      expect(cred.refreshed).toBe(true);
      const onDisk = JSON.parse(await fsp.readFile(file, "utf8"));
      expect(onDisk.tokens.refresh_token).toBe("refresh-rotated");
      // Fields this module does not model must survive the round trip.
      expect(onDisk.auth_mode).toBe("chatgpt");
      expect(onDisk.tokens.account_id).toBe("acct-1");
      expect(await fsp.readFile(file, "utf8")).toContain("last_refresh");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("collapses concurrent refreshes into ONE token exchange", async () => {
    // A rotating refresh token is single-use: two exchanges means one of them
    // persists a token the server already replaced.
    const file = path.join(dir, "auth.json");
    await fsp.writeFile(file, JSON.stringify(authFileBody({ expSecondsFromNow: 10 })));
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + HOUR }) }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      await Promise.all([
        resolveChatGptCredential({ file }),
        resolveChatGptCredential({ file }),
        resolveChatGptCredential({ file })
      ]);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("names the remedy when there is no credential, and when it is an API-key login", async () => {
    await expect(resolveChatGptCredential({ file: path.join(dir, "missing.json") })).rejects.toThrow(
      /Accounts page/
    );
    const keyFile = path.join(dir, "key.json");
    await fsp.writeFile(keyFile, JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: {} }));
    await expect(resolveChatGptCredential({ file: keyFile })).rejects.toThrow(/not a subscription/);
  });
});

describe("chatgpt transport contract", () => {
  beforeEach(() => resetChatGptAuthCache());

  it("forces the three body rules the backend demands", () => {
    const out = normalizeResponsesBody({ model: "gpt-5.6-luna", store: true, input: [] });
    expect(out.store).toBe(false);
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.instructions).toBeTruthy();
    // An existing instruction is never overwritten.
    expect(normalizeResponsesBody({ instructions: "be terse" }).instructions).toBe("be terse");
    // include is extended, not replaced.
    expect(normalizeResponsesBody({ include: ["other"] }).include).toEqual([
      "other",
      "reasoning.encrypted_content"
    ]);
  });

  it("stamps the identity headers, including the load-bearing originator", async () => {
    // A bespoke originator gets "Model not found" on the gpt-5.6 family, so this
    // value is a functional requirement, not cosmetics.
    let seen: Headers | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Headers;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const f = createChatGptFetch({
      fetchImpl,
      sessionId: "sess-1",
      resolve: async () => ({ accessToken: "tok-abc", accountId: "acct-9" })
    });
    await f("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" });
    expect(seen!.get("authorization")).toBe("Bearer tok-abc");
    expect(seen!.get("chatgpt-account-id")).toBe("acct-9");
    expect(seen!.get("originator")).toBe(CHATGPT_ORIGINATOR);
    expect(CHATGPT_ORIGINATOR).toBe("codex_cli_rs");
    expect(seen!.get("session_id")).toBe("sess-1");
  });

  it("retries ONCE with a forced refresh on 401, then gives up", async () => {
    const forced: boolean[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;
    const f = createChatGptFetch({
      fetchImpl,
      resolve: async ({ forceRefresh }: { forceRefresh?: boolean }) => {
        forced.push(!!forceRefresh);
        return { accessToken: "t", accountId: "" };
      }
    });
    const res = await f("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(calls).toBe(2);
    expect(forced).toEqual([false, true]);
  });

  it("classifies a plan usage limit as its own error, not a generic 429", async () => {
    // Observed live: {"error":{"type":"usage_limit_reached","plan_type":"prolite",
    // "resets_at":...}}. It must not look like a retryable rate limit.
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "prolite", resets_at: 1787495924 }
    });
    const fetchImpl = (async () => new Response(body, { status: 429 })) as unknown as typeof fetch;
    const f = createChatGptFetch({ fetchImpl, resolve: async () => ({ accessToken: "t", accountId: "" }) });
    await expect(
      f("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" })
    ).rejects.toBeInstanceOf(ChatGptUsageLimitError);
  });

  it("passes an ordinary 429 straight through", async () => {
    const fetchImpl = (async () => new Response('{"error":{"type":"rate_limit"}}', { status: 429 })) as unknown as typeof fetch;
    const f = createChatGptFetch({ fetchImpl, resolve: async () => ({ accessToken: "t", accountId: "" }) });
    const res = await f("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
  });
});

describe("account plumbing for the subscription provider", () => {
  it("server route and client contract agree that auth-file accounts are allowed", () => {
    // These two tables are independent restatements of the same rule. They have
    // drifted before, and the failure is silent: the UI offers a pin the runner
    // then refuses at launch.
    const route = primaryAccountRoute("openai-agents", "chatgpt-subscription");
    expect(route).toEqual({ kind: "strict", platform: "openai", allowAuthFile: true });
    const contract = runtimeAccountContract("openai-agents-runtime", "openai-agents", "chatgpt-subscription");
    expect(contract).toEqual({ platform: "openai", allowAuthFile: true, emptyMode: "machine-login" });
  });

  it("keeps the key-authenticated openai providers token-only on both sides", () => {
    expect(primaryAccountRoute("openai-agents", "openai")).toEqual({
      kind: "strict",
      platform: "openai",
      allowAuthFile: false
    });
    expect(runtimeAccountContract("openai-agents-runtime", "openai-agents", "openai")?.allowAuthFile).toBe(false);
  });
});

describe("reasoning effort is actually forwarded", () => {
  it("carries a supported effort into the run params and reports it applied", async () => {
    // @ts-ignore
    const { OpenAiAgentsAdapter } = await import("../fittings/seed/openai-agents-runtime/lib/openai-agents-adapter.mjs");
    const adapter = new OpenAiAgentsAdapter({ runAgent: async () => ({}) });
    const session = await adapter.spawn({
      provider: "chatgpt-subscription",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      promptMode: "coding"
    });
    expect(session.effortApplied).toBe(true);
    expect(adapter.buildRunParams(session, "hi").effort).toBe("xhigh");
    expect(adapter.buildRunParams(session, "hi").wireApi).toBe("responses");
  });

  it("does not claim an effort was applied on a provider that has none", async () => {
    // @ts-ignore
    const { OpenAiAgentsAdapter } = await import("../fittings/seed/openai-agents-runtime/lib/openai-agents-adapter.mjs");
    const adapter = new OpenAiAgentsAdapter({ runAgent: async () => ({}) });
    const session = await adapter.spawn({ provider: "ollama-local", model: "qwen2.5:3b", effort: "high" });
    expect(session.effortApplied).toBe(false);
  });
});
