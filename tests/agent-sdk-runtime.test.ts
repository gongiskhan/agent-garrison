import { describe, it, expect } from "vitest";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
// @ts-ignore
import { buildHarness, defaultPromptModeForRole, LEAN_SYSTEM_PROMPT } from "../fittings/seed/agent-sdk-runtime/lib/harness.mjs";
// @ts-ignore
import { SDK_PROVIDERS, buildSdkEnv, resolveProviderBaseUrl, capabilityRecord, assertSupportsBlocks, assertLitellmVersionAllowed, authModeFor } from "../fittings/seed/agent-sdk-runtime/lib/providers.mjs";
// @ts-ignore
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore
import { delegate, validateDelegationResult, runAdapterConformance, MultiRuntimePool } from "../packages/claude-pty/src/index.mjs";
// @ts-ignore
import { agentSdkPoolKey, agentSdkPoolEntries } from "../fittings/seed/agent-sdk-runtime/lib/pool.mjs";

// A literal Anthropic host, used here only to prove buildSdkEnv STRIPS an inherited
// one. tests/ is out of the headless-exclusion scan, so the literal is allowed.
const ANTHROPIC_URL = "https://api.anthropic.com";

function gen(messages: any[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}
function adapterYielding(messages: any[]) {
  return new AgentSdkAdapter({ createClient: async () => gen(messages) });
}

// ── Runtime freedom: Anthropic is first-class routable (D29) ─────────────────
describe("Runtime freedom — the Agent SDK reaches Anthropic + third-party endpoints (D29)", () => {
  it("the Anthropic subscription provider is first-class (no base URL, no key, OAuth)", () => {
    const { env, baseUrl, vaultKey } = buildSdkEnv({ provider: "anthropic", model: "claude-haiku-4-5" }, { secrets: null });
    expect(baseUrl).toBe(null); // SDK default Anthropic endpoint
    expect(vaultKey).toBe(null); // Max OAuth, not a Vault key
    // No base-URL override; the key is forced EMPTY (an empty string is falsy
    // to the CLI's key check, so stored OAuth creds win) — masking any stray
    // ANTHROPIC_API_KEY in the inherited process env that would bill the API pool.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("clears an inherited Anthropic base URL / key before the subscription launch", () => {
    const { env } = buildSdkEnv(
      { provider: "anthropic" },
      { baseEnv: { ANTHROPIC_BASE_URL: "https://leak.example", ANTHROPIC_API_KEY: "leak", ANTHROPIC_AUTH_TOKEN: "leak" } }
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe(""); // masked, not merely deleted (process env underneath)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("authModeFor reports subscription / api-key / local per provider", () => {
    expect(authModeFor({ provider: "anthropic" })).toBe("subscription");
    expect(authModeFor({ provider: "ollama-local" })).toBe("local");
    expect(authModeFor({ provider: "deepseek" })).toBe("api-key");
    expect(authModeFor({ provider: "zai-glm" })).toBe("api-key");
    expect(authModeFor({ provider: "llm-proxy" })).toBe("api-key");
    // an explicit per-target authMode wins over the provider default
    expect(authModeFor({ provider: "deepseek", authMode: "subscription" })).toBe("subscription");
  });
});

// ── SDK import isolation (injectability, not a ban) ──────────────────────────
describe("SDK import isolation — the @anthropic-ai import lives in one injectable module", () => {
  const FIT = path.resolve(__dirname, "../fittings/seed/agent-sdk-runtime");
  function sourceFiles(): string[] {
    return (readdirSync(FIT, { recursive: true }) as string[])
      .map((f) => String(f).split(path.sep).join("/"))
      .filter((f) => /\.(mjs|js|ts)$/.test(f))
      .filter((f) => !f.includes("node_modules"));
  }

  it("only lib/sdk-client.mjs imports @anthropic-ai (so the adapter stays injectable/testable)", () => {
    const importers = sourceFiles().filter((f) => /@anthropic-ai\//.test(readFileSync(path.join(FIT, f), "utf8")));
    expect(importers.sort()).toEqual(["lib/sdk-client.mjs"]);
  });
});

// ── THE HARNESS (harness-ok) ────────────────────────────────────────────────
describe("THE HARNESS — per-target promptMode (harness-ok)", () => {
  it("full → claude_code preset + settingSources[project] + skills + CLAUDE.md", () => {
    const h = buildHarness("full");
    expect(h.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(h.settingSources).toEqual(["project"]);
    expect(h.preset).toBe("claude_code");
    expect(h.claudeMdLoaded).toBe(true);
    expect(h.skillsMounted).toBe(true);
  });

  it("lean → minimal system string, NO settingSources, NO CLAUDE.md, NO skills", () => {
    const h = buildHarness("lean");
    expect(typeof h.systemPrompt).toBe("string");
    expect(h.systemPrompt).toBe(LEAN_SYSTEM_PROMPT);
    expect(h.settingSources).toEqual([]);
    expect(h.preset).toBe(null);
    expect(h.claudeMdLoaded).toBe(false);
    expect(h.skillsMounted).toBe(false);
  });

  it("never loads 'user' settings (defence-in-depth for #217)", () => {
    expect(buildHarness("full").settingSources).not.toContain("user");
    expect(buildHarness("lean").settingSources).not.toContain("user");
  });

  it("lean disables ALL built-in tools (pure chat → small models answer, not hallucinate); full keeps tools", () => {
    const lean = buildHarness("lean");
    expect(lean.disallowedTools).toContain("Bash");
    expect(lean.disallowedTools).toContain("Write");
    expect(lean.disallowedTools.length).toBeGreaterThan(10);
    expect(buildHarness("full").disallowedTools).toEqual([]);
  });

  it("full supports preset + append (appendSystemPrompt is deprecated)", () => {
    expect(buildHarness("full", { append: "garrison rules" }).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "garrison rules"
    });
  });

  it("defaults: coding/agentic roles → full, chat/classification/media → lean", () => {
    expect(defaultPromptModeForRole("standard")).toBe("full");
    expect(defaultPromptModeForRole("expert")).toBe("full");
    expect(defaultPromptModeForRole("review")).toBe("full");
    expect(defaultPromptModeForRole("fast")).toBe("lean");
    expect(defaultPromptModeForRole("image")).toBe("lean");
  });
});

// ── Providers + capability records (sdk-providers-ok) ───────────────────────
describe("Providers — base URL + Vault auth + capability records (sdk-providers-ok)", () => {
  it("the six providers are all present (incl. the first-class Anthropic subscription)", () => {
    expect(Object.keys(SDK_PROVIDERS).sort()).toEqual(["anthropic", "deepseek", "llm-proxy", "minimax", "ollama-local", "zai-glm"]);
  });

  it("buildSdkEnv wires the third-party base URL + Vault auth token, clears inherited Anthropic vars", () => {
    const { env, baseUrl } = buildSdkEnv({ provider: "deepseek", model: "deepseek-chat" }, { secrets: { DEEPSEEK_API_KEY: "sk-test" } });
    expect(baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.ANTHROPIC_API_KEY).toBe(""); // force AUTH_TOKEN, never an inherited key
  });

  it("strips inherited Anthropic env (MiniMax precedence trap) and sets the dummy token for Ollama", () => {
    const { env } = buildSdkEnv(
      { provider: "ollama-local" },
      { baseEnv: { ANTHROPIC_BASE_URL: ANTHROPIC_URL, ANTHROPIC_API_KEY: "leak", ANTHROPIC_AUTH_TOKEN: "leak" } }
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("missing provider key fails loudly, distinguishing absent vs locked", () => {
    expect(() => buildSdkEnv({ provider: "deepseek" }, { secrets: {} })).toThrow(/ABSENT/);
    expect(() => buildSdkEnv({ provider: "deepseek" }, { secrets: null })).toThrow(/LOCKED/);
  });

  it("DeepSeek capability record is text + tool-use ONLY (no image/document/web-search/MCP)", () => {
    expect(capabilityRecord({ provider: "deepseek" })).toMatchObject({
      text: true,
      toolUse: true,
      image: false,
      document: false,
      webSearch: false,
      mcp: false,
      effort: "unsupported"
    });
  });

  it("the Anthropic provider serves the full capability set with effort supported", () => {
    expect(capabilityRecord({ provider: "anthropic" })).toMatchObject({
      text: true,
      toolUse: true,
      image: true,
      document: true,
      webSearch: true,
      mcp: true,
      effort: "supported"
    });
  });

  it("assertSupportsBlocks refuses an unsupported block (MCP @ deepseek) and allows supported ones", () => {
    expect(() => assertSupportsBlocks({ provider: "deepseek" }, ["mcp"])).toThrow(/does not serve|capability/i);
    expect(assertSupportsBlocks({ provider: "ollama-local" }, ["mcp", "tool_use"]).mcp).toBe(true);
  });

  it("llm-proxy requires an explicit per-target base URL and enforces the LiteLLM supply-chain pin", () => {
    expect(() => resolveProviderBaseUrl({ provider: "llm-proxy" })).toThrow(/explicit target\.baseUrl/);
    expect(resolveProviderBaseUrl({ provider: "llm-proxy", baseUrl: "http://localhost:4000" })).toBe("http://localhost:4000");
    expect(() => assertLitellmVersionAllowed("1.82.7")).toThrow(/FORBIDDEN/);
    expect(() => assertLitellmVersionAllowed("1.82.8")).toThrow(/FORBIDDEN/);
    expect(() => assertLitellmVersionAllowed("1.83.0")).toThrow(/exceeds/);
    expect(assertLitellmVersionAllowed("1.82.6")).toBe(true);
  });

  it("a per-target capability override (new-model onboarding) wins over the provider default", () => {
    const rec = capabilityRecord({ provider: "llm-proxy", capabilities: { text: true, toolUse: true, mcp: true, image: true } });
    expect(rec.mcp).toBe(true);
    expect(rec.image).toBe(true);
  });
});

// ── Adapter conformance + structured awaitResponse (sdk-adapter-ok) ──────────
describe("AgentSdkAdapter — RuntimeAdapter conformance, no scraping (sdk-adapter-ok)", () => {
  it("passes the RuntimeAdapter conformance harness with a fake SDK client", async () => {
    const adapter = adapterYielding([
      { type: "assistant", message: { content: [{ type: "text", text: "pong" }] } },
      { type: "result", subtype: "success", usage: { output_tokens: 3 } }
    ]);
    const report = await runAdapterConformance(adapter, {
      config: { compositionDir: "/tmp/x", provider: "ollama-local", model: "qwen3:8b" },
      turnText: "ping"
    });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("agent-sdk");
  });

  it("awaitResponse reads the SDK's structured messages directly — text + tool-use, no scraping", async () => {
    const adapter = adapterYielding([
      { type: "system", session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "the first line is foo" }] } },
      { type: "result", subtype: "success", usage: { output_tokens: 10 } }
    ]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen3:8b", compositionDir: "/tmp" });
    await adapter.sendTurn(s, "read x and tell me its first line");
    const r = await adapter.awaitResponse(s);
    expect(r.toolUses.map((t: any) => t.name)).toContain("Read");
    expect(r.text).toContain("first line");
    expect(s.sessionId).toBe("sess-1");
  });

  it("buildQueryOptions wires the harness (preset/settingSources/maxTurns) + the launch env", async () => {
    const adapter = adapterYielding([]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen3:8b", compositionDir: "/work", maxTurns: 5 });
    const opts = adapter.buildQueryOptions(s);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.settingSources).toEqual(["project"]);
    expect(opts.maxTurns).toBe(5);
    expect(opts.cwd).toBe("/work");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(opts.env.ANTHROPIC_API_KEY).toBe("");
    expect(s.capabilities.provider).toBe("ollama-local");
  });

  it("spawns an Anthropic-endpoint agent-sdk session (first-class, D29) with no base URL", async () => {
    const adapter = adapterYielding([]);
    const s = await adapter.spawn({ provider: "anthropic", model: "claude-haiku-4-5", compositionDir: "/work" });
    expect(s.alive).toBe(true);
    expect(s.baseUrl).toBe(null);
    expect(s.capabilities.provider).toBe("anthropic");
    const opts = adapter.buildQueryOptions(s);
    expect(opts.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("forwards requested effort to the SDK only for a supported Anthropic target", async () => {
    const adapter = adapterYielding([]);
    const supported = await adapter.spawn({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      compositionDir: "/work",
      effort: "high",
    });
    expect(adapter.buildQueryOptions(supported).effort).toBe("high");
    expect(supported).toMatchObject({ effort: "high", effortApplied: true });

    await adapter.setEffort(supported, "max");
    expect(adapter.buildQueryOptions(supported).effort).toBe("max");
    expect(supported).toMatchObject({ effort: "max", effortApplied: true });

    const unsupported = await adapter.spawn({
      provider: "ollama-local",
      model: "qwen3:8b",
      compositionDir: "/work",
      effort: "high",
    });
    expect(adapter.buildQueryOptions(unsupported).effort).toBeUndefined();
    expect(unsupported).toMatchObject({ effort: "high", effortApplied: false });
  });

  it("setModel updates the model within the endpoint family; setEffort records unsupported", async () => {
    const adapter = adapterYielding([]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen3:8b", compositionDir: "/tmp" });
    await adapter.setModel(s, "qwen3:0.6b");
    expect(s.model).toBe("qwen3:0.6b");
    await adapter.setEffort(s, "high");
    expect(s.effort).toBe("high");
    expect(s.effortApplied).toBe(false); // ollama endpoint does not map effort
    expect(adapter.buildQueryOptions(s).effort).toBeUndefined();
  });
});

// ── Budget guard (sdk-budget-ok) ────────────────────────────────────────────
describe("Budget guard — stop and report, never loop (sdk-budget-ok)", () => {
  it("a maxTurns ceiling stops and reports", async () => {
    const adapter = adapterYielding([{ type: "result", subtype: "error_max_turns", usage: { output_tokens: 5 } }]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", maxTurns: 2 });
    await adapter.sendTurn(s, "loop forever");
    const r = await adapter.awaitResponse(s);
    expect(r.stoppedReason).toBe("max_turns");
  });

  it("normalizes the SDK's post-result max-turn rejection and preserves accumulated output", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () => (async function* () {
        yield { type: "system", session_id: "sdk-max-turn-session" };
        yield {
          type: "assistant",
          message: { content: [
            { type: "tool_use", id: "write-gate", name: "Write", input: {} },
            { type: "text", text: "Plan and durable gate were written." }
          ] }
        };
        yield {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["Reached maximum number of turns (24)"],
          usage: { input_tokens: 10, output_tokens: 5 }
        };
        // SDK 0.3.179 rejects on the iterator step after delivering the result.
        throw new Error("Claude Code returned an error result: Reached maximum number of turns (24)");
      })()
    });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", maxTurns: 24 });
    await adapter.sendTurn(s, "write the plan gate");
    await expect(adapter.awaitResponse(s)).resolves.toMatchObject({
      text: "Plan and durable gate were written.",
      toolUses: [{ id: "write-gate", name: "Write" }],
      stoppedReason: "max_turns"
    });
    expect(s.sessionId).toBe("sdk-max-turn-session");
    expect(s.usedTokens).toBe(15);
  });

  it("does not swallow a max-turn-looking throw without the structured result envelope", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () => (async function* () {
        throw new Error("Claude Code returned an error result: Reached maximum number of turns (24)");
      })()
    });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", maxTurns: 24 });
    await adapter.sendTurn(s, "fail before a result");
    await expect(adapter.awaitResponse(s)).rejects.toThrow(/maximum number of turns/);
  });

  it("does not hide an unrelated iterator failure after an error_max_turns envelope", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () => (async function* () {
        yield { type: "result", subtype: "error_max_turns", usage: { output_tokens: 1 } };
        throw new Error("stream integrity failure");
      })()
    });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", maxTurns: 24 });
    await adapter.sendTurn(s, "fail after a result for another reason");
    await expect(adapter.awaitResponse(s)).rejects.toThrow("stream integrity failure");
  });

  it("a token-budget ceiling stops and reports", async () => {
    const adapter = adapterYielding([
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
      { type: "result", subtype: "success", usage: { output_tokens: 9999 } }
    ]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", budgetTokens: 100 });
    await adapter.sendTurn(s, "expensive");
    const r = await adapter.awaitResponse(s);
    expect(r.stoppedReason).toBe("budget_exceeded");
    expect(s.usedTokens).toBeGreaterThanOrEqual(100);
  });
});

// ── Bridge / delegate() (sdk-bridge-ok) ─────────────────────────────────────
describe("agent-sdk as secondary — delegate() bridge (sdk-bridge-ok)", () => {
  it("answers delegate() with a schema-valid {summary, artifacts}, writes output, logs the delegation", async () => {
    const adapter = adapterYielding([
      { type: "assistant", message: { content: [{ type: "text", text: "[agent-sdk] summarised via ollama" }] } },
      { type: "result", subtype: "success", usage: { output_tokens: 7 } }
    ]);
    const logged: any[] = [];
    const written: any[] = [];
    const result = await delegate(
      { task: "summarize the changelog", model: "qwen3:8b" },
      {
        adapter,
        spawnConfig: { compositionDir: "/work", provider: "ollama-local", model: "qwen3:8b", promptMode: "full", secrets: null },
        writeArtifact: async (ns: string, name: string, content: string) => {
          written.push({ ns, name, content });
          return `artifacts/${ns}/${name}`;
        },
        logDecision: async (rec: any) => logged.push(rec),
        secrets: {},
        now: () => "2026-06-16T00:00:00Z"
      },
      { modelAllowlist: /^[\w./:+-]+$/ }
    );
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[agent-sdk] summarised");
    expect(result.artifacts[0]).toMatch(/^artifacts\/delegations\//);
    expect(written).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "delegation", runtime: "agent-sdk" });
  });
});

