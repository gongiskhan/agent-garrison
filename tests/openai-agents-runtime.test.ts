import { describe, it, expect } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
// @ts-ignore - pure .mjs runtime layer
import { buildHarness, defaultPromptModeForRole, LEAN_SYSTEM_PROMPT, FULL_SYSTEM_PROMPT } from "../fittings/seed/openai-agents-runtime/lib/harness.mjs";
// @ts-ignore
import {
  OPENAI_PROVIDERS,
  resolveEndpoint,
  resolveBaseUrl,
  capabilityRecord,
  assertSupportsBlocks,
  assertValidBaseUrl,
  authModeFor,
  DEFAULT_API_KEY_ENV
  // @ts-ignore
} from "../fittings/seed/openai-agents-runtime/lib/providers.mjs";
// @ts-ignore
import { OpenAiAgentsAdapter } from "../fittings/seed/openai-agents-runtime/lib/openai-adapter.mjs";
// @ts-ignore
import { openAiPoolKey, openAiPoolEntries } from "../fittings/seed/openai-agents-runtime/lib/pool.mjs";
// @ts-ignore
import { delegate, validateDelegationResult, runAdapterConformance, MultiRuntimePool } from "../packages/claude-pty/src/index.mjs";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";

const REPO = path.resolve(__dirname, "..");
const FIT = path.join(REPO, "fittings/seed/openai-agents-runtime");
const BRIDGE = path.join(FIT, "scripts/bridge.mjs");

// An adapter whose injected runAgent returns a fixed structured envelope - the
// unit path never loads @openai/agents / openai / zod.
function adapterReturning(envelope: any) {
  return new OpenAiAgentsAdapter({ runAgent: async () => envelope });
}

