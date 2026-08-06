// The GLM composition — a fully non-Anthropic operative on a self-hosted,
// OpenAI-compatible endpoint.
//
// Modelled on tests/cursor-runtime.test.ts's csg block, which is the only place
// a committed composition is checked end to end (parse → selections → readiness).
// listCompositions() is deliberately tolerant — a composition whose apm.yml
// throws is returned as null and silently vanishes from the UI — so without a
// test like this a malformed manifest has nothing to fail against.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "compositions", "glm");

function manifest(): any {
  return yaml.load(readFileSync(path.join(DIR, "apm.yml"), "utf8"));
}

function policy(): any {
  return JSON.parse(readFileSync(path.join(DIR, "routing.glm-only.json"), "utf8"));
}

describe("glm composition — manifest", () => {
  it("parses, is schema 4, and resolves its selections against the library", async () => {
    const { readComposition, validateCompositionSelections, selectedLibraryEntries } = await import(
      "@/lib/compositions"
    );
    const composition = await readComposition("glm");
    expect(composition.id).toBe("glm");
    expect(composition.schema).toBe(4);
    await expect(validateCompositionSelections(composition.selections)).resolves.not.toThrow();
    const entries = await selectedLibraryEntries(composition.selections);
    // Every selected id must be a registered library entry — an unregistered one
    // throws "Unknown fitting" at up() time, not here, unless we check.
    const selectedIds = Object.values(composition.selections)
      .flatMap((items) => items ?? [])
      .map((item) => item.id)
      .sort();
    expect(entries.map((e) => e.id).sort()).toEqual(selectedIds);
  });

  it("satisfies every readiness rule, with a clean duty graph", async () => {
    const { readComposition, selectedLibraryEntries } = await import("@/lib/compositions");
    const { resolveModel } = await import("@/lib/resolver");
    const composition = await readComposition("glm");
    const entries = await selectedLibraryEntries(composition.selections);
    const model = resolveModel({
      fittings: entries.map((e) => ({ id: e.id, metadata: e.metadata })),
      compositionDuties: composition.duties,
      selectedDuties: composition.selectedDuties
    });
    expect(model.errors).toEqual([]);
    // Name the unmet rules rather than asserting a bare boolean, so a regression
    // says WHICH rule broke.
    expect(model.rules.filter((r) => !r.met).map((r) => r.rule.id)).toEqual([]);
    expect(model.ready).toBe(true);
  });

  it("stations openai-agents-runtime and no other runtime fitting", () => {
    const m = manifest();
    const runtimes = m["x-garrison"].composition.selections.runtimes ?? [];
    expect(runtimes.map((r: any) => r.id)).toEqual(["openai-agents-runtime"]);
    const deps = m.dependencies.apm.map((d: any) => d.path);
    expect(deps.filter((p: string) => /-runtime$/.test(p))).toEqual([
      "../../fittings/seed/openai-agents-runtime"
    ]);
  });

  it("routes every duty cell to a glm-* target on the openai-agents runtime", () => {
    const m = manifest();
    const c = m["x-garrison"].composition;
    const targetIds = new Set(c.targets.map((t: any) => t.id));
    for (const target of c.targets) {
      expect(target.runtime).toBe("openai-agents");
      expect(target.provider).toBe("glm");
    }
    // Every cell must name a target that EXISTS — an unknown target id is an
    // error the router only surfaces at turn time.
    for (const duty of c.duties) {
      for (const level of duty.levels) {
        expect(targetIds.has(level.cell.target)).toBe(true);
        // This engine has no effort control (plain chat_completions carries no
        // such parameter), so a cell declaring one would be a badge with nothing
        // behind it.
        expect(level.cell.effort).toBeUndefined();
      }
    }
  });

  it("declares no baseUrl on any target — the endpoint comes from the trusted config", () => {
    // Load-bearing: the adapter's key-egress fence compares a target baseUrl
    // against the trusted (env/vault) one and drops the call to KEYLESS on any
    // mismatch. Leaving targets URL-free means they inherit the trusted value, so
    // they cannot drift out of it and 401 silently.
    for (const target of manifest()["x-garrison"].composition.targets) {
      expect(target.baseUrl).toBeUndefined();
      expect(target.params?.baseUrl).toBeUndefined();
    }
    for (const target of policy().targets) {
      expect(target.baseUrl).toBeUndefined();
    }
  });

  it("routes dispatch through an explicit native target with no legacy gateway flag", () => {
    const composition = manifest()["x-garrison"].composition;
    const http = composition.selections.gateway.find((g: any) => g.id === "http-gateway");
    expect(http?.config?.routing_on_primary).toBeUndefined();
    const duty = composition.duties.find((d: any) => d.id === "dispatch");
    expect(duty.levels[0].cell.target).toBe("glm-fast");
    expect(composition.targets.find((t: any) => t.id === "glm-fast")).toMatchObject({ runtime: "openai-agents", provider: "glm" });
  });
});

describe("glm composition — routing policy", () => {
  it("passes the orchestrator's own policy validator", async () => {
    const core: any = await import(
      pathToFileURL(path.join(ROOT, "fittings/seed/orchestrator/lib/policy-core.mjs")).href
    );
    expect(core.validatePolicyConfig(policy())).toEqual([]);
  });

  it("names openai-agents-runtime primary and carries a glm provider with a base URL", () => {
    const p = policy();
    expect(p.primaryRuntime).toBe("openai-agents-runtime");
    const glm = p.providers.find((x: any) => x.id === "glm");
    expect(glm).toBeTruthy();
    // validateProviders REQUIRES a baseUrl for any kind other than anthropic-plan.
    expect(glm.kind).toBe("cloud-oss");
    expect(String(glm.baseUrl)).toMatch(/^https?:\/\/.+\/v1$/);
    expect(glm.vaultKey).toBe("GLM_API_KEY");
  });

  it("holds no reference to any other engine's targets", () => {
    // The remap that produced this file must have covered the matrices,
    // exceptions and continuations — a leftover cursor-*/claude-* target id would
    // route a lane straight off this composition.
    const raw = JSON.stringify({
      profiles: policy().profiles,
      exceptions: policy().exceptions,
      discipline: policy().discipline,
      continuations: policy().continuations
    });
    expect(raw).not.toMatch(/cursor-/);
    expect(raw).not.toMatch(/claude-/);
    expect(raw).not.toMatch(/codex-(low|med|high|auto)/);
  });

  it("every target the matrices reference is declared", () => {
    const p = policy();
    const declared = new Set(p.targets.map((t: any) => t.id));
    const referenced = new Set<string>();
    const walk = (o: any, underTargetKey = false) => {
      if (typeof o === "string" && underTargetKey) referenced.add(o);
      else if (Array.isArray(o)) o.forEach((v) => walk(v, underTargetKey));
      else if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          walk(v, k === "target" || k === "cells" || k === "columns" || k === "default");
        }
      }
    };
    walk(p.profiles);
    walk(p.exceptions);
    for (const id of referenced) expect(declared.has(id)).toBe(true);
    expect(referenced.size).toBeGreaterThan(0);
  });
});
