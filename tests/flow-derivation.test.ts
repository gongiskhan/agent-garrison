// Deriving the flow a routed duty belongs to.
//
// This is the gap that kept the whole flow layer unused. The router picked a
// duty and a level, the card carried both, and `flow` stayed null forever
// because only an explicit client pin ever set it — 2 of 90 live cards had a
// flow, and none ever ran a phased plan. Deriving it deterministically is what
// makes a flow arrive on a card at all.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs fitting module, no types
import { defaultFlowForDuty } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "compositions/default/.garrison/routing.json"), "utf8")
);

describe("defaultFlowForDuty", () => {
  it("routes the everyday duties to the flow that owns them", () => {
    expect(defaultFlowForDuty(cfg, "implement")).toBe("fix");
    expect(defaultFlowForDuty(cfg, "discuss")).toBe("discussion");
    expect(defaultFlowForDuty(cfg, "drill")).toBe("qa-sweep");
    expect(defaultFlowForDuty(cfg, "research")).toBe("research");
    expect(defaultFlowForDuty(cfg, "writing")).toBe("docs");
    expect(defaultFlowForDuty(cfg, "image")).toBe("image");
    expect(defaultFlowForDuty(cfg, "other")).toBe("task");
  });

  it("NEVER derives a manual flow", () => {
    // `personal` runs no agent duties by design, so inferring it would silently
    // park work that was meant to run.
    for (const duty of cfg.taskTypes) {
      expect(defaultFlowForDuty(cfg, duty), `${duty} derived the manual flow`).not.toBe("personal");
    }
  });

  it("is deterministic — the same duty always lands on the same flow", () => {
    for (const duty of cfg.taskTypes) {
      const first = defaultFlowForDuty(cfg, duty);
      for (let i = 0; i < 5; i++) expect(defaultFlowForDuty(cfg, duty)).toBe(first);
    }
  });

  it("only ever names a real, non-manual flow", () => {
    for (const duty of cfg.taskTypes) {
      const flow = defaultFlowForDuty(cfg, duty);
      if (flow === null) continue;
      expect(Object.keys(cfg.flows), `${duty} -> unknown flow ${flow}`).toContain(flow);
      expect(cfg.flows[flow].manual).not.toBe(true);
    }
  });

  it("prefers the flow that runs the duty at the EARLIEST level", () => {
    const flows = {
      early: { levels: { "1": { duties: ["thing"] } } },
      late: { levels: { "1": { duties: ["other"] }, "3": { duties: ["thing"] } } }
    };
    expect(defaultFlowForDuty({ flows }, "thing")).toBe("early");
  });

  it("breaks a tie toward the default flow before position or name", () => {
    // Without this, `review` landed on `docs` purely because a shorter duty list
    // put it at an earlier index — which is arithmetic, not meaning.
    const flows = {
      alpha: { levels: { "2": { duties: ["review"] } } },
      zulu: { levels: { "2": { duties: ["implement", "test", "review"] } } }
    };
    expect(defaultFlowForDuty({ flows, defaultFlow: "zulu" }, "review")).toBe("zulu");
    expect(defaultFlowForDuty({ flows }, "review")).toBe("alpha"); // no default: position wins
  });

  it("returns null rather than guessing", () => {
    expect(defaultFlowForDuty(cfg, "not-a-duty")).toBeNull();
    expect(defaultFlowForDuty(cfg, null)).toBeNull();
    expect(defaultFlowForDuty(null, "implement")).toBeNull();
    expect(defaultFlowForDuty({}, "implement")).toBeNull();
  });

  it("ignores a flow with no levels (the legacy single-plan shape)", () => {
    expect(defaultFlowForDuty({ flows: { old: { phasePlan: "full" } } }, "implement")).toBeNull();
  });
});
