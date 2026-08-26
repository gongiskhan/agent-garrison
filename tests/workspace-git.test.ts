// Phase 3 slice F — the git-aware workspace.
//
// Three things are worth a test here and the rest is plumbing:
//
//   1. `runGit`'s rules actually hold. The one that would be silently wrong is
//      hook neutralisation: browsing or committing in someone else's repository
//      must not execute code that repository carries. So the fixture plants a
//      hook, proves it FIRES without the guard, and proves it does not with it —
//      a test that only asserted "no marker" would pass against a broken guard
//      that simply never ran the command.
//   2. Ahead/behind is measured without an implicit fetch. A status read that
//      silently hit the network would be neither instant nor side-effect-free,
//      and the merge actions decide on exactly these numbers.
//   3. Confinement is per ROOT. The riskiest refactor in the mesh plan made the
//      confinement helpers root-parameterised; the new invariant is that a path
//      inside project A cannot reach project B, by traversal or by symlink.
//
// Plus an integration-lite round trip of pull-from-others across two nodes on a
// real state service, where the second node's answer comes from the real pump.

import { execFileSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startStateService, type StateHarness } from "./state-service-harness";
import { StateClient } from "@garrison/state-client";

// @ts-ignore - dependency-free fitting JavaScript
import { assertPathArg, assertRefArg, DIFF_CAP_BYTES, gitCommitAll, gitDiff, gitFetch, gitLog, gitStatus, parsePorcelainV2, runGit } from "../fittings/seed/file-browser/scripts/git.mjs";
// @ts-ignore
import { resolveProjectName, listProjectNames } from "../fittings/seed/file-browser/scripts/sources.mjs";
// @ts-ignore
import { commitPushProject, pullFromOthers, pumpOnce, REPLY_KIND, REQUEST_KIND } from "../fittings/seed/file-browser/scripts/merge-actions.mjs";

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "file-browser", "scripts", "start.mjs");