// ── Providers + endpoint resolution (openai-providers-ok) ────────────────────
describe("Providers - OpenAI-compatible endpoints + by-name Vault key (openai-providers-ok)", () => {
  it("the three OpenAI-compatible providers are present", () => {
    expect(Object.keys(OPENAI_PROVIDERS).sort()).toEqual(["ollama-local", "openai", "openai-compat"]);
  });

  it("ollama-local resolves the fixed local /v1 endpoint keyless (dummy token, no vault)", () => {
    const ep = resolveEndpoint({ provider: "ollama-local" }, { secrets: null });
    expect(ep.baseUrl).toBe("http://localhost:11434/v1");
    expect(ep.apiKeyEnv).toBe(null); // keyless local - no vault key needed
    expect(ep.apiKey).toBe("ollama");
  });

  it("openai resolves the by-name Vault key (OPENAI_API_KEY) and the SDK-default base URL", () => {
    const ep = resolveEndpoint({ provider: "openai", model: "gpt-4o-mini" }, { secrets: { OPENAI_API_KEY: "sk-live" } });
    expect(ep.baseUrl).toBe(null); // SDK default (https://api.openai.com/v1)
    expect(ep.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(ep.apiKey).toBe("sk-live");
    expect(DEFAULT_API_KEY_ENV).toBe("OPENAI_API_KEY");
  });

  it("the by-name key may arrive via the server-side env (primary path), never argv", () => {
    const ep = resolveEndpoint({ provider: "openai" }, { secrets: {}, env: { OPENAI_API_KEY: "sk-from-env" } });
    expect(ep.apiKey).toBe("sk-from-env");
  });

  it("a missing OPENAI_API_KEY fails loudly, distinguishing ABSENT vs LOCKED", () => {
    expect(() => resolveEndpoint({ provider: "openai" }, { secrets: {} })).toThrow(/ABSENT/);
    expect(() => resolveEndpoint({ provider: "openai" }, { secrets: null })).toThrow(/LOCKED/);
  });

  it("openai-compat requires an explicit base URL (or OPENAI_BASE_URL from the env)", () => {
    expect(() => resolveBaseUrl({ provider: "openai-compat" }, {})).toThrow(/requires an explicit target\.baseUrl/);
    expect(resolveBaseUrl({ provider: "openai-compat", baseUrl: "http://localhost:8000/v1" }, {})).toBe("http://localhost:8000/v1");
    expect(resolveBaseUrl({ provider: "openai-compat" }, { env: { OPENAI_BASE_URL: "http://localhost:9000/v1" } })).toBe(
      "http://localhost:9000/v1"
    );
  });

  it("openai-compat can name a keyless local endpoint (no vault key required)", () => {
    const ep = resolveEndpoint({ provider: "openai-compat", baseUrl: "http://localhost:8000/v1", keyless: true }, { secrets: null });
    expect(ep.baseUrl).toBe("http://localhost:8000/v1");
    expect(ep.apiKeyEnv).toBe(null);
  });

  it("the base-URL fence rejects a non-http(s) URL", () => {
    expect(() => assertValidBaseUrl("file:///etc/passwd", "openai-compat")).toThrow(/must be http/);
    expect(() => assertValidBaseUrl("not a url", "openai-compat")).toThrow(/not a valid URL/);
    expect(assertValidBaseUrl("https://api.example.com/v1", "openai-compat")).toBe("https://api.example.com/v1");
  });

  it("capability records: ollama-local is text + tool-use only; openai adds vision", () => {
    expect(capabilityRecord({ provider: "ollama-local" })).toMatchObject({
      text: true,
      toolUse: true,
      image: false,
      document: false,
      webSearch: false,
      mcp: false,
      effort: "unsupported"
    });
    expect(capabilityRecord({ provider: "openai" })).toMatchObject({ text: true, toolUse: true, image: true });
  });

  it("assertSupportsBlocks refuses an unsupported block (image @ ollama-local) and allows supported ones", () => {
    expect(() => assertSupportsBlocks({ provider: "ollama-local" }, ["image"])).toThrow(/does not serve|capability/i);
    expect(assertSupportsBlocks({ provider: "openai" }, ["image", "tool_use"]).image).toBe(true);
  });

  it("a per-target capability override wins over the provider default (new-endpoint onboarding)", () => {
    const rec = capabilityRecord({ provider: "openai-compat", capabilities: { text: true, toolUse: true, image: true } });
    expect(rec.image).toBe(true);
  });

  it("authModeFor reports api-key / local per provider", () => {
    expect(authModeFor({ provider: "openai" })).toBe("api-key");
    expect(authModeFor({ provider: "ollama-local" })).toBe("local");
    expect(authModeFor({ provider: "openai-compat" })).toBe("api-key");
  });
});

// ── SDK import isolation (injectability, not a ban) ──────────────────────────
describe("SDK import isolation - the SDK imports live in one injectable module", () => {
  function sourceFiles(): string[] {
    return (readdirSync(FIT, { recursive: true }) as string[])
      .map((f) => String(f).split(path.sep).join("/"))
      .filter((f) => /\.(mjs|js|ts)$/.test(f))
      .filter((f) => !f.includes("node_modules"));
  }

  it("only lib/openai-client.mjs imports @openai/agents / openai / zod", () => {
    const importsSdk = (src: string) =>
      /from\s+["']@openai\/agents["']/.test(src) || /from\s+["']openai["']/.test(src) || /from\s+["']zod["']/.test(src);
    const importers = sourceFiles().filter((f) => importsSdk(readFileSync(path.join(FIT, f), "utf8")));
    expect(importers.sort()).toEqual(["lib/openai-client.mjs"]);
  });
});

// ── The harness (openai-harness-ok) ──────────────────────────────────────────
describe("The harness - per-target promptMode (openai-harness-ok)", () => {
  it("full → software-engineering prompt + file tools enabled", () => {
    const h = buildHarness("full");
    expect(h.promptMode).toBe("full");
    expect(h.instructions).toBe(FULL_SYSTEM_PROMPT);
    expect(h.toolsEnabled).toBe(true);
  });

  it("lean → minimal chat prompt, tools DISABLED", () => {
    const h = buildHarness("lean");
    expect(h.promptMode).toBe("lean");
    expect(h.instructions).toBe(LEAN_SYSTEM_PROMPT);
    expect(h.toolsEnabled).toBe(false);
  });

  it("full appends extra instructions when given", () => {
    const h = buildHarness("full", { append: "garrison rules" });
    expect(h.instructions).toContain(FULL_SYSTEM_PROMPT);
    expect(h.instructions).toContain("garrison rules");
  });

  it("defaults: coding/agentic roles → full, chat/classification → lean", () => {
    expect(defaultPromptModeForRole("standard")).toBe("full");
    expect(defaultPromptModeForRole("review")).toBe("full");
    expect(defaultPromptModeForRole("fast")).toBe("lean");
  });
});

// ── Adapter conformance + structured awaitResponse (openai-adapter-ok) ────────
describe("OpenAiAgentsAdapter - RuntimeAdapter conformance, no scraping (openai-adapter-ok)", () => {
  it("passes the RuntimeAdapter conformance harness with a fake runAgent", async () => {
    const adapter = adapterReturning({ finalOutput: "pong", newItems: [], history: [], usedTokens: 3 });
    const report = await runAdapterConformance(adapter, {
      config: { compositionDir: "/tmp/x", provider: "ollama-local", model: "qwen2.5:3b" },
      turnText: "ping"
    });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("openai-agents");
  });

  it("awaitResponse reads the SDK's structured envelope directly - text + tool-use, thread carried", async () => {
    const adapter = adapterReturning({
      finalOutput: "the marker is 517342",
      newItems: [
        { type: "tool_call_item", rawItem: { id: "t1", name: "read_file" } },
        { type: "message_output_item" }
      ],
      history: [{ role: "user", content: "read x" }, { role: "assistant", content: "the marker is 517342" }],
      usedTokens: 42
    });
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen2.5:3b", compositionDir: "/tmp" });
    await adapter.sendTurn(s, "read probe.txt and tell me the marker");
    const r = await adapter.awaitResponse(s);
    expect(r.toolUses.map((t: any) => t.name)).toContain("read_file");
    expect(r.text).toContain("517342");
    expect(s.usedTokens).toBe(42);
    expect(s.thread).toHaveLength(2); // history carried for the next turn
  });

  it("buildRunParams wires the harness (instructions/toolsEnabled) + the resolved endpoint", async () => {
    const adapter = adapterReturning({ finalOutput: "" });
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen2.5:3b", compositionDir: "/work", maxTurns: 5 });
    const p = adapter.buildRunParams(s, "hello");
    expect(p.baseUrl).toBe("http://localhost:11434/v1");
    expect(p.model).toBe("qwen2.5:3b");
    expect(p.toolsEnabled).toBe(true);
    expect(p.maxTurns).toBe(5);
    expect(p.cwd).toBe("/work");
    expect(s.capabilities.provider).toBe("ollama-local");
  });

  it("spawns an openai-compat session against a custom base URL with the by-name key", async () => {
    const adapter = adapterReturning({ finalOutput: "" });
    const s = await adapter.spawn({
      provider: "openai-compat",
      model: "llama-3.1",
      baseUrl: "http://localhost:8000/v1",
      compositionDir: "/work",
      secrets: { OPENAI_API_KEY: "sk-compat" }
    });
    expect(s.alive).toBe(true);
    expect(s.baseUrl).toBe("http://localhost:8000/v1");
    expect(s.apiKey).toBe("sk-compat");
  });

  it("setModel updates the model within the endpoint family; setEffort records unsupported", async () => {
    const adapter = adapterReturning({ finalOutput: "" });
    const s = await adapter.spawn({ provider: "ollama-local", model: "qwen2.5:3b", compositionDir: "/tmp" });
    await adapter.setModel(s, "qwen2.5:7b");
    expect(s.model).toBe("qwen2.5:7b");
    await adapter.setEffort(s, "high");
    expect(s.effort).toBe("high");
    expect(s.effortApplied).toBe(false); // ollama endpoint does not map effort
  });
});

// ── Budget / turn guards (openai-budget-ok) ──────────────────────────────────
describe("Budget guard - stop and report, never loop (openai-budget-ok)", () => {
  it("a max_turns envelope is reported as stoppedReason", async () => {
    const adapter = adapterReturning({ finalOutput: "", newItems: [], history: null, stoppedReason: "max_turns", usedTokens: 0 });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", maxTurns: 2 });
    await adapter.sendTurn(s, "loop forever");
    const r = await adapter.awaitResponse(s);
    expect(r.stoppedReason).toBe("max_turns");
  });

  it("a token-budget ceiling stops and reports", async () => {
    const adapter = adapterReturning({ finalOutput: "partial", newItems: [], history: [], usedTokens: 9999 });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", budgetTokens: 100 });
    await adapter.sendTurn(s, "expensive");
    const r = await adapter.awaitResponse(s);
    expect(r.stoppedReason).toBe("budget_exceeded");
    expect(s.usedTokens).toBeGreaterThanOrEqual(100);
  });
});

// ── Bridge / delegate() contract (openai-bridge-ok) ──────────────────────────
describe("openai-agents as secondary - delegate() bridge contract (openai-bridge-ok)", () => {
  it("answers delegate() with a schema-valid {summary, artifacts}, writes output, logs the delegation", async () => {
    const adapter = adapterReturning({
      finalOutput: "[openai-agents] summarised via ollama",
      newItems: [],
      history: [],
      usedTokens: 7
    });
    const logged: any[] = [];
    const written: any[] = [];
    const result = await delegate(
      { task: "summarize the changelog", model: "qwen2.5:3b" },
      {
        adapter,
        spawnConfig: { compositionDir: "/work", provider: "ollama-local", model: "qwen2.5:3b", promptMode: "full", secrets: null },
        writeArtifact: async (ns: string, name: string, content: string) => {
          written.push({ ns, name, content });
          return `artifacts/${ns}/${name}`;
        },
        logDecision: async (rec: any) => logged.push(rec),
        secrets: {},
        now: () => "2026-07-13T00:00:00Z"
      },
      { modelAllowlist: /^[\w./:+-]+$/ }
    );
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[openai-agents] summarised");
    expect(result.artifacts[0]).toMatch(/^artifacts\/delegations\//);
    expect(written).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "delegation", runtime: "openai-agents" });
  });

  it("delegate() surfaces a required-key failure loudly (locked vault) - key never in argv", async () => {
    const adapter = adapterReturning({ finalOutput: "unreachable" });
    await expect(
      delegate(
        { task: "do a cloud task", model: "gpt-4o-mini" },
        {
          adapter,
          spawnConfig: { compositionDir: "/work", provider: "openai", model: "gpt-4o-mini", secrets: null },
          writeArtifact: async () => "x",
          logDecision: async () => {},
          secrets: null, // vault locked
          now: () => "2026-07-13T00:00:00Z"
        },
        { requiredKey: "OPENAI_API_KEY" }
      )
    ).rejects.toThrow(/LOCKED/);
  });

  it("the bridge --probe prints ok without loading the SDK or hitting the network", () => {
    const out = execFileSync("node", [BRIDGE, "--probe"], { encoding: "utf8" });
    expect(out.trim()).toBe("ok");
  });
});

