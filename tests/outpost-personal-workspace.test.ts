import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore — fitting source modules are plain ESM.
import { PERSONAL_POLICY_FILES, PERSONAL_WORKSPACE_POLICY } from "../fittings/seed/kanban-loop/lib/personal-workspace.mjs";
// @ts-ignore — worker source module is plain ESM.
import { ensureOutpostPersonalWorkspace, OUTPOST_PERSONAL_POLICY, OUTPOST_PERSONAL_POLICY_FILES } from "../fittings/seed/outpost-worker/scripts/personal-workspace.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Outpost personal execution parity", () => {
  it("locks remote policy and runtime-native filenames to the host workspace", () => {
    expect(OUTPOST_PERSONAL_POLICY).toBe(PERSONAL_WORKSPACE_POLICY);
    expect(OUTPOST_PERSONAL_POLICY_FILES).toEqual(PERSONAL_POLICY_FILES);
  });

  it("creates one private non-repository workspace beside the worker config", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "outpost-personal-"));
    roots.push(root);
    const configPath = path.join(root, ".garrison-outpost", "worker.json");
    const workspace = await ensureOutpostPersonalWorkspace({ configPath });

    expect(workspace).toBe(path.join(root, ".garrison-outpost", "personal"));
    expect(lstatSync(workspace).isSymbolicLink()).toBe(false);
    expect(statSync(workspace).mode & 0o777).toBe(0o700);
    for (const filename of OUTPOST_PERSONAL_POLICY_FILES) {
      expect(readFileSync(path.join(workspace, filename), "utf8")).toBe(PERSONAL_WORKSPACE_POLICY);
      expect(statSync(path.join(workspace, filename)).mode & 0o777).toBe(0o600);
    }

    writeFileSync(path.join(workspace, "AGENTS.md"), "operator-owned\n");
    await expect(ensureOutpostPersonalWorkspace({ configPath })).resolves.toBe(workspace);
    expect(readFileSync(path.join(workspace, "AGENTS.md"), "utf8")).toBe("operator-owned\n");
  });

  it("refuses a personal workspace that has been turned into a Git checkout", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "outpost-personal-git-"));
    roots.push(root);
    const configPath = path.join(root, ".garrison-outpost", "worker.json");
    const workspace = await ensureOutpostPersonalWorkspace({ configPath });
    mkdirSync(path.join(workspace, ".git"));
    await expect(ensureOutpostPersonalWorkspace({ configPath })).rejects.toThrow(/must not be a Git repository/);
  });
});
