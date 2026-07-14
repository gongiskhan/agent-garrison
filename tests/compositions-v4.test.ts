import { describe, expect, it } from "vitest";
import {
  applyLocalOverlay,
  manifestToComposition,
  parseCompositionV4
} from "@/lib/compositions";

// The x-garrison.composition parse shape is not exported (it is an internal
// interface). Tests build plain objects and lean on parseCompositionV4 /
// manifestToComposition accepting them; `as never` keeps the block loosely
// typed where a field is intentionally raw (duties/targets are `unknown`).
type Block = Parameters<typeof parseCompositionV4>[0];

function block(partial: Record<string, unknown>): Block {
  return partial as unknown as Block;
}

function manifest(compositionBlock: Record<string, unknown>) {
  return {
    name: "test",
    version: "0.1.0",
    target: "claude",
    "x-garrison": { composition: compositionBlock }
  } as unknown as Parameters<typeof manifestToComposition>[1];
}

describe("parseCompositionV4", () => {
  it("parses schema 4 with duties (leaf cell + composite sequence), selected_duties, and targets", () => {
    const parsed = parseCompositionV4(
      block({
        schema: 4,
        duties: [
          {
            id: "develop",
            title: "Develop",
            description: "develop a change end to end",
            context_hold: true,
            levels: [
              { description: "quick fix", cell: { skill: "implement", target: "fast", effort: "low" } },
              {
                description: "full pipeline",
                sequence: [{ duty: "plan" }, { duty: "implement", level: 2 }, { duty: "review" }]
              }
            ]
          }
        ],
        selected_duties: ["develop", "review"],
        targets: [
          { id: "fast", runtime: "agent-sdk", model: "haiku" },
          { id: "deep", runtime: "codex", model: "gpt-5", provider: "openai", params: { temperature: 0.2 } }
        ]
      })
    );

    expect(parsed.schema).toBe(4);
    expect(parsed.selectedDuties).toEqual(["develop", "review"]);
    expect(parsed.duties).toHaveLength(1);
    expect(parsed.duties[0].id).toBe("develop");
    // S1b: the compact-controller hold survives the composition-inline parse
    // (the schema previously stripped it as an undeclared key).
    expect(parsed.duties[0].context_hold).toBe(true);
    expect(parsed.duties[0].levels[0].cell).toEqual({ skill: "implement", target: "fast", effort: "low" });
    expect(parsed.duties[0].levels[1].sequence).toEqual([
      { duty: "plan" },
      { duty: "implement", level: 2 },
      { duty: "review" }
    ]);
    expect(parsed.targets).toEqual([
      { id: "fast", runtime: "agent-sdk", model: "haiku" },
      { id: "deep", runtime: "codex", model: "gpt-5", provider: "openai", params: { temperature: 0.2 } }
    ]);
  });

  it("rejects a target that declares effort (effort is a per-cell property, not target identity)", () => {
    expect(() =>
      parseCompositionV4(
        block({
          schema: 4,
          targets: [{ id: "bad", runtime: "codex", model: "gpt-5", effort: "high" }]
        })
      )
    ).toThrow(/effort/i);
  });

  it("rejects a duty level that is both a cell and a sequence", () => {
    expect(() =>
      parseCompositionV4(
        block({
          schema: 4,
          duties: [
            {
              id: "develop",
              title: "Develop",
              description: "d",
              levels: [{ description: "x", cell: { skill: "s" }, sequence: [{ duty: "plan" }] }]
            }
          ]
        })
      )
    ).toThrow(/cell.*sequence|sequence.*cell/i);
  });

  it("treats an absent schema marker as v3 with empty v4 blocks", () => {
    const parsed = parseCompositionV4(block({ id: "c", name: "C" }));
    expect(parsed.schema).toBe(3);
    expect(parsed.duties).toEqual([]);
    expect(parsed.selectedDuties).toEqual([]);
    expect(parsed.targets).toEqual([]);
  });

  it("treats a non-4 schema marker as v3", () => {
    expect(parseCompositionV4(block({ schema: 99 })).schema).toBe(3);
  });
});