// ── Pool (openai-pool-ok) ────────────────────────────────────────────────────
describe("MultiRuntimePool - openai-agents warms keyed incl promptMode (openai-pool-ok)", () => {
  it("the pool key includes provider, model AND promptMode (full != lean)", () => {
    const full = openAiPoolKey({ provider: "ollama-local", model: "qwen2.5:3b", promptMode: "full" });
    const lean = openAiPoolKey({ provider: "ollama-local", model: "qwen2.5:3b", promptMode: "lean" });
    expect(full).toBe("openai-agents:ollama-local:qwen2.5:3b:full");
    expect(full).not.toBe(lean);
  });

  it("warms openai-agents sessions heterogeneous with a PTY-style stub", async () => {
    const adapter = adapterReturning({ finalOutput: "warm", newItems: [], history: [], usedTokens: 1 });
    const ptyStub = {
      id: "claude-code",
      spawned: 0,
      async spawn() {
        this.spawned++;
        return { id: `pty-${this.spawned}`, alive: true, isAlive: () => true, dispose() {} };
      }
    };
    const targets = [
      { provider: "ollama-local", model: "qwen2.5:3b", promptMode: "full", compositionDir: "/tmp" },
      { provider: "ollama-local", model: "qwen2.5:3b", promptMode: "lean", compositionDir: "/tmp" }
    ];
    const pool = new MultiRuntimePool({
      runtimes: [{ id: "claude-code", adapter: ptyStub, role: "primary", size: 1 }, ...openAiPoolEntries(targets, { adapter })]
    });
    await pool.start();
    const warmed = pool.warmedRuntimes();
    expect(warmed).toContain("claude-code");
    expect(warmed).toContain("openai-agents:ollama-local:qwen2.5:3b:full");
    expect(warmed).toContain("openai-agents:ollama-local:qwen2.5:3b:lean");
    pool.shutdown();
  });
});

