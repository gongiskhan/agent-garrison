// The flow library, and the rules that keep it honest.
//
// The Phase 0 mining found the flow layer was not underspecified but UNUSED:
// 2 of 90 live cards carried a flow and none ever ran a phased plan, against 873
// commits of real work in the same four weeks. So the library is not judged on
// tidiness — it is judged on whether it covers the work that actually happened.
// These tests hold it to that.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs fitting module, no types
import * as policyCore from "../fittings/seed/orchestrator/lib/policy-core.mjs";
import { validateRoutingConfig, compilePolicy } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const ROUTING = path.join(process.cwd(), "compositions/default/.garrison/routing.json");
const cfg = JSON.parse(fs.readFileSync(ROUTING, "utf8"));
const flows: Record<string, Record<string, unknown>> = cfg.flows;

describe("the default composition's routing config", () => {
  it("validates", () => {
    expect(validateRoutingConfig(cfg)).toEqual([]);
  });

  it("compiles", () => {
    expect(() => compilePolicy(cfg, cfg.activeProfile ?? null)).not.toThrow();
  });
});

describe("every flow is grounded in real observed work", () => {
  // The brief: a flow that does not map to at least one real observed task must
  // be justified explicitly or dropped. Enforcing it here means the library
  // cannot quietly grow flows nobody needs.
  for (const [id, flow] of Object.entries(flows)) {
    it(`${id} names its cluster and real examples`, () => {
      expect(flow.cluster, `${id} has no cluster`).toBeTruthy();
      expect(Array.isArray(flow.examples) && (flow.examples as unknown[]).length, `${id} has no examples`).toBeTruthy();
      expect(String(flow.description).length, `${id} has no description`).toBeGreaterThan(20);
    });
  }
});

describe("every level is runnable", () => {
  const duties: string[] = cfg.taskTypes;

  for (const [id, flow] of Object.entries(flows)) {
    it(`${id} runs only duties that exist, and pins only duties it runs`, () => {
      for (const [lvl, def] of Object.entries(flow.levels as Record<string, Record<string, unknown>>)) {
        const list = def.duties as string[];
        expect(list.length, `${id} L${lvl} is empty`).toBeGreaterThan(0);
        for (const d of list) expect(duties, `${id} L${lvl} names unknown duty ${d}`).toContain(d);
        for (const pinned of Object.keys((def.pins ?? {}) as Record<string, number>)) {
          // A pin naming a duty the level does not run would silently never
          // apply — worse than an error, because it reads as configured.
          expect(list, `${id} L${lvl} pins ${pinned}, which it does not run`).toContain(pinned);
        }
        expect(String(def.definitionOfDone ?? "").length, `${id} L${lvl} has no definition of done`).toBeGreaterThan(10);
      }
    });
  }

  it("never routes to a retired duty", () => {
    const retired = Object.keys(policyCore.DUTY_ALIASES);
    for (const [id, flow] of Object.entries(flows)) {
      for (const [lvl, def] of Object.entries(flow.levels as Record<string, Record<string, unknown>>)) {
        for (const d of def.duties as string[]) {
          expect(retired, `${id} L${lvl} still routes to retired duty ${d}`).not.toContain(d);
        }
      }
    }
  });
});