// ── fixture helpers ──────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository on `main` with one commit and a local identity (never the user's). */
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  // symbolic-ref rather than `checkout -b`: no branch command, and it works on
  // every git version regardless of init.defaultBranch.
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "fixture@garrison.test");
  git(dir, "config", "user.name", "Garrison Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

function initBare(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--bare", "--quiet", "--initial-branch=main");
  return dir;
}

function cloneOf(origin: string, dir: string): string {
  git(path.dirname(dir), "clone", "--quiet", origin, path.basename(dir));
  git(dir, "config", "user.email", "fixture@garrison.test");
  git(dir, "config", "user.name", "Garrison Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commitFile(dir: string, rel: string, body: string, message: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
}

// ── 1. runGit rules ──────────────────────────────────────────────────────────

describe("runGit — the rules that are load-bearing", () => {
  let dir: string;
  const MARKER = "HOOK-RAN";

  beforeAll(() => {
    dir = initRepo(mkdtempSync(path.join(tmpdir(), "garrison-git-hooks-")));
    const hooks = path.join(dir, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "post-commit"]) {
      const hook = path.join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/${MARKER}-${name}"\n`, { mode: 0o755 });
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the fixture's hook DOES fire under a plain git — otherwise the guard below proves nothing", () => {
    writeFileSync(path.join(dir, "canary.txt"), "one");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "plain git commit");
    expect(existsSync(path.join(dir, `${MARKER}-pre-commit`))).toBe(true);
    expect(existsSync(path.join(dir, `${MARKER}-post-commit`))).toBe(true);
    // Clear the evidence before the real assertion.
    rmSync(path.join(dir, `${MARKER}-pre-commit`), { force: true });
    rmSync(path.join(dir, `${MARKER}-post-commit`), { force: true });
  });

  it("NEUTRALISES the repository's hooks (core.hooksPath=/dev/null)", async () => {
    writeFileSync(path.join(dir, "canary.txt"), "two");
    const result = await gitCommitAll(dir, "workspace: commit through runGit");
    expect(result.committed).toBe(true);
    expect(existsSync(path.join(dir, `${MARKER}-pre-commit`))).toBe(false);
    expect(existsSync(path.join(dir, `${MARKER}-post-commit`))).toBe(false);
  });

  it("refuses a relative cwd and a non-string arg — this module resolves nothing itself", () => {
    expect(() => runGit("relative/path", ["status"])).toThrow(/absolute path/);
    expect(() => runGit(dir, ["status", 5 as unknown as string])).toThrow(/array of strings/);
  });

  it("never lets a path argument reach a flag position", () => {
    expect(() => assertPathArg("--output=/etc/cron.d/x")).toThrow(/dash/);
    expect(() => assertPathArg("/etc/passwd")).toThrow(/repository-relative/);
    expect(() => assertPathArg("../../etc/passwd")).toThrow(/escapes/);
    expect(() => assertPathArg("src/a\0b")).toThrow(/NUL/);
    expect(assertPathArg("./src/index.ts")).toBe("src/index.ts");
  });

  it("refuses a ref name git would not accept, before it becomes argv", () => {
    expect(() => assertRefArg("--upload-pack=evil")).toThrow(/unsafe ref/);
    expect(() => assertRefArg("a b")).toThrow(/unsafe ref/);
    expect(() => assertRefArg("main..HEAD")).toThrow(/unsafe ref/);
    expect(assertRefArg("node/dev-madrid")).toBe("node/dev-madrid");
  });

  it("caps output and reports the truncation rather than throwing", async () => {
    const res = await runGit(dir, ["log", "--format=%H%n%s"], { cap: 32 });
    expect(res.code).toBe(0);
    expect(Buffer.byteLength(res.stdout, "utf8")).toBeLessThanOrEqual(32);
    expect(res.truncated).toBe(true);
  });

  it("parses porcelain v2 into branch, upstream, counts and dirty entries", () => {
    const snapshot = parsePorcelainV2(
      [
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
        "2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
        "? untracked.txt"
      ].join("\n")
    );
    expect(snapshot.branch).toBe("main");
    expect(snapshot.upstream).toBe("origin/main");
    expect(snapshot.ahead).toBe(2);
    expect(snapshot.behind).toBe(3);
    expect(snapshot.dirty.map((d: any) => d.path)).toEqual(["src/a.ts", "new.ts", "conflict.ts", "untracked.txt"]);
    expect(snapshot.dirty.find((d: any) => d.path === "conflict.ts").state).toBe("unmerged");
    expect(snapshot.dirty.find((d: any) => d.path === "new.ts").from).toBe("old.ts");
  });
});

// ── 2. status, ahead/behind, diff, log ───────────────────────────────────────

describe("status and diff on a real repository pair", () => {
  let base: string;
  let origin: string;
  let a: string;
  let b: string;

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), "garrison-git-pair-"));
    origin = initBare(path.join(base, "origin.git"));
    a = initRepo(path.join(base, "a"));
    git(a, "remote", "add", "origin", origin);
    git(a, "push", "--quiet", "--set-upstream", "origin", "main");
    b = cloneOf(origin, path.join(base, "b"));
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("reports a clean tree with an upstream and no divergence", async () => {
    const status = await gitStatus(b);
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.dirtyCount).toBe(0);
    expect(status.mergeInProgress).toBe(false);
  });

  it("counts local commits as ahead", async () => {
    commitFile(b, "b-only.txt", "from b\n", "b: local work");
    const status = await gitStatus(b);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
  });

  it("does NOT fetch implicitly — behind stays 0 until fetch is asked for", async () => {
    commitFile(a, "a-only.txt", "from a\n", "a: work");
    git(a, "push", "--quiet", "origin", "main");

    const before = await gitStatus(b);
    expect(before.behind).toBe(0); // origin/main is stale on purpose

    const fetched = await gitFetch(b);
    expect(fetched.ok).toBe(true);

    const after = await gitStatus(b);
    expect(after.behind).toBe(1);
    expect(after.ahead).toBe(1);
  });

  it("lists dirty entries including untracked files", async () => {
    writeFileSync(path.join(b, "scratch.txt"), "unstaged");
    const status = await gitStatus(b);
    expect(status.dirtyCount).toBeGreaterThan(0);
    expect(status.dirty.map((d: any) => d.path)).toContain("scratch.txt");
    rmSync(path.join(b, "scratch.txt"));
  });

  it("sees a merge in progress", async () => {
    // Both sides changed the same line, so the merge stops in conflict.
    commitFile(a, "shared.txt", "A side\n", "a: shared");
    git(a, "push", "--quiet", "origin", "main");
    commitFile(b, "shared.txt", "B side\n", "b: shared");
    await gitFetch(b);
    try {
      git(b, "-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "origin/main");
    } catch {
      /* the conflict is the point */
    }
    const status = await gitStatus(b);
    expect(status.mergeInProgress).toBe(true);
    expect(status.inProgress).toContain("merge");
    expect(status.dirty.some((d: any) => d.state === "unmerged")).toBe(true);
    git(b, "merge", "--abort");
  });

  it("caps a large diff and says so", async () => {
    // Committed first: `git diff` shows changes to TRACKED files, so an
    // untracked megabyte would have produced an empty diff and a green test.
    commitFile(b, "big.txt", "seed\n", "b: add big.txt");
    const big = "x".repeat(DIFF_CAP_BYTES + 200_000);
    writeFileSync(path.join(b, "big.txt"), `${big}\n`);
    const diff = await gitDiff(b, { relPath: "big.txt" });
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.diff, "utf8")).toBeLessThanOrEqual(DIFF_CAP_BYTES);
    rmSync(path.join(b, "big.txt"));
  });

  it("REFUSES to diff a binary file rather than answering with a placeholder", async () => {
    commitFile(b, "logo.bin", " seed", "b: add binary");
    writeFileSync(path.join(b, "logo.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]));
    await expect(gitDiff(b, { relPath: "logo.bin" })).rejects.toThrow(/binary/);
    // A whole-tree diff stays useful and NAMES the binary instead of refusing.
    const all = await gitDiff(b, {});
    expect(all.binary).toContain("logo.bin");
    git(b, "checkout", "--", "logo.bin");
  });

  it("clamps the log limit and returns structured commits", async () => {
    const log = await gitLog(b, { limit: 99999 });
    expect(log.limit).toBe(200);
    expect(log.commits.length).toBeGreaterThan(0);
    expect(log.commits[0]).toMatchObject({ author: "Garrison Fixture" });
    expect(log.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    const one = await gitLog(b, { limit: 1 });
    expect(one.commits).toHaveLength(1);
  });
});

// ── 3. project sources and per-root confinement ──────────────────────────────

describe("project sources — the dev-root name discipline", () => {
  let devRoot: string;
  let outside: string;

  beforeAll(() => {
    devRoot = mkdtempSync(path.join(tmpdir(), "garrison-devroot-"));
    outside = mkdtempSync(path.join(tmpdir(), "garrison-outside-"));
    initRepo(path.join(devRoot, "alpha"));
    initRepo(path.join(devRoot, "beta"));
    mkdirSync(path.join(devRoot, "not-a-repo"));
    initRepo(path.join(outside, "elsewhere"));
    symlinkSync(path.join(outside, "elsewhere"), path.join(devRoot, "linked"));
  });

  afterAll(() => {
    rmSync(devRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a dev-root child that is a git repository", () => {
    expect(resolveProjectName("alpha", { devRoot })).toBe(path.join(require("node:fs").realpathSync(devRoot), "alpha"));
  });

  it("refuses a separator, a traversal, an absolute path, a dotfile and a non-repo", () => {
    for (const bad of ["a/b", "a\\b", "..", "../beta", "/etc", ".git", ".hidden", "not-a-repo", ""]) {
      expect(resolveProjectName(bad, { devRoot }), bad).toBeNull();
    }
  });

  it("refuses a symlinked child whose realpath leaves the dev-root", () => {
    // A name-only check would have waved this straight through.
    expect(resolveProjectName("linked", { devRoot })).toBeNull();
  });

  it("only ever offers names the resolver would accept", () => {
    expect(listProjectNames({ devRoot })).toEqual(["alpha", "beta"]);
  });
});

describe("the workspace server — confinement is per ROOT", () => {
  const PORT = 7190; // unique across the suite - 7196 is drill-authoring-api.test.ts's
  const BASE = `http://127.0.0.1:${PORT}`;
  let srv: ChildProcess | null = null;
  let home: string;
  let devRoot: string;
  let local: string;
  let outside: string;

  async function waitHealthy(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), "garrison-ws-home-"));
    devRoot = mkdtempSync(path.join(tmpdir(), "garrison-ws-devroot-"));
    local = mkdtempSync(path.join(tmpdir(), "garrison-ws-files-"));
    outside = mkdtempSync(path.join(tmpdir(), "garrison-ws-outside-"));
    writeFileSync(path.join(home, "dev-root"), devRoot);

    initRepo(path.join(devRoot, "alpha"));
    initRepo(path.join(devRoot, "beta"));
    writeFileSync(path.join(devRoot, "beta", "SECRET.txt"), "beta's private note");
    writeFileSync(path.join(devRoot, "alpha", "hello.txt"), "alpha content");
    writeFileSync(path.join(devRoot, "alpha", ".env"), "TOKEN=nope");
    writeFileSync(path.join(outside, "target.txt"), "ORIGINAL");
    // A symlink INSIDE project alpha pointing at project beta, and one pointing
    // clean outside the dev-root. Both must be refused by alpha's own root check.
    symlinkSync(path.join(devRoot, "beta"), path.join(devRoot, "alpha", "to-beta"));
    symlinkSync(outside, path.join(devRoot, "alpha", "to-outside"));

    srv = spawn("node", [START], {
      env: {
        ...process.env,
        GARRISON_HOME: home,
        GARRISON_FILEBROWSER_ROOT: local,
        FILEBROWSER_UI_PORT: String(PORT),
        FILEBROWSER_UI_HOST: "127.0.0.1",
        // The merge pump talks to the state service; a unit test must never
        // enrol itself in the real mesh.
        GARRISON_FILEBROWSER_NO_PUMP: "1",
        GARRISON_STATE_URL: "",
        GARRISON_STATE_TOKEN: ""
      },
      stdio: "ignore"
    });
    await waitHealthy(8000);
  }, 20_000);

  afterAll(() => {
    if (srv && !srv.killed) srv.kill("SIGTERM");
    srv = null;
    for (const d of [home, devRoot, local, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("offers the local source plus one per dev-root project", async () => {
    const { sources } = await (await fetch(`${BASE}/api/sources`)).json();
    const ids = sources.map((s: any) => s.id);
    expect(ids).toContain("local");
    expect(ids).toContain("project:alpha");
    expect(ids).toContain("project:beta");
    const alpha = sources.find((s: any) => s.id === "project:alpha");
    expect(alpha).toMatchObject({ kind: "project", writable: false, git: true });
  });

  it("browses and reads inside a project source", async () => {
    const tree = await (await fetch(`${BASE}/api/tree?source=project:alpha&path=`)).json();
    expect(tree.items.map((i: any) => i.name)).toContain("hello.txt");
    const file = await (await fetch(`${BASE}/api/file?source=project:alpha&path=hello.txt`)).json();
    expect(file.content).toBe("alpha content");
    expect(file.readOnly).toBe(true);
  });

  it("hides the repository's own .git and its credential files", async () => {
    const tree = await (await fetch(`${BASE}/api/tree?source=project:alpha&path=`)).json();
    const names = tree.items.map((i: any) => i.name);
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".env");
    expect((await fetch(`${BASE}/api/file?source=project:alpha&path=.git/config`)).status).toBe(403);
    expect((await fetch(`${BASE}/api/file?source=project:alpha&path=.env`)).status).toBe(403);
  });

  it("REFUSES to reach project beta from project alpha by traversal", async () => {
    const res = await fetch(`${BASE}/api/file?source=project:alpha&path=${encodeURIComponent("../beta/SECRET.txt")}`);
    expect(res.status).toBe(403);
    const tree = await fetch(`${BASE}/api/tree?source=project:alpha&path=${encodeURIComponent("../beta")}`);
    expect(tree.status).toBe(403);
  });

  it("REFUSES to reach project beta from project alpha THROUGH a symlink", async () => {
    // The realpath check runs against alpha's root, so a link into a sibling
    // project is caught exactly like a link out of the dev-root entirely.
    expect((await fetch(`${BASE}/api/file?source=project:alpha&path=${encodeURIComponent("to-beta/SECRET.txt")}`)).status).toBe(403);
    expect((await fetch(`${BASE}/api/tree?source=project:alpha&path=to-beta`)).status).toBe(403);
    expect((await fetch(`${BASE}/api/file?source=project:alpha&path=${encodeURIComponent("to-outside/target.txt")}`)).status).toBe(403);
  });

  it("keeps the LOCAL root confined exactly as before, with its own root", async () => {
    writeFileSync(path.join(local, "note.txt"), "local note");
    const ok = await (await fetch(`${BASE}/api/file?path=note.txt`)).json();
    expect(ok.content).toBe("local note");
    // A local path may not reach a project, and vice versa.
    expect((await fetch(`${BASE}/api/file?path=${encodeURIComponent("../garrison-ws-devroot-x/alpha/hello.txt")}`)).status).toBe(403);
  });

  it("REFUSES every write to a project source", async () => {
    const put = await fetch(`${BASE}/api/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "project:alpha", path: "hello.txt", content: "HACKED" })
    });
    expect(put.status).toBe(403);
    const mk = await fetch(`${BASE}/api/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "project:alpha", path: "newdir" })
    });
    expect(mk.status).toBe(403);
    const still = await (await fetch(`${BASE}/api/file?source=project:alpha&path=hello.txt`)).json();
    expect(still.content).toBe("alpha content");
  });

  it("404s a project name the resolver would not accept", async () => {
    expect((await fetch(`${BASE}/api/tree?source=project:nope`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/git/status?source=${encodeURIComponent("project:../etc")}`)).status).toBe(404);
  });

  it("serves git status/log/diff for a project and refuses them for the artifact root", async () => {
    const status = await (await fetch(`${BASE}/api/git/status?source=project:alpha`)).json();
    expect(status.branch).toBe("main");
    expect(status.source).toBe("project:alpha");
    const log = await (await fetch(`${BASE}/api/git/log?source=project:alpha&limit=5`)).json();
    expect(log.commits.length).toBeGreaterThan(0);
    const diff = await (await fetch(`${BASE}/api/git/diff?source=project:alpha`)).json();
    expect(diff.cap).toBe(DIFF_CAP_BYTES);

    const refused = await fetch(`${BASE}/api/git/status?source=local`);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/not a git repository/);
  });
});

// ── 4. integration-lite: pull-from-others across two nodes ───────────────────

describe("pull-from-others — the event round trip", () => {
  let harness: (StateHarness & { tokens: Record<string, string> }) | null = null;
  let base: string;
  let originDir: string;
  let envA: Record<string, string>;
  let envB: Record<string, string>;
  let clientA: StateClient;
  let clientB: StateClient;
  let repoB: string;

  beforeAll(async () => {
    harness = await startStateService({ nodes: ["node-a", "node-b"] });
    clientA = harness.client;
    clientB = new StateClient({ url: harness.url, token: harness.tokens["node-b"], node: "node-b" });

    base = mkdtempSync(path.join(tmpdir(), "garrison-pull-"));
    originDir = initBare(path.join(base, "origin.git"));

    const devRootA = path.join(base, "dev-a");
    const devRootB = path.join(base, "dev-b");
    mkdirSync(devRootA, { recursive: true });
    mkdirSync(devRootB, { recursive: true });

    const seed = initRepo(path.join(base, "seed"));
    git(seed, "remote", "add", "origin", originDir);
    git(seed, "push", "--quiet", "--set-upstream", "origin", "main");

    cloneOf(originDir, path.join(devRootA, "proj"));
    repoB = cloneOf(originDir, path.join(devRootB, "proj"));

    const homeA = path.join(base, "home-a");
    const homeB = path.join(base, "home-b");
    mkdirSync(homeA, { recursive: true });
    mkdirSync(homeB, { recursive: true });
    writeFileSync(path.join(homeA, "dev-root"), devRootA);
    writeFileSync(path.join(homeB, "dev-root"), devRootB);

    envA = { GARRISON_HOME: homeA, GARRISON_NODE_NAME: "node-a" };
    envB = { GARRISON_HOME: homeB, GARRISON_NODE_NAME: "node-b" };
  }, 30_000);

  afterAll(async () => {
    if (harness) await harness.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it("asks the mesh, the peer's pump answers, and the report names both the reply and the fetch", async () => {
    // node-b has uncommitted work. That is precisely what pull-from-others is for.
    writeFileSync(path.join(repoB, "from-b.txt"), "work only node-b has\n");

    // The peer's pump, running concurrently — the real executor, not a stub.
    let cursor = 0;
    const pump = setInterval(() => {
      void pumpOnce({ client: clientB, env: envB, sinceSeq: cursor }).then((next: number) => {
        cursor = next;
      });
    }, 200);

    let report: any;
    try {
      report = await pullFromOthers("proj", { env: envA, client: clientA, deadlineMs: 20_000, pollMs: 250 });
    } finally {
      clearInterval(pump);
    }

    expect(report.requestedBy).toBe("node-a");
    expect(report.peers).toEqual(["node-b"]);
    expect(report.fetch.ok).toBe(true);
    // d12e6849 finished the half c67966a9 deferred: the REQUESTER merges what
    // the peers pushed. This assertion read `false` until 2026-08-26 and had
    // been red since that commit - the contract moved and the test did not.
    expect(report.merged).toBe(true);

    const b = report.nodes.find((n: any) => n.node === "node-b");
    expect(b.status).toBe("replied");
    expect(b.result).toBe("pushed");
    expect(b.branch).toBe("main");
    expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(b.merge).toBe("merged");
    expect(b.mergedSha).toMatch(/^[0-9a-f]{40}$/);

    // The peer really did commit and push: node-a can see the work after the
    // fetch, and - the point of merging - in its own WORKING TREE, not just in
    // origin/main.
    const show = await runGit(path.join(base, "dev-a", "proj"), ["show", "--name-only", "--format=", "origin/main"]);
    expect(show.stdout).toContain("from-b.txt");
    expect(existsSync(path.join(base, "dev-a", "proj", "from-b.txt"))).toBe(true);
  }, 60_000);

  it("records the request and exactly one reply as events", async () => {
    const requests = await clientA.listEvents({ kind: REQUEST_KIND });
    const replies = await clientA.listEvents({ kind: REPLY_KIND });
    expect(requests.length).toBe(1);
    expect(replies.length).toBe(1);
    expect(replies[0].payload.requestId).toBe(requests[0].payload.requestId);
    expect(replies[0].payload.node).toBe("node-b");
  });

  it("a node NEVER answers its own request", async () => {
    // node-a's own pump must ignore the request node-a just filed, or a
    // pull-from-others would report itself as a peer.
    const before = (await clientA.listEvents({ kind: REPLY_KIND })).length;
    await pumpOnce({ client: clientA, env: envA, sinceSeq: 0 });
    const after = (await clientA.listEvents({ kind: REPLY_KIND })).length;
    expect(after).toBe(before);
  });

  it("SKIPS a commit-push when a session is live in that repository", async () => {
    await clientB.upsertSession("sess-live-1", { homeNode: "node-b", status: "running", cwd: repoB });
    writeFileSync(path.join(repoB, "racy.txt"), "half-written\n");
    const result = await commitPushProject("proj", { env: envB, client: clientB });
    expect(result.status).toBe("skipped-session");
    // The file is still uncommitted — nothing was written under the session's feet.
    const status = await gitStatus(repoB);
    expect(status.dirty.map((d: any) => d.path)).toContain("racy.txt");
  }, 30_000);

  it("refuses a project that is not a dev-root repository on this node", async () => {
    await expect(commitPushProject("../etc", { env: envB, client: clientB })).rejects.toThrow(/no git project/);
    await expect(commitPushProject("nope", { env: envB, client: clientB })).rejects.toThrow(/no git project/);
  });
});