describe("manifestToComposition v3 compatibility", () => {
  it("parses a v3 manifest identically, carrying empty v4 blocks", () => {
    const v3Composition = {
      id: "legacy",
      name: "Legacy Op",
      global_config: {
        projects_root: "~/dev",
        vault: "default",
        platform: "claude-code",
        guardrails: { max_tasks_per_tick: 5, max_spend_per_day: 25, max_tool_calls_per_tick: 30 },
        permissions_mode: "auto",
        observability_config: { log_sink: "runner" }
      },
      selections: {
        gateway: [{ id: "http-gateway", config: { port: 4777, bind_host: "127.0.0.1" } }]
      }
    };

    const composition = manifestToComposition("legacy", manifest(v3Composition));

    expect(composition.id).toBe("legacy");
    expect(composition.name).toBe("Legacy Op");
    expect(composition.globalConfig.projects_root).toBe("~/dev");
    expect(composition.selections.gateway).toEqual([
      { id: "http-gateway", config: { port: 4777, bind_host: "127.0.0.1" } }
    ]);
    // v4 fields present but empty — v3 behavior is unchanged.
    expect(composition.schema).toBe(3);
    expect(composition.duties).toEqual([]);
    expect(composition.selectedDuties).toEqual([]);
    expect(composition.targets).toEqual([]);
  });
});

describe("applyLocalOverlay", () => {
  const base = () =>
    manifest({
      id: "c",
      name: "C",
      global_config: {
        projects_root: "~/dev",
        vault: "default",
        platform: "claude-code",
        guardrails: { max_tasks_per_tick: 5, max_spend_per_day: 25, max_tool_calls_per_tick: 30 },
        permissions_mode: "auto",
        observability_config: { log_sink: "runner" }
      },
      selections: {
        gateway: [{ id: "http-gateway", config: { port: 4777, bind_host: "127.0.0.1" } }],
        memory: [{ id: "basic-memory", config: { vault_dir: "~/ObsidianVault" } }]
      }
    });

  it("returns the manifest unchanged when the overlay is null", () => {
    const input = base();
    expect(applyLocalOverlay(input, null)).toBe(input);
  });

  it("shallow-merges selection config by id (overlay wins, siblings preserved)", () => {
    const merged = applyLocalOverlay(base(), {
      selections: {
        gateway: [{ id: "http-gateway", config: { port: 9999 } }]
      }
    });
    const composition = manifestToComposition("c", merged);
    const gateway = composition.selections.gateway?.find((s) => s.id === "http-gateway");
    // port overridden by the overlay, bind_host preserved from the base.
    expect(gateway?.config).toEqual({ port: 9999, bind_host: "127.0.0.1" });
    // an untouched selection is unaffected.
    expect(composition.selections.memory?.[0].config).toEqual({ vault_dir: "~/ObsidianVault" });
  });

  it("deep-merges global_config (overrides a leaf, keeps the rest)", () => {
    const merged = applyLocalOverlay(base(), {
      global_config: {
        projects_root: "/home/other/code",
        guardrails: { max_spend_per_day: 0 } as never
      }
    });
    const composition = manifestToComposition("c", merged);
    expect(composition.globalConfig.projects_root).toBe("/home/other/code");
    // deep merge: only max_spend_per_day changed, the other guardrails survive.
    expect(composition.globalConfig.guardrails).toEqual({
      max_tasks_per_tick: 5,
      max_spend_per_day: 0,
      max_tool_calls_per_tick: 30
    });
    expect(composition.globalConfig.vault).toBe("default");
  });

  it("IGNORES an overlay selection whose id is not in the base — overlay cannot add membership (codex S3b1)", () => {
    // D8: the composition file owns membership; local.yml carries machine-local
    // VALUES for already-selected fittings only. An overlay-only id is dropped
    // (with a warning), never appended.
    const merged = applyLocalOverlay(base(), {
      selections: {
        gateway: [{ id: "extra-gateway", config: { port: 5000 } }]
      }
    });
    const composition = manifestToComposition("c", merged);
    expect(composition.selections.gateway?.map((s) => s.id)).toEqual(["http-gateway"]);
  });

  it("drops __proto__/constructor keys from the overlay merge (prototype-pollution guard, codex S3b1)", () => {
    const merged = applyLocalOverlay(base(), {
      global_config: JSON.parse('{"__proto__":{"primary_runtime":"codex-runtime"}}')
    });
    const composition = manifestToComposition("c", merged);
    // The malicious key never reaches the merged config, and Object.prototype is clean.
    expect((composition.globalConfig as unknown as Record<string, unknown>).primary_runtime).toBeUndefined();
    expect(({} as Record<string, unknown>).primary_runtime).toBeUndefined();
  });

  it("does not mutate the input manifest", () => {
    const input = base();
    const before = JSON.stringify(input);
    applyLocalOverlay(input, { selections: { gateway: [{ id: "http-gateway", config: { port: 1 } }] } });
    expect(JSON.stringify(input)).toBe(before);
  });
});
