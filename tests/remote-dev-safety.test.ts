import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../scripts/remote-dev.sh");
const dirs: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "garrison-remote-safety-"));
  dirs.push(dir);
  return dir;
}

function invoke(
  args: string[],
  env: Record<string, string | undefined> = {}
): ReturnType<typeof spawnSync> {
  return spawnSync(
    "bash",
    [
      "-c",
      'GARRISON_REMOTE_DEV_SOURCE_ONLY=1 source "$1"; shift; "$@"',
      "remote-dev-safety-test",
      SCRIPT,
      ...args
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env }
    }
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("remote snapshot source boundary", () => {
  it("accepts an ordinary untracked file but rejects an untracked symlink", () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, "regular.txt"), "ok\n");
    symlinkSync("/home/ggomes/dev/garrison/CLAUDE.md", path.join(dir, "escape-link"));

    expect(invoke(["validate_snapshot_entry", dir, "regular.txt"]).status).toBe(0);
    const linked = invoke(["validate_snapshot_entry", dir, "escape-link"]);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toMatch(/untracked symlinks are not supported/);
  });

  it("rejects a tracked symlink before building the snapshot", () => {
    const dir = sandbox();
    execFileSync("git", ["init", "--quiet", dir]);
    symlinkSync("/home/ggomes/dev/garrison/CLAUDE.md", path.join(dir, "tracked-link"));
    execFileSync("git", ["-C", dir, "add", "tracked-link"]);

    const result = invoke(["reject_ambiguous_git_state", dir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/tracked symlinks are not supported/);
  });

  it("re-checks archive entry types to close a validation-to-tar race", () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, "regular.txt"), "ok\n");
    symlinkSync("/home/ggomes/dev/garrison/CLAUDE.md", path.join(dir, "escape-link"));
    const regularArchive = path.join(dir, "regular.tar.gz");
    const linkedArchive = path.join(dir, "linked.tar.gz");
    execFileSync("tar", ["-czf", regularArchive, "-C", dir, "regular.txt"]);
    execFileSync("tar", ["-czf", linkedArchive, "-C", dir, "escape-link"]);

    expect(invoke(["reject_archive_links", regularArchive]).status).toBe(0);
    const linked = invoke(["reject_archive_links", linkedArchive]);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toMatch(/archive contains a link or special entry/);
  });
});

describe("canonical mutation boundary", () => {
  it("allows the literal live checkout", () => {
    expect(
      invoke(["require_canonical_mutation_repo"], {
        GARRISON_REMOTE_REPO: "/home/ggomes/dev/garrison"
      }).status
    ).toBe(0);
  });

  it("refuses an archived same-origin checkout for resume/deploy mutations", () => {
    const result = invoke(["require_canonical_mutation_repo"], {
      GARRISON_REMOTE_REPO: "/home/ggomes/dev/Archived Garrison Codex"
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must use the canonical VM checkout/);
  });
});
