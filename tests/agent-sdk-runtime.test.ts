import { describe, it, expect } from "vitest";
import path from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
// @ts-ignore — pure .mjs fitting modules (single-line so @ts-ignore covers the specifier)
import { assertFence, isAnthropicBaseUrl, resolveEffectiveBaseUrl, FenceViolation } from "../fittings/seed/agent-sdk-runtime/lib/fence.mjs";
// @ts-ignore
import { buildHarness, defaultPromptModeForRole, LEAN_SYSTEM_PROMPT } from "../fittings/seed/agent-sdk-runtime/lib/harness.mjs";
// @ts-ignore
import { SDK_PROVIDERS, buildSdkEnv, resolveProviderBaseUrl, capabilityRecord, assertSupportsBlocks, assertLitellmVersionAllowed, staticBaseUrlsAreNonAnthropic } from "../fittings/seed/agent-sdk-runtime/lib/providers.mjs";
// @ts-ignore
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore
import { delegate, validateDelegationResult, runAdapterConformance, MultiRuntimePool } from "../packages/claude-pty/src/index.mjs";
// @ts-ignore
import { agentSdkPoolKey, agentSdkPoolEntries } from "../fittings/seed/agent-sdk-runtime/lib/pool.mjs";

// Anthropic billing endpoint (used only in this test file — tests/ is OUT of the
// programmatic-purge scan, so the literal host is allowed here).
const ANTHROPIC_URL = "https://api.anthropic.com";