// ── Pool (sdk-pool-ok) ──────────────────────────────────────────────────────
describe("MultiRuntimePool — agent-sdk warms keyed incl promptMode, heterogeneous with PTY (sdk-pool-ok)", () => {
  function poolAdapter() {
    return new AgentSdkAdapter({
      createClient: async () =>
        gen([
          { type: "assistant", message: { content: [{ type: "text", text: "warm" }] } },
          { type: "result", subtype: "success", usage: { output_tokens: 1 } }
        ])
    });
  }

  it("the pool key includes provider, model AND promptMode (full != lean)", () => {
    const full = agentSdkPoolKey({ provider: "ollama-local", model: "qwen3:8b", promptMode: "full" });
    const lean = agentSdkPoolKey({ provider: "ollama-local", model: "qwen3:8b", promptMode: "lean" });
    expect(full).toBe("agent-sdk:ollama-local:qwen3:8b:full");
    expect(full).not.toBe(lean);
  });

  it("warms agent-sdk full + lean as DISTINCT pools, heterogeneous with a PTY-style stub; status visible", async () => {
    const adapter = poolAdapter();
    const ptyStub = {
      id: "claude-code",
      spawned: 0,
      async spawn() {
        this.spawned++;
        return { id: `pty-${this.spawned}`, alive: true, isAlive: () => true, dispose() {} };
      }
    };
    const targets = [
      { provider: "ollama-local", model: "qwen3:8b", promptMode: "full", compositionDir: "/tmp" },
      { provider: "ollama-local", model: "qwen3:8b", promptMode: "lean", compositionDir: "/tmp" }
    ];
    const pool = new MultiRuntimePool({
      runtimes: [{ id: "claude-code", adapter: ptyStub, role: "primary", size: 1 }, ...agentSdkPoolEntries(targets, { adapter })]
    });
    await pool.start();

    const warmed = pool.warmedRuntimes();
    expect(warmed).toContain("claude-code"); // heterogeneous: PTY + agent-sdk in one pool
    expect(warmed).toContain("agent-sdk:ollama-local:qwen3:8b:full");
    expect(warmed).toContain("agent-sdk:ollama-local:qwen3:8b:lean");

    const status = pool.status();
    expect(status["agent-sdk:ollama-local:qwen3:8b:full"].role).toBe("secondary");
    expect(status["agent-sdk:ollama-local:qwen3:8b:lean"]).toBeTruthy();

    const co = await pool.checkout("agent-sdk:ollama-local:qwen3:8b:full");
    expect(co.session.alive).toBe(true);
    expect(co.session.harness.promptMode).toBe("full"); // the warmed session carries its harness
    co.release?.();
    pool.shutdown();
  });
});
