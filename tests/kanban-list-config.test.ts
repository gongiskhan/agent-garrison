// Unit tests for applyListConfig — the PURE list-config validator/updater behind
// PATCH /lists/:listId (FINDING 5: "no way to configure the lists"). Drives the
// happy path (edit an agent list's skill/prompts/validNext/trigger and confirm
// the mutated board) and every validation reject (unknown list, validNext to a
// non-existent list, bad trigger, newline/traversal in taskType/skill, and
// editing an agent-only field on a manual list), plus the structure invariant
// (id/order/kind never change). Hermetic — no socket, no filesystem.

import { describe, it, expect } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Plain ESM .mjs with no .d.ts — import via a non-literal specifier so tsc
// treats it as `any` (same convention as tests/kanban-board-ui.test.ts).
const SERVER = "../fittings/seed/kanban-loop/scripts/server.mjs";
const { applyListConfig, isValidListId } = await import(SERVER);
const BOARD_LIB = "../fittings/seed/kanban-loop/lib/board.mjs";
const { saveBoardCAS, loadBoard, atomicWriteJSON } = await import(BOARD_LIB);

// A small board: one manual list, one agent list, one interactive (Discuss).
function fakeBoard() {
  return {
    version: 2,
    lists: [
      { id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual", validNext: ["todo"] },
      { id: "todo", title: "To Do", order: 1, kind: "manual", trigger: "manual", validNext: ["plan"] },
      {
        id: "discuss", title: "Discuss", order: 2, kind: "agent-interactive", trigger: "manual",
        skill: null, interactive: true, mode: "james", validNext: ["plan"]
      },
      {
        id: "plan", title: "Plan", order: 3, kind: "agent", trigger: "immediate",
        skill: "garrison-plan", taskType: "code", tier: "T2-deep", mode: "james",
        executePrompt: "old execute", routerPrompt: "old router", validNext: ["implement"]
      },
      {
        id: "implement", title: "Implement", order: 4, kind: "agent", trigger: "immediate",
        skill: "garrison-implement", taskType: "code", tier: "T2-deep", mode: "joe",
        executePrompt: "impl execute", routerPrompt: "impl router", validNext: ["plan"]
      }
    ]
  };
}

describe("applyListConfig — happy path (agent list)", () => {
  it("edits an agent list's prompts, validNext and trigger and returns the mutated board", () => {
    const board = fakeBoard();
    const { board: next, list, error } = applyListConfig(board, "plan", {
      executePrompt: "new execute prompt",
      routerPrompt: "new router prompt",
      validNext: ["implement", "plan"],
      trigger: "manual"
    });
    expect(error).toBeUndefined();
    expect(list.executePrompt).toBe("new execute prompt");
    expect(list.routerPrompt).toBe("new router prompt");
    expect(list.validNext).toEqual(["implement", "plan"]);
    expect(list.trigger).toBe("manual");
    // The mutated board reflects the change at the same index.
    const onBoard = next.lists.find((l: any) => l.id === "plan");
    expect(onBoard.executePrompt).toBe("new execute prompt");
    expect(onBoard.trigger).toBe("manual");
  });

  it("does not mutate the input board (returns a new object)", () => {
    const board = fakeBoard();
    const before = JSON.stringify(board);
    applyListConfig(board, "plan", { executePrompt: "x" });
    expect(JSON.stringify(board)).toBe(before);
  });

  it("applies ONLY the fields present in the patch", () => {
    const board = fakeBoard();
    const { list } = applyListConfig(board, "plan", { title: "Planning" });
    expect(list.title).toBe("Planning");
    // Untouched fields keep their seed values.
    expect(list.executePrompt).toBe("old execute");
    expect(list.validNext).toEqual(["implement"]);
  });

  it("REJECTS the dead per-list keys (D15: skill/mode/taskType/tier live in the policy)", () => {
    const board = fakeBoard();
    for (const dead of ["skill", "mode", "taskType", "tier"]) {
      const { error } = applyListConfig(board, "plan", { [dead]: "anything" });
      expect(error).toContain("no longer a per-list setting");
    }
  });

  it("de-dupes validNext while preserving order", () => {
    const board = fakeBoard();
    const { list } = applyListConfig(board, "plan", { validNext: ["implement", "implement", "plan"] });
    expect(list.validNext).toEqual(["implement", "plan"]);
  });
});

describe("applyListConfig — interactive list", () => {
  it("keeps interactive:true; the dead mode key is rejected (D15)", () => {
    const board = fakeBoard();
    const ok = applyListConfig(board, "discuss", { title: "Discuss it" });
    expect(ok.error).toBeUndefined();
    expect(ok.list.interactive).toBe(true);
    expect(ok.list.title).toBe("Discuss it");
    const bad = applyListConfig(board, "discuss", { mode: "james-v2" });
    expect(bad.error).toContain("no longer a per-list setting");
  });
});

describe("applyListConfig — validation rejects", () => {
  it("rejects an unknown listId", () => {
    const board = fakeBoard();
    const { error, board: next } = applyListConfig(board, "nope", { title: "x" });
    expect(error).toMatch(/unknown list/);
    expect(next).toBeUndefined();
  });

  it("rejects a validNext containing a non-existent list id", () => {
    const board = fakeBoard();
    const { error } = applyListConfig(board, "plan", { validNext: ["implement", "ghost"] });
    expect(error).toMatch(/unknown list: ghost/);
  });

  it("rejects a bad trigger", () => {
    const board = fakeBoard();
    const { error } = applyListConfig(board, "plan", { trigger: "whenever" });
    expect(error).toMatch(/trigger must be one of/);
  });

  it("rejects a newline in taskType (no injection)", () => {
    const board = fakeBoard();
    const { error } = applyListConfig(board, "plan", { taskType: "code\nrm -rf" });
    expect(error).toMatch(/taskType/);
  });

  it("rejects a path separator / traversal in taskType", () => {
    const board = fakeBoard();
    expect(applyListConfig(board, "plan", { taskType: "../etc" }).error).toMatch(/taskType/);
    expect(applyListConfig(board, "plan", { tier: "a/b" }).error).toMatch(/tier/);
  });

  it("rejects a dirty skill token (whitespace / separators / traversal)", () => {
    const board = fakeBoard();
    expect(applyListConfig(board, "plan", { skill: "bad skill" }).error).toMatch(/skill/);
    expect(applyListConfig(board, "plan", { skill: "../x" }).error).toMatch(/skill/);
    expect(applyListConfig(board, "plan", { skill: "a/b" }).error).toMatch(/skill/);
  });

  it("rejects the skill key entirely (D15 — bindings live in the policy)", () => {
    const board = fakeBoard();
    const { error } = applyListConfig(board, "plan", { skill: "garrison-plan:v2" });
    expect(error).toContain("no longer a per-list setting");
  });

  it("rejects a non-array validNext", () => {
    const board = fakeBoard();
    expect(applyListConfig(board, "plan", { validNext: "implement" as any }).error).toMatch(/validNext/);
  });

  it("rejects an empty title", () => {
    const board = fakeBoard();
    expect(applyListConfig(board, "plan", { title: "   " }).error).toMatch(/title/);
  });

  it("rejects a non-object patch", () => {
    const board = fakeBoard();
    expect(applyListConfig(board, "plan", null).error).toMatch(/patch/);
    expect(applyListConfig(board, "plan", ["x"] as any).error).toMatch(/patch/);
  });
});

describe("applyListConfig — manual list is title + validNext only", () => {
  it("lets a manual list edit title and validNext", () => {
    const board = fakeBoard();
    const { error, list } = applyListConfig(board, "backlog", { title: "Inbox", validNext: ["todo", "plan"] });
    expect(error).toBeUndefined();
    expect(list.title).toBe("Inbox");
    expect(list.validNext).toEqual(["todo", "plan"]);
  });

  it("rejects editing skill on a manual list", () => {
    const board = fakeBoard();
    expect(applyListConfig(board, "backlog", { skill: "garrison-plan" }).error).toMatch(/manual list/);
  });

  it("rejects editing executePrompt / routerPrompt / trigger / mode / taskType / tier on a manual list", () => {
    const board = fakeBoard();
    for (const patch of [
      { executePrompt: "x" },
      { routerPrompt: "x" },
      { trigger: "immediate" },
      { mode: "joe" },
      { taskType: "code" },
      { tier: "T1-standard" }
    ]) {
      expect(applyListConfig(board, "backlog", patch).error).toMatch(/manual list/);
    }
  });
});

describe("applyListConfig — structure is immutable", () => {
  it("never changes id, order or kind", () => {
    const board = fakeBoard();
    const { list } = applyListConfig(board, "plan", {
      // Even if a caller smuggles structural keys in the patch, they must not apply.
      ...( { id: "hacked", order: 99, kind: "manual" } as any ),
      title: "Plan!"
    });
    expect(list.id).toBe("plan");
    expect(list.order).toBe(3);
    expect(list.kind).toBe("agent");
    expect(list.title).toBe("Plan!");
  });
});

describe("isValidListId", () => {
  it("accepts clean kebab ids and rejects traversal / separators", () => {
    expect(isValidListId("adversarial-review")).toBe(true);
    expect(isValidListId("plan")).toBe(true);
    expect(isValidListId("../etc")).toBe(false);
    expect(isValidListId("a/b")).toBe(false);
    expect(isValidListId("")).toBe(false);
    expect(isValidListId("..")).toBe(false);
    expect(isValidListId(null as any)).toBe(false);
  });
});

// saveBoardCAS — the true critical section behind PATCH /lists/:listId. The bare
// load+check+save had a TOCTOU race (two writers both read rev 0, both save); this
// proves the board lock serializes them so exactly one same-rev edit wins.
describe("saveBoardCAS — board-rev compare-and-swap (no lost update)", () => {
  it("two concurrent same-rev edits: exactly one wins, the other conflicts, rev advances once", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-cas-"));
    await atomicWriteJSON(`${root}/board.json`, fakeBoard()); // rev undefined → treated as 0
    const [a, b] = await Promise.all([
      saveBoardCAS(root, 0, (board: any) => applyListConfig(board, "plan", { title: "A" })),
      saveBoardCAS(root, 0, (board: any) => applyListConfig(board, "plan", { title: "B" }))
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);        // one save succeeded
    expect([a, b].filter((r) => r.conflict).length).toBe(1);  // the other got a conflict
    const disk = await loadBoard(root);
    expect(disk.rev).toBe(1);                                  // rev advanced EXACTLY once
  });

  it("a stale expectedRev conflicts; a fresh one succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-cas2-"));
    await atomicWriteJSON(`${root}/board.json`, fakeBoard());
    const first = await saveBoardCAS(root, 0, (board: any) => applyListConfig(board, "plan", { title: "First" }));
    expect(first.ok).toBe(true);
    expect(first.rev).toBe(1);
    const stale = await saveBoardCAS(root, 0, (board: any) => applyListConfig(board, "plan", { title: "Stale" }));
    expect(stale.conflict).toBe(true);
    const fresh = await saveBoardCAS(root, 1, (board: any) => applyListConfig(board, "plan", { title: "Fresh" }));
    expect(fresh.ok).toBe(true);
    expect((await loadBoard(root)).lists.find((l: any) => l.id === "plan").title).toBe("Fresh");
  });
});