// ── Seed manifest parses (openai-manifest-ok) ────────────────────────────────
describe("openai-agents-runtime seed manifest (openai-manifest-ok)", () => {
  it("parses with faculty runtimes, provides runtime:openai-agents, vault consumer, by-name secret_scope, env provider mechanism", async () => {
    const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(path.join(FIT, "apm.yml"));
    const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);
    expect(metadata.faculty).toBe("runtimes");
    expect(metadata.cardinality_hint).toBe("multi");
    expect(metadata.component_shape).toBe("cli-skill");
    expect(metadata.provides).toContainEqual({ kind: "runtime", name: "openai-agents" });
    expect(metadata.consumes).toContainEqual({ kind: "vault", cardinality: "optional-one" });
    // by-name Vault key, key server-side only
    expect(metadata.secret_scope).toEqual(["OPENAI_API_KEY"]);
    // the primary-path env contract the gateway wiring (S2c) consumes
    expect(metadata.provider_mechanism).toMatchObject({
      type: "env",
      base_url_env: "OPENAI_BASE_URL",
      auth_env: "OPENAI_API_KEY",
      model_env: "GARRISON_MODEL"
    });
    // primary-capable framing is present in the consumer-facing docs
    expect((metadata.summary ?? "").toUpperCase()).toContain("PRIMARY-CAPABLE");
    expect((metadata.for_consumers ?? "").toUpperCase()).toContain("PRIMARY");
  });

  it("declares config keys provider / model / baseUrl / promptMode / maxTurns", async () => {
    const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(path.join(FIT, "apm.yml"));
    const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);
    const keys = (metadata.config_schema ?? []).map((c: any) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["provider", "model", "baseUrl", "promptMode", "maxTurns"]));
  });
});

