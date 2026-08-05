// Project name resolution for the gateway, dev-root confined (decision
// 2026-07-25-web-channel-run-context §8). The moment a channel body can set
// `routing.project`, the resolver is the confinement boundary: everything here
// is an attack shape a web turn could send, exercised against a real temp
// dev-root (including a symlink that escapes it) rather than a mocked fs.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MODULE = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "http-gateway",
  "scripts",
  "lib",
  "project-source.mjs"
);

type ProjectSource = {
  PERSONAL_SCOPE_TOKEN: string;
  expandHome: (p: string) => string;
  readDevRoot: () => string;
  resolveProjectPath: (project: unknown, devRoot?: string) => string | null;
  resolveProjectName: (label: unknown, opts?: { devRoot?: string }) => string | null;
  resolvePersonalScope: (opts?: { garrisonHome?: string }) => string | null;
  resolveRunScope: (label: unknown, opts?: { devRoot?: string; garrisonHome?: string }) => string | null;
  listProjectNames: (devRoot?: string) => string[];
};

// The module snapshots GARRISON_HOME at import time (the gateway is spawned with
// it already set), so every env-dependent case reloads it.
async function loadModule(): Promise<ProjectSource> {
  vi.resetModules();
  return (await import(MODULE)) as unknown as ProjectSource;
}

let tmp: string;
let devRoot: string;
let outside: string;
let mod: ProjectSource;

function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, ".git"), { recursive: true });
}

