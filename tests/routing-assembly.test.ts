import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestratorInstructions } from "../src/lib/orchestrator-projection";
import { substituteRoutingPlaceholder, resolveRoutingSection, substituteCapabilitiesPlaceholder } from "../src/lib/runner";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { compileRouting, routingMarkerV2 } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

// resolveRoutingSection now also compiles ~/.garrison/orchestrator/policy.json
// (D4); point it at a sandbox so tests never write the real home state.
beforeAll(() => {
  process.env.GARRISON_POLICY_PATH = join(mkdtempSync(join(tmpdir(), "garrison-policy-")), "policy.json");
});

const ROOT = join(__dirname, "..");
const PROMPT = readFileSync(
  join(ROOT, "fittings/seed/orchestrator/.apm/prompts/orchestrator.prompt.md"),
  "utf8"
);
const SEED = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8")
);

describe("routing assembly (MR1b — assembly-ok)", () => {
  it("the model-router orchestrator prompt template SOURCE carries BOTH placeholders (s0 acceptance: {{routing}} + {{capabilities}} reach the model-router prompt)", () => {
    // The whole point of s0 is that the model-router orchestrator prompt — the
    // default front-door orchestrator — carries the {{routing}} placeholder (so the
    // compiled policy + discipline land) AND keeps {{capabilities}} (so provider
    // for_consumers reach the operative). A regression dropping EITHER placeholder
    // from the template would otherwise be invisible to the assembly tests below,
    // which feed a hand-built prompt.
    expect(PROMPT).toContain("{{routing}}");
    expect(PROMPT).toContain("{{capabilities}}");
  });

  it("the {{capabilities}} fold actually delivers provider for_consumers text into the prompt (sentinel provider)", () => {
    // The assembly tests below pass entries: [] so they never exercise the
    // capabilities fold — a broken {{capabilities}} substitution would stay green.
    // Prove the real path: a provider with for_consumers text must reach the output.
    const SENTINEL = "SENTINEL-for-consumers-7f3a";
    const entry = {
      id: "sentinel-provider",
      summary: "sentinel",
      metadata: {
        summary: "sentinel summary",
        for_consumers: SENTINEL,
        provides: [{ kind: "memory-store", name: "sentinel" }],
        consumes: []
      }
    } as unknown as Parameters<typeof substituteCapabilitiesPlaceholder>[1][number];
    const folded = substituteCapabilitiesPlaceholder("before {{capabilities}} after", [entry]);
    expect(folded).toContain(SENTINEL);
    expect(folded).not.toContain("{{capabilities}}");
  });

  it("the assembled orchestrator instructions contain the routing section AND [orchestrator-active], with no leaked placeholders", () => {
    const section = compileRouting(SEED, "balanced");
    const out = buildOrchestratorInstructions({
      orchestrator: PROMPT,
      soul: "# Verity\nYou are Verity, the operative's identity.",
      entries: [],
      routingSection: section
    });
    // routing section injected
    expect(out).toContain(routingMarkerV2("balanced"));
    expect(out).toContain("Routing policy");
    // [orchestrator-active] preserved (load-bearing for integration-check + tests)
    expect(out).toContain("[orchestrator-active]");
    // identity folded in ahead (integration-check looks for "Verity")
    expect(out).toContain("Verity");
    // no placeholder leaks
    expect(out).not.toContain("{{routing}}");
    expect(out).not.toContain("{{capabilities}}");
    // regression: the routing section must appear exactly ONCE — a literal
    // {{routing}} mention inside an explanatory comment must not be re-expanded.
    const markerCount = out.split(routingMarkerV2("balanced")).length - 1;
    expect(markerCount).toBe(1);
  });

  it("the compiled routing section carries the discipline + continuations policy, and it reaches the assembled prompt (foundation for discipline→skill mapping)", () => {
    const section = compileRouting(SEED, "balanced");
    // the discipline matrix (post-task duties by tier) + continuations are the
    // policy the orchestrator turns into autothing-style gates (WS4).
    expect(section).toContain("Discipline");
    expect(section).toContain("Continuations");
    const out = buildOrchestratorInstructions({
      orchestrator: PROMPT,
      soul: "# Verity\nYou are Verity, the operative's identity.",
      entries: [],
      routingSection: section
    });
    // both discipline AND continuations must reach the operative's assembled
    // prompt, not just the compiled section.
    expect(out).toContain("Discipline");
    expect(out).toContain("Continuations");
    expect(out).not.toContain("{{routing}}");
  });

  it("substituteRoutingPlaceholder strips the placeholder cleanly when no section is available", () => {
    const stripped = substituteRoutingPlaceholder("before {{routing}} after", null);
    expect(stripped).toBe("before  after");
    expect(stripped).not.toContain("{{routing}}");
  });

  it("substituteRoutingPlaceholder is a no-op for a prompt without the placeholder (default composition safety)", () => {
    const p = "garrison-orchestrator prompt with {{capabilities}} only";
    expect(substituteRoutingPlaceholder(p, compileRouting(SEED, "balanced"))).toBe(p);
  });

  it("resolveRoutingSection falls back to the seed config when no composition-scoped routing.json exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-routing-"));
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    const section = await resolveRoutingSection(dir);
    expect(section).not.toBeNull();
    expect(section).toContain(routingMarkerV2("balanced")); // seed activeProfile
    // D4: assembly also compiled the machine-readable policy
    const policy = JSON.parse(readFileSync(process.env.GARRISON_POLICY_PATH as string, "utf8"));
    expect(policy.policyVersion).toBe(2);
    expect(policy.matrix.implement["T2-deep"].targetId).toBe("cc-opus-high");
  });

  it("resolveRoutingSection prefers a composition-scoped routing.json (active profile honored)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-routing-"));
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    const scoped = { ...SEED, activeProfile: "economy" };
    writeFileSync(join(dir, ".garrison", "routing.json"), JSON.stringify(scoped), "utf8");
    const section = await resolveRoutingSection(dir);
    expect(section).toContain(routingMarkerV2("economy"));
    expect(section).toContain("cc-ollama-qwen"); // economy's matrix routes code at ollama
  });

  it("resolveRoutingSection returns null for an invalid config (caller warns, no leak)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-routing-"));
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    writeFileSync(join(dir, ".garrison", "routing.json"), JSON.stringify({ version: 1, profiles: {} }), "utf8");
    const section = await resolveRoutingSection(dir);
    expect(section).toBeNull();
  });

  it("resolveRoutingSection reports a validation diagnostic for an invalid config (never conflated with a compiler-load failure)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-routing-"));
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    writeFileSync(join(dir, ".garrison", "routing.json"), JSON.stringify({ version: 1, profiles: {} }), "utf8");
    const diagnostics: string[] = [];
    const section = await resolveRoutingSection(dir, [], (message) => diagnostics.push(message));
    expect(section).toBeNull();
    expect(diagnostics.join("\n")).toContain("failed validation");
    expect(diagnostics.join("\n")).not.toContain("compiler failed to load");
  });

  it("resolveRoutingSection reports an invalid-JSON diagnostic for a malformed routing.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-routing-"));
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    writeFileSync(join(dir, ".garrison", "routing.json"), "{ not json", "utf8");
    const diagnostics: string[] = [];
    const section = await resolveRoutingSection(dir, [], (message) => diagnostics.push(message));
    expect(section).toBeNull();
    expect(diagnostics.join("\n")).toContain("not valid JSON");
  });

  it("resolveRoutingSection emits NO diagnostics on the happy path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "garrison-routing-"));
    mkdirSync(join(dir, ".garrison"), { recursive: true });
    const diagnostics: string[] = [];
    const section = await resolveRoutingSection(dir, [], (message) => diagnostics.push(message));
    expect(section).not.toBeNull();
    expect(diagnostics).toEqual([]);
  });
});
