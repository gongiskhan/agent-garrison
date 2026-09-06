import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { manifestToComposition } from "@/lib/compositions";
import { computeKanbanResolvedModel, type KanbanResolvedModel } from "@/lib/kanban-model";
import { readYamlFile } from "@/lib/yaml";
import { compositionManifestPath } from "./helpers/shipped-compositions";
// @ts-ignore — runtime consumers are pure .mjs modules.
import { executionRouteFor } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — exercise the same rung choice used by normal Conversations.
import { ladderForDuty, resolveRung } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";
// @ts-ignore — table routing follows rung choice in the normal stretch lane.
import { applyRouteRow, pickRoute } from "../fittings/seed/http-gateway/scripts/lib/routing-table.mjs";

let model: KanbanResolvedModel;
const table = JSON.parse(readFileSync(path.join(__dirname, "../compositions/default/.garrison/routing-table.json"), "utf8"));

beforeAll(async () => {
  const manifest = await readYamlFile<Parameters<typeof manifestToComposition>[1]>(compositionManifestPath("default"));
  if (!manifest) throw new Error("default composition missing");
  model = computeKanbanResolvedModel(manifestToComposition("default", manifest), []);
});

describe("default ChatGPT duty execution", () => {
  it.each([
    ["plan", 3, "gpt-6-astra", "max"],
    ["review", 3, "gpt-6-astra", "high"],
    ["test", 2, "gpt-5.6-sol", "medium"],
    ["validate", 1, "gpt-5.6-sol", "medium"],
    ["report", 2, "gpt-5.6-sol", "low"]
  ])("resolves the %s L%i assigned cell to the subscription runtime", (duty, level, expectedModel, effort) => {
    const route = executionRouteFor({ duty, level }, model);
    expect(route?.target).toMatchObject({
      runtime: "codex", provider: "chatgpt-subscription", model: expectedModel,
      authMode: "subscription", effort
    });
  });

  it.each([
    ["plan", "gpt-6-astra"], ["review", "gpt-6-astra"],
    ["test", "gpt-5.6-sol"], ["validate", "gpt-5.6-sol"], ["report", "gpt-5.6-sol"]
  ])("normal %s Conversations uses the intended default after rung and table resolution", async (duty, expectedModel) => {
    const gateway = { executionModel: async () => model };
    const ladder = await ladderForDuty(gateway, duty, 2);
    const picked = resolveRung({ ladder });
    expect(picked?.chosenBy).toBe("default");
    const rung = picked.rung;
    let route = { targetId: rung.target, target: { ...rung.params, runtime: rung.runtime, provider: rung.provider, model: rung.model } };
    const rows = table.duties[duty];
    if (rows) {
      // Far-future time ignores the user's temporary account-cooling file.
      const choice = pickRoute({ rows, duty, now: 8.64e15 });
      expect(choice?.reason).toBe("default");
      route = applyRouteRow(route, choice.row);
    }
    expect(route.target).toMatchObject({ runtime: "codex", provider: "chatgpt-subscription", model: expectedModel });
  });

  it("keeps a different model family available when reviewing Codex implementation", () => {
    const choice = pickRoute({ rows: table.duties.review, duty: "review", avoidFamily: "gpt", now: 8.64e15 });
    expect(choice?.reason).toBe("cross-family");
    expect(choice?.row.model).toBe("claude-sonnet-5");
  });

  it("keeps interactive dialogue and dispatch on their existing engines", () => {
    expect(executionRouteFor({ duty: "dialogue", level: 1 }, model)?.target.runtime).toBe("agent-sdk");
    expect(executionRouteFor({ duty: "dispatch", level: 1 }, model)?.target.model).toBe("claude-haiku-4-5");
  });
});
