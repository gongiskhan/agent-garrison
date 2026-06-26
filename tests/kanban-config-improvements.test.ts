// Tests for the Kanban config/create UX changes:
//   - title is OPTIONAL (server derives it from the description) — deriveTitle
//   - per-list scheduler-beat schedule (beatCron) — applyListConfig + cronForList
//   - project + skill discovery (dev-env parity) — listProjects / listSkills
//   - the dispatch routes through the orchestrator (no per-list {taskType,tier} hint)
//     and leads the prompt with the list's mode — buildCardPrompt + processCard
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { deriveTitle, applyListConfig } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { cronForList, beatIdFor } from "../fittings/seed/kanban-loop/lib/scheduler-beats.mjs";
// @ts-ignore — pure .mjs
import { listProjects, listSkills } from "../fittings/seed/kanban-loop/lib/discover.mjs";
// @ts-ignore — pure .mjs
import { buildCardPrompt, processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("deriveTitle — infer a card title from its description", () => {
  it("takes the first non-empty line, stripped of markdown markers", () => {
    expect(deriveTitle("Fix the SSO redirect loop\n\nmore detail")).toBe("Fix the SSO redirect loop");
    expect(deriveTitle("# A heading line")).toBe("A heading line");
    expect(deriveTitle("- a bullet item")).toBe("a bullet item");
    expect(deriveTitle("> quoted")).toBe("quoted");
  });
  it("caps a long line with an ellipsis", () => {
    const long = "x".repeat(120);
    const out = deriveTitle(long);
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns empty for an empty/whitespace description", () => {
    expect(deriveTitle("")).toBe("");
    expect(deriveTitle("   \n\n  ")).toBe("");
    expect(deriveTitle(null as any)).toBe("");
  });
});

function fakeBoard() {
  return {
    version: 2,
    lists: [
      { id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual", validNext: ["todo"] },
      {
        id: "test", title: "Test", order: 1, kind: "agent", trigger: "scheduler-beat",
        beatCron: "0 */5 * * *", skill: "autothing-test", mode: "joe", validNext: ["done"]
      },
      { id: "done", title: "Done", order: 2, kind: "manual", trigger: "manual", terminal: true, validNext: [] }
    ]
  };
}

describe("applyListConfig — beatCron (per-list scheduler-beat schedule)", () => {
  it("accepts a valid 5-field cron on an agent list", () => {
    const { list, error } = applyListConfig(fakeBoard(), "test", { beatCron: "30 9 * * 1" });
    expect(error).toBeUndefined();
    expect(list.beatCron).toBe("30 9 * * 1");
  });
  it("clears beatCron to null when blank", () => {
    const { list, error } = applyListConfig(fakeBoard(), "test", { beatCron: "  " });
    expect(error).toBeUndefined();
    expect(list.beatCron).toBeNull();
  });
  it("rejects a cron without 5 fields", () => {
    expect(applyListConfig(fakeBoard(), "test", { beatCron: "0 9 *" }).error).toMatch(/beatCron/);
  });
  it("rejects a cron with illegal characters", () => {
    expect(applyListConfig(fakeBoard(), "test", { beatCron: "0 9 * * rm" }).error).toMatch(/beatCron/);
  });
  it("rejects beatCron on a manual list", () => {
    expect(applyListConfig(fakeBoard(), "backlog", { beatCron: "0 9 * * *" }).error).toMatch(/manual list/);
  });
});

describe("scheduler-beats — cronForList / beatIdFor", () => {
  it("uses the list's own beatCron", () => {
    expect(cronForList({ id: "x", beatCron: "15 8 * * *" })).toBe("15 8 * * *");
  });
  it("falls back to the legacy default only for the seed Test list", () => {
    expect(cronForList({ id: "test" })).toBe("0 */5 * * *");
    expect(cronForList({ id: "other" })).toBeNull();
  });
  it("derives a stable beat id per list", () => {
    expect(beatIdFor("test")).toBe("kanban-test-beat");
  });
});

describe("discover — listProjects / listSkills (dev-env parity)", () => {
  it("lists only git repos one level under the dev-root, sorted by name", () => {
    const root = tmp("kanban-projects-");
    mkdirSync(join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(join(root, "beta", ".git"), { recursive: true });
    mkdirSync(join(root, "not-a-repo"), { recursive: true }); // no .git → excluded
    mkdirSync(join(root, ".hidden", ".git"), { recursive: true }); // dotdir → excluded
    const out = listProjects(root);
    expect(out.map((p: any) => p.name)).toEqual(["alpha", "beta"]);
    expect(out[0].path).toBe(join(root, "alpha"));
  });
  it("returns [] for a missing dev-root", () => {
    expect(listProjects(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });
  it("lists skills (dir with SKILL.md) and reads the frontmatter description", () => {
    const home = tmp("kanban-claude-");
    mkdirSync(join(home, "skills", "autothing-plan"), { recursive: true });
    writeFileSync(join(home, "skills", "autothing-plan", "SKILL.md"), "---\nname: autothing-plan\ndescription: Plan a slice.\n---\nbody");
    mkdirSync(join(home, "skills", "no-manifest"), { recursive: true }); // no SKILL.md → excluded
    const out = listSkills(home);
    expect(out.map((s: any) => s.name)).toEqual(["autothing-plan"]);
    expect(out[0].description).toBe("Plan a slice.");
  });
});

describe("buildCardPrompt — leads with the list's mode", () => {
  it("starts the prompt with the mode so the gateway switches the operative's face", () => {
    const board = seedBoard();
    const list = board.lists.find((l: any) => l.id === "implement"); // mode: joe
    const prompt = buildCardPrompt({ list, card: { title: "T", project: "p", description: "d" }, validNext: ["review"] });
    expect(prompt.startsWith("joe,")).toBe(true);
  });
  it("omits the mode lead when the list has no mode", () => {
    const list = { id: "x", kind: "agent", mode: null, executePrompt: "", routerPrompt: "" };
    const prompt = buildCardPrompt({ list, card: { title: "T" }, validNext: ["y"] });
    expect(prompt.startsWith("# Work item:")).toBe(true);
  });
});

describe("processCard — routes through the orchestrator (no per-list classification hint)", () => {
  it("dispatches with classification = null (the gateway/orchestrator classifies the tier)", async () => {
    const root = tmp("kanban-noclass-");
    const board = seedBoard();
    const card = await createCard(root, { title: "route me", project: "g", list: "plan" });
    let seen: any = "unset";
    const runFn = async ({ classification }: any) => { seen = classification; return { reply: "implement" }; };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(seen).toBeNull(); // NOT { taskType, tier } — the orchestrator owns classification
    expect((await loadCard(root, card.id)).list).toBe("implement");
  });
});
