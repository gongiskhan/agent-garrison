// GARRISON-FLOW-V2 S2 (Q5) — commit fences over a REAL temp git repo. Scoped
// staging (never -A), the trailer format, empty-fence HEAD anchors, and touch-set
// growth re-registration.
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "gh-fences-"));

// @ts-ignore — pure .mjs
import { commitFence } from "../fittings/seed/kanban-loop/lib/fences.mjs";
// @ts-ignore — pure .mjs
import { registerTouchSetIntent, reregisterTouchSetIfGrown, resetCoordinationCache } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fence-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Tester");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed");
  return repo;
}

const ts = (o: any) => ({ version: 1, files: [], dirs: [], surfaces: [], exclusive: [], ...o });
beforeEach(() => resetCoordinationCache());

describe("commitFence — scoped staging", () => {
  it("commits ONLY the touch-set paths and leaves foreign dirty files unstaged", () => {
    const repo = newRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "mine\n");
    writeFileSync(join(repo, "foreign.txt"), "not mine\n"); // outside the touch-set
    const card = { id: "01CARDA", runId: "01RUNA", project: "p", title: "card A" };
    const out = commitFence({ repoPath: repo, card, phase: "implement", touchSet: ts({ files: ["src/a.ts"] }), otherClaims: [] });

    expect(out.record).toBeTruthy();
    expect(out.record.empty).toBe(false);
    // the foreign file is still untracked (never committed by the fence)
    expect(git(repo, "status", "--porcelain")).toContain("foreign.txt");
    // the committed tree contains src/a.ts but NOT foreign.txt
    const show = git(repo, "show", "--name-only", "--format=", "HEAD").trim();
    expect(show).toContain("src/a.ts");
    expect(show).not.toContain("foreign.txt");
    // and an honest warning event names the orphaned file
    expect(out.events.some((e: any) => /unattributable/.test(e.message) && /foreign\.txt/.test(e.message))).toBe(true);
  });

  it("does NOT flag a foreign dirty file when another live card's claims cover it", () => {
    const repo = newRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "mine\n");
    writeFileSync(join(repo, "other.ts"), "peer's file\n");
    const card = { id: "01CARDA", runId: "01RUNA", project: "p", title: "card A" };
    const out = commitFence({ repoPath: repo, card, phase: "implement", touchSet: ts({ files: ["src/a.ts"] }), otherClaims: [ts({ files: ["other.ts"] })] });
    expect(out.events.some((e: any) => /unattributable/.test(e.message))).toBe(false);
  });

  it("writes the exact trailer format that attribution parses back", () => {
    const repo = newRepo();
    writeFileSync(join(repo, "x.ts"), "v\n");
    const card = { id: "01CARDX", runId: "01RUNX", project: "proj", title: "A very long card title that should be truncated to fifty chars max here" };
    commitFence({ repoPath: repo, card, phase: "review", touchSet: ts({ files: ["x.ts"] }), otherClaims: [] });
    const body = git(repo, "log", "-1", "--format=%B");
    expect(body).toMatch(/^garrison\(proj\): review fence — /m);
    expect(body).toContain("Garrison-Card: 01CARDX");
    expect(body).toContain("Garrison-Run: 01RUNX");
    expect(body).toContain("Garrison-Phase: review");
    // subject title capped at 50 chars
    const subject = body.split("\n")[0];
    const titlePart = subject.split("— ")[1];
    expect(titlePart.length).toBeLessThanOrEqual(50);
  });
});

describe("commitFence — empty fence anchors HEAD", () => {
  it("records empty:true at the current HEAD when there is nothing to stage", () => {
    const repo = newRepo();
    const head = git(repo, "rev-parse", "HEAD").trim();
    const card = { id: "01CARDE", runId: "01RUNE", project: "p", title: "no changes" };
    // touch-set points at a path with no on-disk change
    const out = commitFence({ repoPath: repo, card, phase: "plan", touchSet: ts({ files: ["src/nope.ts"] }), otherClaims: [] });
    expect(out.record.empty).toBe(true);
    expect(out.record.sha).toBe(head); // anchored to HEAD, chain has no gap
    // no new commit was created
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head);
  });
});

describe("commitFence — unresolved repo degrades visibly", () => {
  it("returns a null record + an honest fence event when repoPath is missing", () => {
    const card = { id: "01CARDN", runId: "01RUNN", project: "ghost", title: "no repo" };
    const out = commitFence({ repoPath: null, card, phase: "implement", touchSet: ts({ files: ["a.ts"] }) });
    expect(out.record).toBeNull();
    expect(out.events.some((e: any) => e.kind === "fence" && /skipped/i.test(e.message))).toBe(true);
  });
});

describe("touch-set growth re-registration (Q5)", () => {
  it("appends a fresh ledger row only when the touch-set GREW", () => {
    const repo = newRepo();
    const card = { id: "01CARDG", runId: "01RUNG", project: "p", title: "grower" };
    registerTouchSetIntent({ repoPath: repo, card, touchSet: ts({ files: ["src/a.ts"] }) });
    // no growth -> no new row
    const same = reregisterTouchSetIfGrown({ repoPath: repo, card, touchSet: ts({ files: ["src/a.ts"] }) });
    expect(same.grown).toBe(false);
    // growth -> new row + added list
    const grown = reregisterTouchSetIfGrown({ repoPath: repo, card, touchSet: ts({ files: ["src/a.ts", "src/b.ts"] }) });
    expect(grown.grown).toBe(true);
    expect(grown.added).toContain("src/b.ts");
  });
  it("does not re-register a card that never registered a base touch-set", () => {
    const repo = newRepo();
    const card = { id: "01CARDH", runId: "01RUNH", project: "p", title: "never-registered" };
    const r = reregisterTouchSetIfGrown({ repoPath: repo, card, touchSet: ts({ files: ["z.ts"] }) });
    expect(r.grown).toBe(false);
  });
});
