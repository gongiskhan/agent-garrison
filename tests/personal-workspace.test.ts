import { afterEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// @ts-ignore pure mjs
import { PERSONAL_POLICY_FILES, PERSONAL_SCOPE_TOKEN as KANBAN_PERSONAL_SCOPE_TOKEN, PERSONAL_WORKSPACE_POLICY, ensurePersonalWorkspace, resolvePersonalWorkspace, resolvePersonalWorkspaceSync } from "../fittings/seed/kanban-loop/lib/personal-workspace.mjs";
// @ts-ignore pure mjs
import { PERSONAL_SCOPE_TOKEN as GATEWAY_PERSONAL_SCOPE_TOKEN, resolveProjectName as gatewayResolveProjectName } from "../fittings/seed/http-gateway/scripts/lib/project-source.mjs";
// @ts-ignore pure mjs
import { resolveProjectName as kanbanResolveProjectName } from "../fittings/seed/kanban-loop/lib/discover.mjs";
// @ts-ignore pure mjs
import { cardWorkdir } from "../fittings/seed/kanban-loop/scripts/server.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


const roots: string[] = [];
const KANBAN_CLI = path.resolve(__dirname, "../fittings/seed/kanban-loop/scripts/kanban.mjs");
function tempHome(label: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), `garrison-${label}-`));
  roots.push(root);
  return root;
}

