import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MR0c — wire reconcile({trigger:"post-authoring"}) into the quarters file.*
// actions. reconcile() previously had NO production caller; now a successful
// authoring of a loose file primitive captures it into the Seed store so it can
// be promoted to owned. Satisfies brief §3 token `reconcile-wired-ok`.
//
// reconcile is mocked (spread over the real module so its other exports stay
// intact) so the wiring is asserted without real fitting emission. GARRISON_HOME
// is also sandboxed as belt-and-suspenders.

const { reconcileSpy } = vi.hoisted(() => ({ reconcileSpy: vi.fn() }));
vi.mock("@/lib/reconcile", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/reconcile")>();
  return { ...actual, reconcile: reconcileSpy };
});

import { runQuartersAction, type CrudResult } from "@/lib/quarters";

let claudeRoot: string;
let garrisonRoot: string;
let priorClaude: string | undefined;
let priorGarrison: string | undefined;

beforeEach(() => {
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  priorGarrison = process.env.GARRISON_HOME;
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-reconcile-claude-"));
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-reconcile-home-"));
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
  process.env.GARRISON_HOME = garrisonRoot;
  reconcileSpy.mockReset();
  reconcileSpy.mockResolvedValue({
    imported: [],
    skipped: [],
    suppressedEchoes: [],
    deferred: {},
    table: ""
  });
});
afterEach(() => {
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  if (priorGarrison === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorGarrison;
  fs.rmSync(claudeRoot, { recursive: true, force: true });
  fs.rmSync(garrisonRoot, { recursive: true, force: true });
});

describe("MR0c — reconcile('post-authoring') wired into quarters file.* actions", () => {
  it("file.create of a loose command triggers a scoped post-authoring reconcile", async () => {
    const r = (await runQuartersAction({
      action: "file.create",
      surface: "command",
      name: "mr0c-fixture",
      content: "do a thing"
    })) as CrudResult;
    expect(r.ok).toBe(true);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledWith({ trigger: "post-authoring", surfaces: ["command"] });
  });

  it("file.update triggers reconcile scoped to the touched surface", async () => {
    await runQuartersAction({ action: "file.create", surface: "skill", name: "mr0c-skill", content: "v1" });
    reconcileSpy.mockClear();
    const r = (await runQuartersAction({
      action: "file.update",
      surface: "skill",
      name: "mr0c-skill",
      content: "v2"
    })) as CrudResult;
    expect(r.ok).toBe(true);
    expect(reconcileSpy).toHaveBeenCalledWith({ trigger: "post-authoring", surfaces: ["skill"] });
  });

  it("a failed file action does NOT trigger reconcile (only fires on ok)", async () => {
    await runQuartersAction({ action: "file.create", surface: "command", name: "dup", content: "a" });
    reconcileSpy.mockClear();
    const again = (await runQuartersAction({
      action: "file.create",
      surface: "command",
      name: "dup",
      content: "b"
    })) as CrudResult;
    expect(again.ok).toBe(false);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });
});