function gen(messages: any[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}
function adapterYielding(messages: any[]) {
  return new AgentSdkAdapter({ readSettings: () => null, createClient: async () => gen(messages) });
}

// ── THE FENCE (fence-ok) ───────────────────────────────────────────────────
describe("THE FENCE — default-deny Anthropic billing (fence-ok)", () => {
  it("hard-refuses to launch with NO base URL (Max/Anthropic billing path)", () => {
    expect(() => assertFence({ configBaseUrl: null })).toThrow(FenceViolation);
    expect(() => assertFence({ configBaseUrl: null })).toThrow(/no ANTHROPIC_BASE_URL|hard-refuses/);
  });

  it("hard-refuses an Anthropic base URL", () => {
    expect(() => assertFence({ configBaseUrl: ANTHROPIC_URL })).toThrow(FenceViolation);
    expect(() => assertFence({ configBaseUrl: "https://foo.anthropic.com" })).toThrow(FenceViolation);
  });

  it("passes for a non-Anthropic base URL", () => {
    const st = assertFence({ configBaseUrl: "http://localhost:11434" });
    expect(st.anthropic).toBe(false);
    expect(st.state).toMatch(/non-anthropic/);
  });

  it("acceptApiBilling: true is the ONLY way past the fence, and states the cost", () => {
    const st = assertFence({ configBaseUrl: ANTHROPIC_URL, acceptApiBilling: true });
    expect(st.anthropic).toBe(true);
    expect(st.acceptApiBilling).toBe(true);
    expect(st.state).toMatch(/FULL RATES/);
  });

  it("asserts on the EFFECTIVE base URL — settings.json env override (#217) is a violation", () => {
    expect(() =>
      assertFence({
        configBaseUrl: "http://localhost:11434",
        settingsJson: { env: { ANTHROPIC_BASE_URL: ANTHROPIC_URL } }
      })
    ).toThrow(/#217|settings\.json/);
  });

  it("a non-Anthropic settings.json override is honoured as the effective URL", () => {
    const r = resolveEffectiveBaseUrl({
      configBaseUrl: "http://localhost:11434",
      settingsJson: { env: { ANTHROPIC_BASE_URL: "http://localhost:8080" } }
    });
    expect(r.effective).toBe("http://localhost:8080");
    expect(r.overriddenBySettings).toBe(true);
    expect(assertFence({ configBaseUrl: "http://localhost:11434", settingsJson: { env: { ANTHROPIC_BASE_URL: "http://localhost:8080" } } }).anthropic).toBe(false);
  });

  it("isAnthropicBaseUrl classifies by hostname suffix", () => {
    expect(isAnthropicBaseUrl(null)).toBe(true);
    expect(isAnthropicBaseUrl("")).toBe(true);
    expect(isAnthropicBaseUrl(ANTHROPIC_URL)).toBe(true);
    expect(isAnthropicBaseUrl("https://foo.anthropic.com/x")).toBe(true);
    expect(isAnthropicBaseUrl("http://localhost:11434")).toBe(false);
    expect(isAnthropicBaseUrl("https://api.z.ai/api/anthropic")).toBe(false); // host is api.z.ai
    expect(isAnthropicBaseUrl("https://api.deepseek.com/anthropic")).toBe(false);
  });
});

// ── fence containment: the SDK import is isolated + paired with THE FENCE ────
describe("FENCE containment — the @anthropic-ai import is fenced (fence-ok)", () => {
  const FIT = path.resolve(__dirname, "../fittings/seed/agent-sdk-runtime");
  function sourceFiles(): string[] {
    return (readdirSync(FIT, { recursive: true }) as string[])
      .map((f) => String(f).split(path.sep).join("/"))
      .filter((f) => /\.(mjs|js|ts)$/.test(f))
      .filter((f) => !f.includes("node_modules"));
  }

  it("only lib/sdk-client.mjs imports @anthropic-ai, and lib/fence.mjs exists beside it", () => {
    const importers = sourceFiles().filter((f) => /@anthropic-ai\//.test(readFileSync(path.join(FIT, f), "utf8")));
    expect(importers.sort()).toEqual(["lib/sdk-client.mjs"]);
    expect(existsSync(path.join(FIT, "lib/fence.mjs"))).toBe(true);
  });

  it("no fitting source uses the banned host literal (the fence matches by suffix)", () => {
    for (const f of sourceFiles()) {
      expect(readFileSync(path.join(FIT, f), "utf8")).not.toMatch(/api\.anthropic\.com/);
    }
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
  it("every static provider base URL is non-Anthropic", () => {
    expect(staticBaseUrlsAreNonAnthropic()).toBe(true);
  });

  it("buildSdkEnv wires the non-Anthropic base URL + Vault auth token, clears inherited Anthropic vars", () => {
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

  it("the five providers are all present", () => {
    expect(Object.keys(SDK_PROVIDERS).sort()).toEqual(["deepseek", "llm-proxy", "minimax", "ollama-local", "zai-glm"]);
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
      config: { compositionDir: "/tmp/x", provider: "ollama-local", model: "qwen3:8b", settingsJson: null },
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
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen3:8b", compositionDir: "/tmp", settingsJson: null });
    await adapter.sendTurn(s, "read x and tell me its first line");
    const r = await adapter.awaitResponse(s);
    expect(r.toolUses.map((t: any) => t.name)).toContain("Read");
    expect(r.text).toContain("first line");
    expect(s.sessionId).toBe("sess-1");
  });

  it("buildQueryOptions wires the harness (preset/settingSources/maxTurns) + the fenced env", async () => {
    const adapter = adapterYielding([]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen3:8b", compositionDir: "/work", maxTurns: 5, settingsJson: null });
    const opts = adapter.buildQueryOptions(s);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.settingSources).toEqual(["project"]);
    expect(opts.maxTurns).toBe(5);
    expect(opts.cwd).toBe("/work");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(opts.env.ANTHROPIC_API_KEY).toBe("");
    expect(s.fence.anthropic).toBe(false);
    expect(s.capabilities.provider).toBe("ollama-local");
  });

  it("spawn ENFORCES the fence — an Anthropic target without acceptApiBilling throws before any model call", async () => {
    const adapter = adapterYielding([]);
    await expect(adapter.spawn({ provider: "llm-proxy", baseUrl: ANTHROPIC_URL, model: "x", compositionDir: "/tmp", settingsJson: null })).rejects.toThrow(
      FenceViolation
    );
  });

  it("setModel updates the model within the endpoint family; setEffort records unsupported", async () => {
    const adapter = adapterYielding([]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen3:8b", compositionDir: "/tmp", settingsJson: null });
    await adapter.setModel(s, "qwen3:0.6b");
    expect(s.model).toBe("qwen3:0.6b");
    await adapter.setEffort(s, "high");
    expect(s.effort).toBe("high");
    expect(s.effortApplied).toBe(false); // ollama endpoint does not map effort
  });
});

// ── Budget guard (sdk-budget-ok) ────────────────────────────────────────────
describe("Budget guard — stop and report, never loop (sdk-budget-ok)", () => {
  it("a maxTurns ceiling stops and reports", async () => {
    const adapter = adapterYielding([{ type: "result", subtype: "error_max_turns", usage: { output_tokens: 5 } }]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", maxTurns: 2, settingsJson: null });
    await adapter.sendTurn(s, "loop forever");
    const r = await adapter.awaitResponse(s);
    expect(r.stoppedReason).toBe("max_turns");
  });

  it("a token-budget ceiling stops and reports", async () => {
    const adapter = adapterYielding([
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
      { type: "result", subtype: "success", usage: { output_tokens: 9999 } }
    ]);
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", budgetTokens: 100, settingsJson: null });
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
        spawnConfig: { compositionDir: "/work", provider: "ollama-local", model: "qwen3:8b", promptMode: "full", settingsJson: null, secrets: null },
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
      readSettings: () => null,
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
      { provider: "ollama-local", model: "qwen3:8b", promptMode: "full", settingsJson: null, compositionDir: "/tmp" },
      { provider: "ollama-local", model: "qwen3:8b", promptMode: "lean", settingsJson: null, compositionDir: "/tmp" }
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