beforeAll(async () => {
  // realpath the temp root up front: macOS hands out /var/folders symlinks and the
  // resolver returns realpaths, so raw mkdtemp strings would not compare equal.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "garrison-project-source-")));
  devRoot = path.join(tmp, "dev");
  outside = path.join(tmp, "outside");

  makeRepo(path.join(devRoot, "garrison"));
  makeRepo(path.join(devRoot, "ekoa"));
  makeRepo(path.join(devRoot, ".hidden-repo")); // a dotfile that IS a repo
  mkdirSync(path.join(devRoot, "not-a-repo"), { recursive: true }); // no .git
  mkdirSync(path.join(devRoot, "nested", "deep"), { recursive: true });
  makeRepo(path.join(devRoot, "nested", "deep")); // reachable only via a separator
  writeFileSync(path.join(devRoot, "notes.txt"), "not a dir");

  makeRepo(path.join(outside, "secret-checkout"));
  // The escape: a dev-root child whose name is clean but whose target is not.
  symlinkSync(path.join(outside, "secret-checkout"), path.join(devRoot, "escapes"));
  // The benign symlink: an alias for a repo that really is under the dev-root.
  symlinkSync(path.join(devRoot, "garrison"), path.join(devRoot, "garrison-alias"));

  mod = await loadModule();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveProjectName (dev-root confined)", () => {
  it("resolves a plain child name that is a git repo", () => {
    expect(mod.resolveProjectName("garrison", { devRoot })).toBe(path.join(devRoot, "garrison"));
    expect(mod.resolveProjectName("ekoa", { devRoot })).toBe(path.join(devRoot, "ekoa"));
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(mod.resolveProjectName("  garrison\n", { devRoot })).toBe(path.join(devRoot, "garrison"));
  });

  it("rejects absolute paths, even ones that exist and are repos", () => {
    const abs = path.join(devRoot, "garrison");
    expect(mod.resolveProjectName(abs, { devRoot })).toBeNull();
    expect(mod.resolveProjectName("/", { devRoot })).toBeNull();
    expect(mod.resolveProjectName(path.join(outside, "secret-checkout"), { devRoot })).toBeNull();
    expect(mod.resolveProjectName("~/dev/garrison", { devRoot })).toBeNull();
  });

  it("rejects any label carrying a path separator", () => {
    expect(mod.resolveProjectName("nested/deep", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("garrison/", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("nested\\deep", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("C:\\repo", { devRoot })).toBeNull();
  });

  it("rejects traversal", () => {
    expect(mod.resolveProjectName("..", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("../outside/secret-checkout", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("garrison/../../outside", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("..hidden", { devRoot })).toBeNull();
  });

  it("rejects empty and whitespace-only labels", () => {
    expect(mod.resolveProjectName("", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("   ", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("\t\n", { devRoot })).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(mod.resolveProjectName(null, { devRoot })).toBeNull();
    expect(mod.resolveProjectName(undefined, { devRoot })).toBeNull();
    expect(mod.resolveProjectName(42, { devRoot })).toBeNull();
    expect(mod.resolveProjectName({ toString: () => "garrison" }, { devRoot })).toBeNull();
  });

  it("rejects dotfiles, including a dot-named git repo", () => {
    expect(mod.resolveProjectName(".hidden-repo", { devRoot })).toBeNull();
    expect(mod.resolveProjectName(".", { devRoot })).toBeNull();
    expect(mod.resolveProjectName(".git", { devRoot })).toBeNull();
  });

  it("rejects a symlink whose target escapes the dev-root", () => {
    // The name is clean and the target is a real git repo - only the realpath
    // containment re-check catches this one.
    expect(mod.resolveProjectName("escapes", { devRoot })).toBeNull();
  });

  it("accepts a symlink that stays inside the dev-root, returning the realpath", () => {
    expect(mod.resolveProjectName("garrison-alias", { devRoot })).toBe(path.join(devRoot, "garrison"));
  });

  it("rejects a directory with no .git entry", () => {
    expect(mod.resolveProjectName("not-a-repo", { devRoot })).toBeNull();
  });

  it("rejects a non-directory and a name that is not there at all", () => {
    expect(mod.resolveProjectName("notes.txt", { devRoot })).toBeNull();
    expect(mod.resolveProjectName("no-such-project", { devRoot })).toBeNull();
  });

  it("rejects the dev-root itself (a name is a strict descendant)", () => {
    const selfLink = path.join(devRoot, "self");
    symlinkSync(devRoot, selfLink);
    try {
      expect(mod.resolveProjectName("self", { devRoot })).toBeNull();
    } finally {
      rmSync(selfLink, { force: true });
    }
  });

  it("returns null when the dev-root does not exist", () => {
    expect(mod.resolveProjectName("garrison", { devRoot: path.join(tmp, "nope") })).toBeNull();
  });
});

describe("listProjectNames", () => {
  it("lists exactly the names resolveProjectName accepts, sorted", () => {
    const names = mod.listProjectNames(devRoot);
    expect(names).toEqual(["ekoa", "garrison", "garrison-alias"]);
    for (const name of names) expect(mod.resolveProjectName(name, { devRoot })).not.toBeNull();
  });

  it("omits dotfiles, non-repos, files and escaping symlinks", () => {
    const names = mod.listProjectNames(devRoot);
    expect(names).not.toContain(".hidden-repo");
    expect(names).not.toContain("not-a-repo");
    expect(names).not.toContain("notes.txt");
    expect(names).not.toContain("nested");
    expect(names).not.toContain("escapes");
  });

  it("yields [] for a missing dev-root instead of throwing", () => {
    expect(mod.listProjectNames(path.join(tmp, "nope"))).toEqual([]);
  });
});

describe("resolveRunScope (one fixed non-project exception)", () => {
  it("resolves only the exact reserved token to GARRISON_HOME/personal", () => {
    const home = path.join(tmp, "personal-home-ok");
    const personal = path.join(home, "personal");
    mkdirSync(personal, { recursive: true });
    expect(mod.resolveRunScope(mod.PERSONAL_SCOPE_TOKEN, { devRoot, garrisonHome: home })).toBe(personal);
    expect(mod.resolveRunScope(`  ${mod.PERSONAL_SCOPE_TOKEN}  `, { devRoot, garrisonHome: home })).toBe(personal);
  });

  it("keeps ordinary project resolution and project listing unchanged", () => {
    const home = path.join(tmp, "personal-home-projects");
    mkdirSync(path.join(home, "personal"), { recursive: true });
    expect(mod.resolveRunScope("garrison", { devRoot, garrisonHome: home })).toBe(path.join(devRoot, "garrison"));
    expect(mod.listProjectNames(devRoot)).toEqual(["ekoa", "garrison", "garrison-alias"]);
    expect(mod.listProjectNames(devRoot)).not.toContain(mod.PERSONAL_SCOPE_TOKEN);
  });

  it("does not turn absolute paths, traversal, or token lookalikes into a cwd", () => {
    const home = path.join(tmp, "personal-home-hostile");
    mkdirSync(path.join(home, "personal"), { recursive: true });
    for (const hostile of [
      path.join(home, "personal"),
      "../personal",
      "@personal/child",
      "@Personal",
      "personal",
      "@@personal"
    ]) {
      expect(mod.resolveRunScope(hostile, { devRoot, garrisonHome: home }), hostile).toBeNull();
    }
  });

  it("rejects a missing workspace, a file, and a symlink even when the token is exact", () => {
    const missingHome = path.join(tmp, "personal-home-missing");
    mkdirSync(missingHome, { recursive: true });
    expect(mod.resolveRunScope(mod.PERSONAL_SCOPE_TOKEN, { devRoot, garrisonHome: missingHome })).toBeNull();

    const fileHome = path.join(tmp, "personal-home-file");
    mkdirSync(fileHome, { recursive: true });
    writeFileSync(path.join(fileHome, "personal"), "not a directory");
    expect(mod.resolveRunScope(mod.PERSONAL_SCOPE_TOKEN, { devRoot, garrisonHome: fileHome })).toBeNull();

    const linkHome = path.join(tmp, "personal-home-link");
    mkdirSync(linkHome, { recursive: true });
    symlinkSync(outside, path.join(linkHome, "personal"));
    expect(mod.resolveRunScope(mod.PERSONAL_SCOPE_TOKEN, { devRoot, garrisonHome: linkHome })).toBeNull();
  });
});

describe("dev-root source", () => {
  const priorHome = process.env.GARRISON_HOME;

  afterAll(async () => {
    if (priorHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = priorHome;
    mod = await loadModule();
  });

  it("reads <GARRISON_HOME>/dev-root and uses it as the default confinement root", async () => {
    const home = path.join(tmp, "garrison-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "dev-root"), `${devRoot}\n`);
    process.env.GARRISON_HOME = home;
    const fresh = await loadModule();
    expect(fresh.readDevRoot()).toBe(devRoot);
    expect(fresh.resolveProjectName("garrison")).toBe(path.join(devRoot, "garrison"));
    expect(fresh.resolveProjectName("escapes")).toBeNull();
    expect(fresh.listProjectNames()).toEqual(["ekoa", "garrison", "garrison-alias"]);
  });

  it("falls back to ~/dev when no dev-root file exists", async () => {
    const home = path.join(tmp, "garrison-home-empty");
    mkdirSync(home, { recursive: true });
    process.env.GARRISON_HOME = home;
    const fresh = await loadModule();
    expect(fresh.readDevRoot()).toBe(path.join(os.homedir(), "dev"));
  });
});

describe("resolveProjectPath (unchanged, and NOT a confinement boundary)", () => {
  it("still returns any absolute existing path as-is", () => {
    const escapeTarget = path.join(outside, "secret-checkout");
    expect(mod.resolveProjectPath(escapeTarget, devRoot)).toBe(escapeTarget);
    expect(mod.resolveProjectPath(outside, devRoot)).toBe(outside);
    // ...which is exactly why channel input must use resolveProjectName.
    expect(mod.resolveProjectName(escapeTarget, { devRoot })).toBeNull();
  });

  it("still joins a bare label onto the dev-root and requires .git", () => {
    expect(mod.resolveProjectPath("garrison", devRoot)).toBe(path.join(devRoot, "garrison"));
    expect(mod.resolveProjectPath("not-a-repo", devRoot)).toBeNull();
    expect(mod.resolveProjectPath("", devRoot)).toBeNull();
    expect(mod.resolveProjectPath(null, devRoot)).toBeNull();
  });
});
