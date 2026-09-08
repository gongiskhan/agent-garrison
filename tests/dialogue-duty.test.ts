// The `dialogue` duty (D62): the one duty a person SPEAKS to.
//
// Zeca's standing conversation used to run unpinned, so a spoken "que horas
// são em Lisboa" opened the delivery loop - triage, triage again, plan on
// Sonnet, test - and what the phone finally read aloud was a `test` stretch's
// closing line, twice over. `dialogue` is the answer: one pass, one reply,
// never a handoff, and real work leaves the conversation as a card that runs
// its own loop somewhere the person is not listening.

import { describe, expect, it } from "vitest";
// @ts-ignore - pure .mjs module
import { applyFlowPolicy, dutyGuidanceFor } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";
// @ts-ignore - pure .mjs module
import { applyDutyHarnessProfile, DUTY_MCP_TOOLS, SHARED_MCP_TOOLS } from "../fittings/seed/http-gateway/scripts/lib/harness-profiles.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const COMPOSITION = path.resolve(__dirname, "..", "compositions", "default", "apm.yml");

function composition() {
  return (yaml.load(readFileSync(COMPOSITION, "utf8")) as any)["x-garrison"].composition;
}

describe("the dialogue duty in the composition", () => {
  it("is declared, selected, and pinned to one rung so it can never escalate off sonnet", () => {
    const comp = composition();
    const duty = comp.duties.find((d: any) => d.id === "dialogue");
    expect(duty, "declared beside the other duties").toBeTruthy();
    expect(comp.selected_duties, "unselected duties are refused by the exit gate").toContain("dialogue");
    // One level, one cell, and NO ladder/default/ceiling: kanban-model builds a
    // synthetic one-rung ladder from the level cell, so a tripwire cannot move
    // a spoken conversation onto opus mid-sentence.
    expect(duty.levels).toHaveLength(1);
    expect(duty.levels[0].cell).toEqual({ target: "cc-sonnet", effort: "medium" });
    expect(duty.ladder, "no named ladder").toBeUndefined();
    expect(duty.default).toBeUndefined();
    expect(duty.ceiling).toBeUndefined();
    // The description is routing bait AND behaviour text: dispatch prints it
    // verbatim in the duty menu and the stretch brief folds it into the prompt.
    expect(duty.description).toMatch(/never/i);
  });
});

describe("the flow policy", () => {
  const base = { store: { tail: () => [], all: () => [] }, selectedDuties: ["dialogue", "implement", "test", "plan"], cwd: null };

  it("leaves a dialogue done alone - there is no evidence to show for an answer", () => {
    const out = applyFlowPolicy("done", { ...base, duty: "dialogue" });
    expect(out).toEqual({ next: "done", rewritten: false, reason: null });
  });

  it("still rewrites a working duty's evidence-free done, so the exemption is dialogue's alone", () => {
    const out = applyFlowPolicy("done", { ...base, duty: "implement", handoff: {} });
    expect(out.rewritten).toBe(true);
    expect(out.reason).toBe("done-without-evidence");
    expect(out.next).toBe("test");
  });
});

describe("what a dialogue stretch is told and given", () => {
  it("carries the spoken register: a hard word cap, no markdown, European Portuguese", () => {
    const guidance = dutyGuidanceFor("dialogue");
    expect(guidance).toBeTruthy();
    expect(guidance).toMatch(/55 words/);
    expect(guidance).toMatch(/No markdown/i);
    expect(guidance).toMatch(/EUROPEAN/);
    // The escalation contract, in the same block that governs the tone.
    expect(guidance).toMatch(/garrison_create_card/);
    expect(guidance).toMatch(/"nextSteps\.next": "done"/);
  });

  it("is the only duty carrying the card tool, and still carries the shared three", () => {
    expect(DUTY_MCP_TOOLS.dialogue).toContain("garrison_create_card");
    for (const tool of SHARED_MCP_TOOLS) expect(DUTY_MCP_TOOLS.dialogue).toContain(tool);
    expect(SHARED_MCP_TOOLS, "a working stretch must not be able to spawn cards mid-flight").not.toContain(
      "garrison_create_card"
    );
    const route = applyDutyHarnessProfile(
      { targetId: "cc-sonnet", target: { id: "cc-sonnet", runtime: "agent-sdk", model: "claude-sonnet-5" }, duty: "dialogue", level: 1 },
      "dialogue"
    );
    expect(route.target.mcpTools).toContain("garrison_create_card");
  });
});
