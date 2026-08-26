// Tests for the Kanban config/create UX changes:
//   - title is OPTIONAL (server derives it from the description) — deriveTitle
//   - per-list scheduler-beat schedule (beatCron) — applyListConfig + cronForList
//   - project + skill discovery (dev-env parity) — listProjects / listSkills
//
// The buildCardPrompt / processCard half of this file went out with the
// Conversations cut: there is no per-list dispatch to shape a prompt for.
import { describe, it, expect } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// S6 (D19): runDirs mint ABSOLUTE under the evidence home — sandbox it so
// tests never write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { deriveTitle, applyListConfig, applyProjectMapping, isValidProjectLabel } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { cronForList, beatIdFor } from "../fittings/seed/kanban-loop/lib/scheduler-beats.mjs";
// @ts-ignore — pure .mjs
import { listProjects, listSkills } from "../fittings/seed/kanban-loop/lib/discover.mjs";
// Nothing here touches the card store any more (the engine half of this file
// went out with the cut), so this file boots no state service.

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
        beatCron: "0 */5 * * *", skill: "garrison-test", mode: "joe", validNext: ["done"]
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
    expect(cronForList({ id: "test" })).toBe("0 */2 * * *");
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
    mkdirSync(join(home, "skills", "garrison-plan"), { recursive: true });
    writeFileSync(join(home, "skills", "garrison-plan", "SKILL.md"), "---\nname: garrison-plan\ndescription: Plan a slice.\n---\nbody");
    mkdirSync(join(home, "skills", "no-manifest"), { recursive: true }); // no SKILL.md → excluded
    const out = listSkills(home);
    expect(out.map((s: any) => s.name)).toEqual(["garrison-plan"]);
    expect(out[0].description).toBe("Plan a slice.");
  });
});

describe("applyProjectMapping — the board.projects writer (F7)", () => {
  // Until PUT /projects/:label existed, board.projects had readers and no
  // writer: repoPathForProject consulted it FIRST and found it empty on every
  // box, so any card whose project label differed from its dev-root DIRECTORY
  // name (agent-garrison vs garrison) ran unfenced with no revert target.
  it("sets a mapping without touching the rest of the board", () => {
    const board = fakeBoard();
    const out = applyProjectMapping(board, "agent-garrison", "/home/u/dev/garrison");
    expect(out.projects["agent-garrison"]).toEqual({ path: "/home/u/dev/garrison" });
    expect(out.lists).toBe(board.lists);
  });
  it("null removes exactly that label", () => {
    const withTwo = applyProjectMapping(
      applyProjectMapping(fakeBoard(), "a", "/x"), "b", "/y");
    const out = applyProjectMapping(withTwo, "a", null);
    expect(out.projects).toEqual({ b: { path: "/y" } });
  });
  it("overwrites in place and preserves unknown mapping fields", () => {
    const seeded = { ...fakeBoard(), projects: { a: { path: "/old", note: "kept" } } };
    const out = applyProjectMapping(seeded, "a", "/new");
    expect(out.projects.a).toEqual({ path: "/new", note: "kept" });
  });
  it("label discipline: path-ish and traversal-ish labels are refused as keys", () => {
    expect(isValidProjectLabel("agent-garrison")).toBe(true);
    expect(isValidProjectLabel("ekoa.code_2")).toBe(true);
    expect(isValidProjectLabel("/abs/path")).toBe(false);
    expect(isValidProjectLabel("../up")).toBe(false);
    expect(isValidProjectLabel(".hidden")).toBe(false);
    expect(isValidProjectLabel(" padded")).toBe(false);
    expect(isValidProjectLabel("")).toBe(false);
  });
});