function makeRepo(dir: string) {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return realpathSync(dir);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("personal workspace setup", () => {
  it("creates one private stable directory with cross-runtime root policy", async () => {
    const home = tempHome("personal-setup");
    const workspace = await ensurePersonalWorkspace({ home });

    expect(workspace).toBe(path.join(home, "personal"));
    expect(statSync(workspace).mode & 0o777).toBe(0o700);
    expect(lstatSync(workspace).isSymbolicLink()).toBe(false);
    for (const filename of PERSONAL_POLICY_FILES) {
      const policy = path.join(workspace, filename);
      expect(readFileSync(policy, "utf8")).toBe(PERSONAL_WORKSPACE_POLICY);
      expect(statSync(policy).mode & 0o777).toBe(0o600);
    }
    expect(await resolvePersonalWorkspace({ home })).toBe(workspace);
    expect(resolvePersonalWorkspaceSync({ home })).toBe(workspace);
  });

  it("is idempotent and never overwrites operator policy", async () => {
    const home = tempHome("personal-idempotent");
    const workspace = await ensurePersonalWorkspace({ home });
    const policy = path.join(workspace, "AGENTS.md");
    writeFileSync(policy, "operator-owned\n");

    await expect(ensurePersonalWorkspace({ home })).resolves.toBe(workspace);
    expect(readFileSync(policy, "utf8")).toBe("operator-owned\n");
  });

  it("rejects a symlink or file instead of repairing/following it", async () => {
    const outside = tempHome("personal-outside");

    const linkHome = tempHome("personal-link");
    symlinkSync(outside, path.join(linkHome, "personal"));
    await expect(ensurePersonalWorkspace({ home: linkHome })).rejects.toThrow(/real directory/);
    expect(await resolvePersonalWorkspace({ home: linkHome })).toBeNull();

    const fileHome = tempHome("personal-file");
    writeFileSync(path.join(fileHome, "personal"), "not a directory");
    await expect(ensurePersonalWorkspace({ home: fileHome })).rejects.toThrow(/real directory/);
    expect(resolvePersonalWorkspaceSync({ home: fileHome })).toBeNull();
  });

  it("makes --probe verify the workspace instead of reporting a false healthy state", async () => {
    const goodHome = tempHome("personal-probe-good");
    await ensurePersonalWorkspace({ home: goodHome });
    const good = spawnSync(process.execPath, [KANBAN_CLI, "--probe"], {
      env: { ...process.env, GARRISON_HOME: goodHome },
      encoding: "utf8"
    });
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("KANBAN-OK");

    const outside = tempHome("personal-probe-outside");
    const badHome = tempHome("personal-probe-bad");
    symlinkSync(outside, path.join(badHome, "personal"));
    const bad = spawnSync(process.execPath, [KANBAN_CLI, "--probe"], {
      env: { ...process.env, GARRISON_HOME: badHome },
      encoding: "utf8"
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("personal workspace missing, invalid, or symlinked");
  });
});

describe("personal execution scope lockstep", () => {
  it("uses the exact same reserved token in Kanban and the gateway", () => {
    expect(KANBAN_PERSONAL_SCOPE_TOKEN).toBe("@personal");
    expect(GATEWAY_PERSONAL_SCOPE_TOKEN).toBe(KANBAN_PERSONAL_SCOPE_TOKEN);
  });

  it("opens a personal card terminal in the verified workspace", async () => {
    const home = tempHome("personal-terminal");
    const workspace = await ensurePersonalWorkspace({ home });
    expect(cardWorkdir({ scope: "personal", project: null }, { garrisonHome: home, cwd: "/fallback" })).toBe(workspace);
  });

  it("refuses an unavailable personal terminal instead of falling back", () => {
    const home = tempHome("personal-terminal-missing");
    expect(() => cardWorkdir({ scope: "personal", project: null }, { garrisonHome: home, cwd: "/fallback" }))
      .toThrow(/personal workspace is unavailable/);
  });

  it("keeps a real project ahead of the personal fallback", async () => {
    const home = tempHome("personal-terminal-project");
    await ensurePersonalWorkspace({ home });
    const devRoot = path.join(home, "dev");
    const project = makeRepo(path.join(devRoot, "real-project"));
    expect(cardWorkdir(
      { scope: "personal", project: "real-project" },
      { garrisonHome: home, devRoot, cwd: "/fallback" }
    )).toBe(project);
  });

  it("keeps an explicit run-spec project ahead of personal and refuses an invalid one", async () => {
    const home = tempHome("personal-terminal-routed-project");
    await ensurePersonalWorkspace({ home });
    const devRoot = path.join(home, "dev");
    const project = makeRepo(path.join(devRoot, "ekoa-code"));

    expect(cardWorkdir(
      { scope: "personal", project: null, routing: { project: "ekoa-code" } },
      { garrisonHome: home, devRoot, cwd: "/fallback" }
    )).toBe(project);
    expect(() => cardWorkdir(
      { scope: "personal", project: null, routing: { project: "missing" } },
      { garrisonHome: home, devRoot, cwd: "/fallback" }
    )).toThrow(/not a Git repository under the configured dev root/);
  });

  it("matches the gateway's confined project-name contract for Terminal cwd", async () => {
    const home = tempHome("personal-terminal-confinement");
    await ensurePersonalWorkspace({ home });
    const devRoot = path.join(home, "dev");
    const project = makeRepo(path.join(devRoot, "safe-repo"));
    mkdirSync(path.join(devRoot, "not-git"), { recursive: true });
    const outside = makeRepo(path.join(home, "outside-repo"));
    symlinkSync(outside, path.join(devRoot, "escape"));

    const labels = [
      "safe-repo",
      project,
      "../outside-repo",
      "nested/repo",
      "not-git",
      "escape",
      ".hidden",
      ".."
    ];
    for (const label of labels) {
      expect(kanbanResolveProjectName(label, { devRoot }), label)
        .toBe(gatewayResolveProjectName(label, { devRoot }));
    }

    expect(cardWorkdir({ project: "safe-repo" }, { devRoot, cwd: "/fallback" })).toBe(project);
    // Legacy top-level card.project paths are reduced to their repo name before
    // confinement, matching card dispatch; the absolute path itself is never
    // accepted as a cwd.
    expect(cardWorkdir({ project }, { devRoot, cwd: "/fallback" })).toBe(project);
    for (const invalid of labels.slice(2)) {
      expect(() => cardWorkdir({ project: invalid }, { devRoot, cwd: "/fallback" }), invalid)
        .toThrow(/not a Git repository under the configured dev root/);
    }
    expect(() => cardWorkdir({ project: outside }, { devRoot, cwd: "/fallback" }))
      .toThrow(/not a Git repository under the configured dev root/);
  });

  it("refuses a traversal routing.project on personal instead of falling back", async () => {
    const home = tempHome("personal-terminal-routing-traversal");
    await ensurePersonalWorkspace({ home });
    const devRoot = path.join(home, "dev");
    makeRepo(path.join(devRoot, "safe-repo"));

    expect(() => cardWorkdir(
      { scope: "personal", project: "safe-repo", routing: { project: "../outside" } },
      { garrisonHome: home, devRoot, cwd: "/fallback" }
    )).toThrow(/not a Git repository under the configured dev root/);
  });
});