describe("bridge trust boundary — no key egress via delegate spec (codex S2a)", async () => {
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const bridge = await import(
    pathToFileURL(path.resolve(__dirname, "../fittings/seed/openai-agents-runtime/scripts/bridge.mjs")).href
  );

  it("a keyed provider ignores an LLM-authored spec.baseUrl (key cannot be redirected)", () => {
    const cfg = bridge.buildSpawnConfig(
      { model: "gpt-4o-mini", baseUrl: "https://attacker.example/v1", provider: "openai-compat" },
      { provider: "openai-compat", keyless: false, secrets: { OPENAI_API_KEY: "sk-live" }, haveSecrets: true, env: {} }
    );
    // baseUrl must NOT be the attacker URL — it falls back to the trusted env (undefined here).
    expect(cfg.baseUrl).toBeUndefined();
  });

  it("a keyless endpoint may set its own baseUrl (no key at risk)", () => {
    const cfg = bridge.buildSpawnConfig(
      { model: "qwen2.5:3b", baseUrl: "http://localhost:8000/v1", provider: "openai-compat" },
      { provider: "openai-compat", keyless: true, secrets: {}, haveSecrets: false, env: {} }
    );
    expect(cfg.baseUrl).toBe("http://localhost:8000/v1");
    expect(cfg.secrets).toBeNull();
  });
})
