import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graduationPlanFor, graduateStep, specRelPath } from "../fittings/seed/drill/lib/graduate.mjs";
import { savePage, getPage } from "../fittings/seed/drill/lib/store.mjs";

let dir: string;
let ghome: string;
const prevGarrisonHome = process.env.GARRISON_HOME;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-graduate-"));
  // GARRISON_HOME must be isolated too: the store resolves its root through
  // activeProjectRoot() FIRST, and the real ~/.garrison carries the live
  // UI's project selection - without this pin the test reads whatever repo
  // the user last selected instead of `dir`.
  ghome = mkdtempSync(path.join(tmpdir(), "garrison-graduate-home-"));
  process.env.GARRISON_DRILL_TARGET_REPO = dir;
  process.env.GARRISON_HOME = ghome;
});
afterEach(() => {
  delete process.env.GARRISON_DRILL_TARGET_REPO;
  if (prevGarrisonHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevGarrisonHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(ghome, { recursive: true, force: true });
});

describe("graduationPlanFor", () => {
  it("nothing to graduate when the outcome isn't a completed vision/recovered pass", () => {
    expect(graduationPlanFor({ id: "s1" }, null)).toBeNull();
    expect(graduationPlanFor({ id: "s1" }, { status: "failed", tier: "vision" })).toBeNull();
    expect(graduationPlanFor({ id: "s1" }, { status: "completed", tier: "cached" })).toBeNull();
  });
  it("a judgment-marked step graduates to judgment=true even when a deterministic assertion was also found", () => {
    const plan = graduationPlanFor({ id: "s1", judgment: true }, { status: "completed", tier: "vision", result: { assertion: { kind: "visible", testId: "x" } } });
    expect(plan).toEqual({ judgment: true });
  });
  it("a non-judgment step graduates using the outcome's discovered assertion", () => {
    const plan = graduationPlanFor({ id: "s1" }, { status: "completed", tier: "vision", result: { assertion: { kind: "text-contains", text: "sent" } } });
    expect(plan).toEqual({ assertion: { kind: "text-contains", text: "sent" } });
  });
  it("nothing to graduate when vision passed but produced no assertion and it isn't a judgment step", () => {
    expect(graduationPlanFor({ id: "s1" }, { status: "completed", tier: "vision", result: {} })).toBeNull();
  });
  it("a recovered (healed) pass graduates too — the re-emission path (B7)", () => {
    const plan = graduationPlanFor({ id: "s1" }, { status: "completed", tier: "recovered", result: { assertion: { kind: "visible", testId: "y" } } });
    expect(plan).toEqual({ assertion: { kind: "visible", testId: "y" } });
  });
});

describe("graduateStep", () => {
  const book = { app: { name: "f", url: "http://localhost:3000" } };

  it("flips mode to e2e, stores the assertion, sets spec, and writes the spec file", async () => {
    await savePage("chat", { title: "Chat", path: "/chat", steps: [{ id: "s1", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "answer visible", tags: [] }] });
    const { step, specFile } = await graduateStep(book, "chat", "s1", { assertion: { kind: "visible", testId: "answer" } });
    expect(step).toMatchObject({ mode: "e2e", spec: `${specRelPath("chat")}#s1`, assertion: { kind: "visible", testId: "answer" } });
    expect(specFile).toBe(path.join(dir, "tests", "drills", "chat.spec.ts"));
    expect(existsSync(specFile)).toBe(true);
    const src = readFileSync(specFile, "utf8");
    expect(src).toContain('await expect(page.getByTestId("answer")).toBeVisible();');

    const reloaded = await getPage("chat");
    expect(reloaded?.steps[0]).toMatchObject({ mode: "e2e", assertion: { kind: "visible", testId: "answer" } });
  });

  it("a judgment plan writes the drill-judge support asset and a drillJudge() call, with no assertion stored", async () => {
    await savePage("kb", { title: "Knowledge base", path: "/kb", steps: [{ id: "s2", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "citations look right", tags: [] }] });
    const { step } = await graduateStep(book, "kb", "s2", { judgment: true });
    expect(step.mode).toBe("e2e");
    expect(step.judgment).toBe(true);
    expect(step.assertion).toBeUndefined();

    const supportFile = path.join(dir, "tests", "drills", "support", "drill-judge.ts");
    expect(existsSync(supportFile)).toBe(true);
    expect(readFileSync(supportFile, "utf8")).toContain("export async function drillJudge");

    const specSrc = readFileSync(path.join(dir, "tests", "drills", "kb.spec.ts"), "utf8");
    expect(specSrc).toContain("drillJudge(page,");
  });

  it("re-graduating (the healer path) overwrites the assertion and re-emits the whole page spec", async () => {
    await savePage("chat", { title: "Chat", path: "/chat", steps: [{ id: "s1", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "answer visible", tags: [] }] });
    await graduateStep(book, "chat", "s1", { assertion: { kind: "visible", testId: "stale-id" } });
    const { step } = await graduateStep(book, "chat", "s1", { assertion: { kind: "visible", testId: "fresh-id" } });
    expect(step.assertion).toEqual({ kind: "visible", testId: "fresh-id" });
    const src = readFileSync(path.join(dir, "tests", "drills", "chat.spec.ts"), "utf8");
    expect(src).toContain("fresh-id");
    expect(src).not.toContain("stale-id");
  });

  it("preserves OTHER already-graduated steps on the same page when re-emitting", async () => {
    await savePage("chat", {
      title: "Chat", path: "/chat",
      steps: [
        { id: "s1", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "a", assertion: { kind: "text-contains", text: "a" }, tags: [] },
        { id: "s2", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "b", tags: [] }
      ]
    });
    await graduateStep(book, "chat", "s2", { assertion: { kind: "text-contains", text: "b" } });
    const src = readFileSync(path.join(dir, "tests", "drills", "chat.spec.ts"), "utf8");
    expect(src).toContain('"a"');
    expect(src).toContain('"b"');
  });

  it("throws when the page or step doesn't exist, or the plan is empty", async () => {
    await expect(graduateStep(book, "missing", "s1", { assertion: { kind: "text-contains", text: "x" } })).rejects.toThrow(/page not found/);
    await savePage("chat", { title: "Chat", path: "/chat", steps: [] });
    await expect(graduateStep(book, "chat", "nope", { assertion: { kind: "text-contains", text: "x" } })).rejects.toThrow(/step not found/);
    await savePage("chat", { steps: [{ id: "s1", area: 0, mode: "vision", enabled: true, state: "default", viewports: [], description: "x", tags: [] }] });
    await expect(graduateStep(book, "chat", "s1", {})).rejects.toThrow(/requires an assertion or judgment/);
  });
});
