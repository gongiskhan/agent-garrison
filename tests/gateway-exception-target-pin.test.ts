// The Drill vision regression (2026-08-06): the automations vision route asserts
// {taskType:"image", tier:"T1-standard", matchedException:"ex-automation-vision"}
// so its turns dodge the sec-gemini image cell (this box holds no gemini
// credentials — routing.json documents exactly that). The v4 dispatcher's
// compatibility migration translated taskType/tier onto a duty cell and dropped
// the matchedException on the floor, so a full run's 358 vision checks 502'd on
// "gemini exited 41". Pinned here: the exception's configured target rides the
// migration as a §7 target pin, an explicit caller pin still outranks it, and a
// classification without an exception keeps the duty cell untouched.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

const TARGETS: Record<string, any> = {
  "sec-gemini": { id: "sec-gemini", runtime: "gemini", model: "gemini-2.5-flash" },
  "cc-sonnet-med": {
    id: "cc-sonnet-med",
    runtime: "agent-sdk",
    provider: "anthropic",
    model: "sonnet",
    effort: "high"
  }
};

function executionModel() {
  return {
    duties: {
      image: {
        id: "image",
        title: "Image",
        description: "Create or edit images.",
        levels: [{ description: "generate or edit an image", cell: { target: "sec-gemini" } }]
      },
      other: {
        id: "other",
        title: "Other",
        description: "anything else",
        levels: [{ description: "any", cell: { target: "cc-sonnet-med" } }]
      }
    },
    selectedDuties: ["image", "other"]
  };
}

function bootGateway(logs: any[] = []) {
  const model = executionModel();
  const resolvedModelLib = {
    loadResolvedModel: () => model,
    resolveCardSequence: () => [],
    executionRouteFor: ({ duty, level }: any) => {
      const cell = (model.duties as any)[duty]?.levels[(level ?? 1) - 1]?.cell;
      if (!cell) return null;
      return { targetId: cell.target, target: { ...TARGETS[cell.target] }, phase: duty, skill: null };
    }
  };
  return new RoutedGateway({
    core: { decisionRecord: (x: any) => ({ ...x }), appendDecision: async () => {} },
    config: {
      taskTypes: ["image", "other"],
      tiers: ["T0-trivial", "T1-standard", "T2-deep"],
      exceptions: [
        { id: "ex-automation-vision", when: "caller-asserted by the automations vision route", target: "cc-sonnet-med" }
      ],
      targets: Object.values(TARGETS)
    },
    decisionsFile: join(mkdtempSync(join(tmpdir(), "gar-expin-")), "decisions.jsonl"),
    dispatcher: { core: {}, model, call: async () => ({ ok: false }) },
    executionModel: model,
    resolvedModelLib,
    logFn: (entry: any) => logs.push(entry)
  });
}

describe("caller-asserted exception rides the v4 migration as a target pin", () => {
  it("routes an explicit image classification carrying ex-automation-vision to the exception's target, not the duty cell", async () => {
    const logs: any[] = [];
    const gw = bootGateway(logs);
    const pre = await gw.preRoute("You are resolving a browser VERIFY step.", {
      classification: { taskType: "image", tier: "T1-standard", matchedException: "ex-automation-vision" }
    });
    expect(pre.duty).toBe("image");
    expect(pre.route.targetId).toBe("cc-sonnet-med");
    expect(pre.route.target.runtime).toBe("agent-sdk");
    expect(pre.overridesApplied).toContain("target");
    expect(logs.some((e) => e.kind === "duty-route-resolved" && e.target === "cc-sonnet-med")).toBe(true);
  });

  it("keeps the duty cell when the classification carries no exception", async () => {
    const gw = bootGateway();
    const pre = await gw.preRoute("make an image of a fox", {
      classification: { taskType: "image", tier: "T1-standard" }
    });
    expect(pre.route.targetId).toBe("sec-gemini");
    expect(pre.overridesApplied).toBeNull();
  });

  it("an explicit caller target pin outranks the exception's target", async () => {
    const gw = bootGateway();
    const pre = await gw.preRoute("You are resolving a browser VERIFY step.", {
      classification: { taskType: "image", tier: "T1-standard", matchedException: "ex-automation-vision" },
      routing: { target: "sec-gemini" }
    });
    expect(pre.route.targetId).toBe("sec-gemini");
  });

  it("an exception naming an unknown target is rejected and recorded, never silently honored", async () => {
    const logs: any[] = [];
    const gw = bootGateway(logs);
    (gw as any).config.exceptions = [{ id: "ex-automation-vision", target: "no-such-target" }];
    const pre = await gw.preRoute("You are resolving a browser VERIFY step.", {
      classification: { taskType: "image", tier: "T1-standard", matchedException: "ex-automation-vision" }
    });
    expect(pre.route.targetId).toBe("sec-gemini");
    expect(pre.overridesRejected).toEqual([{ field: "target", reason: "unknown-target" }]);
  });
});