describe("levels get harder, never easier", () => {
  for (const [id, flow] of Object.entries(flows)) {
    const levels = Object.keys(flow.levels as object).sort();
    if (levels.length < 2) continue;
    it(`${id} adds work as the level rises`, () => {
      let prev = -1;
      for (const lvl of levels) {
        const n = ((flow.levels as Record<string, { duties: string[] }>)[lvl].duties ?? []).length;
        expect(n, `${id} L${lvl} runs fewer duties than the level below`).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
    });
  }
});

describe("the brief's required coverage", () => {
  // §6 names a minimum set. Each maps to a flow; a missing one means a shape of
  // real work has no home.
  const required: [string, string][] = [
    ["coding: full feature", "feature"],
    ["coding: small change or fix", "fix"],
    ["automations", "automation"],
    ["simple task", "task"],
    ["discussion", "discussion"],
    ["research or investigation", "research"],
    ["media (image)", "image"],
    ["media (video)", "video"],
    ["maintenance and chores", "chore"]
  ];
  for (const [label, id] of required) {
    it(`covers ${label}`, () => {
      expect(Object.keys(flows), `no flow for ${label}`).toContain(id);
    });
  }

  it("covers the two clusters the mining found that the brief did not name", () => {
    // QA sweep -> batch fix had ~8 real cards and ZERO config support; comms
    // follow-up had ~6 and is folded into `task` because it is one action with
    // an outbound side effect.
    expect(Object.keys(flows)).toContain("qa-sweep");
    expect(String(flows.task.cluster)).toMatch(/comms/i);
  });
});

describe("the cheap path is actually cheap", () => {
  it("fix L1 is two duties and no evidence ceremony", () => {
    // This is the shape most likely to be done in a raw session instead, so if
    // it is not fast it will not be used, and the whole run fails its own test.
    const l1 = (flows.fix.levels as Record<string, { duties: string[]; evidence: string }>)["1"];
    expect(l1.duties).toEqual(["implement", "test"]);
    expect(l1.evidence).toBe("logs");
  });

  it("task L1 is one duty with no evidence and no board ceremony", () => {
    const l1 = (flows.task.levels as Record<string, { duties: string[]; evidence: string }>)["1"];
    expect(l1.duties).toHaveLength(1);
    expect(l1.evidence).toBe("none");
  });

  it("discussion L1 produces no artefact", () => {
    const l1 = (flows.discussion.levels as Record<string, { duties: string[]; evidence: string }>)["1"];
    expect(l1.duties).toEqual(["discuss"]);
    expect(l1.evidence).toBe("none");
  });
});

describe("the expensive path is actually thorough", () => {
  it("feature L3 carries the adversarial passes and a walkthrough video", () => {
    const l3 = (flows.feature.levels as Record<string, { duties: string[]; evidence: string; pins: Record<string, number> }>)["3"];
    for (const d of ["adversarial-review", "adversarial-test", "ux-qa", "walkthrough"]) {
      expect(l3.duties, `feature L3 missing ${d}`).toContain(d);
    }
    expect(l3.evidence).toBe("video");
    // The pins are the point of the mechanism: at flow level 3 the adversarial
    // passes run at duty level 3 regardless.
    expect(l3.pins["adversarial-review"]).toBe(3);
  });
});

describe("rails resolve from the flow level", () => {
  const policy = compilePolicy(cfg, cfg.activeProfile ?? null);
  const on = (flow: string, level: number | null) =>
    policyCore
      .railFor(policy, flow, null, level)
      .phases.filter((p: { on: boolean }) => p.on)
      .map((p: { id: string }) => p.id);

  it("gives a different rail per level of the same flow", () => {
    expect(on("fix", 1)).toEqual(["implement", "test"]);
    expect(on("fix", 3)).toEqual(["plan", "implement", "test", "review", "adversarial-review"]);
  });

  it("falls back to the flow's own default level, not to the cheapest or the dearest", () => {
    expect(on("fix", null)).toEqual(on("fix", 1)); // fix defaults to 1
    expect(on("feature", null)).toEqual(on("feature", 2)); // feature defaults to 2
  });

  it("keeps every pipeline phase in the rail, rendered off — honesty, never hidden", () => {
    const rail = policyCore.railFor(policy, "fix", null, 1);
    const off = rail.phases.filter((p: { on: boolean }) => !p.on);
    expect(off.length).toBeGreaterThan(0);
    for (const p of off) expect(p.off_reason).toBeTruthy();
  });
});

describe("retired flow names still resolve", () => {
  it("maps the old library onto the new one", () => {
    // Two of the old nine flows were byte-identical clones of a third, made by a
    // UI duplicate action and never cleaned up.
    expect(policyCore.adoptFlow("full-feature")).toBe("feature");
    expect(policyCore.adoptFlow("full-feature-copy-2")).toBe("feature");
    expect(policyCore.adoptFlow("docs-change")).toBe("docs");
    expect(policyCore.adoptFlow("video-edit")).toBe("video");
  });

  it("leaves a current name alone and passes non-strings through", () => {
    expect(policyCore.adoptFlow("fix")).toBe("fix");
    expect(policyCore.adoptFlow(null)).toBeNull();
  });

  it("every alias target is a real flow", () => {
    for (const target of Object.values(policyCore.FLOW_ALIASES as Record<string, string>)) {
      expect(Object.keys(flows), `alias points at missing flow ${target}`).toContain(target);
    }
  });
});
