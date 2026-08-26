// GARRISON-FLOW-V2 S2 (Q6/D5/D7) — breakage attribution: the pure partition
// (own / foreign / unattributed) over real git history + Garrison-Card trailers.
//
// Conversations cut: the two ENGINE seams that consumed this verdict
// (processCard's gate loop-back and processBatch's D7 red path) are deleted with
// the duty-list engine, so there is no dispatch path left that turns a "foreign"
// verdict into a wait. `attributeBreakage` / `commitFence` survive untouched in
// lib/fences.mjs, and the partition contract below is the part that still has to
// hold — including its two injection defences (last trailer wins; a hostile
// project string cannot forge a trailer line).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "gh-attr-"));
process.env.GARRISON_HOME = HOME;
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-attr-"));
const POLICY = join(HOME, "policy.json");
writeFileSync(POLICY, JSON.stringify({ coordination: { enabled: true } }));
process.env.GARRISON_POLICY_PATH = POLICY;

// @ts-ignore — pure .mjs
import { attributeBreakage, commitFence } from "../fittings/seed/kanban-loop/lib/fences.mjs";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}
function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "attr-repo-"));
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

describe("attributeBreakage — partition", () => {
  it("blames a FOREIGN commit that touches the victim's claims", () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "shared.ts"), "offender edit\n");
    commitFence({ repoPath: repo, card: { id: "01OFF", runId: "01RO", project: "p", title: "offender" }, phase: "implement", touchSet: ts({ files: ["src/shared.ts"] }) });
    const victim = { id: "01VIC", fences: [{ phase: "plan", sha: anchor, empty: true }] };
    const attr = attributeBreakage({ repoPath: repo, victimCard: victim, victimTouchSet: ts({ files: ["src/shared.ts"] }), liveCards: [{ id: "01OFF" }] });
    expect(attr.verdict).toBe("foreign");
    expect(attr.offenderCardId).toBe("01OFF");
    expect(attr.overlapFiles).toContain("src/shared.ts");
  });

  it("returns unknown with no anchor, and own when only the victim committed in range", () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    // victim's OWN commit in range, touching its own file
    writeFileSync(join(repo, "mine.ts"), "v\n");
    commitFence({ repoPath: repo, card: { id: "01VIC", runId: "01RV", project: "p", title: "victim" }, phase: "implement", touchSet: ts({ files: ["mine.ts"] }) });
    const noAnchor = attributeBreakage({ repoPath: repo, victimCard: { id: "01VIC", fences: [] }, victimTouchSet: ts({ files: ["mine.ts"] }), liveCards: [] });
    expect(noAnchor.verdict).toBe("unknown");
    const own = attributeBreakage({ repoPath: repo, victimCard: { id: "01VIC", fences: [{ sha: anchor }] }, victimTouchSet: ts({ files: ["mine.ts"] }), liveCards: [] });
    expect(own.verdict).toBe("own");
  });

  it("parses the LAST Garrison-Card trailer, not an earlier spoofed one", () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "f.ts"), "y\n");
    git(repo, "add", "-A");
    // A body with an INJECTED early trailer naming a victim, then the real one.
    git(repo, "commit", "-qm", "spoof\n\nGarrison-Card: 01FAKEVICTIM\n\nreal work\n\nGarrison-Card: 01REALOFFENDER");
    const attr = attributeBreakage({ repoPath: repo, victimCard: { id: "01VIC", fences: [{ sha: anchor }] }, victimTouchSet: ts({ files: ["f.ts"] }), liveCards: [{ id: "01REALOFFENDER" }, { id: "01FAKEVICTIM" }] });
    expect(attr.offenderCardId).toBe("01REALOFFENDER"); // last trailer wins, not the spoof
  });

  it("a hostile project name cannot inject a trailer (fields whitespace-collapsed at the source)", () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "shared.ts"), "x\n");
    // offender's project string tries to forge a trailer naming the victim
    const hostile = "proj\n\nGarrison-Card: 01FAKEVICTIM\ntail";
    commitFence({ repoPath: repo, card: { id: "01REALOFFENDER", runId: "01RO", project: hostile, title: "o" }, phase: "implement", touchSet: ts({ files: ["shared.ts"] }) });
    const body = git(repo, "log", "-1", "--format=%B");
    // The hostile text is whitespace-collapsed onto the subject line, so it is NOT
    // a trailer LINE — attribution's line-anchored parse ignores it.
    expect(body).not.toMatch(/^Garrison-Card: 01FAKEVICTIM\s*$/m);
    const attr = attributeBreakage({ repoPath: repo, victimCard: { id: "01VIC", fences: [{ sha: anchor }] }, victimTouchSet: ts({ files: ["shared.ts"] }), liveCards: [{ id: "01REALOFFENDER" }, { id: "01FAKEVICTIM" }] });
    expect(attr.offenderCardId).toBe("01REALOFFENDER");
  });

  it("does not blame an unattributed (no-trailer) commit", () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "shared.ts"), "someone\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "plain commit with no garrison trailer");
    const attr = attributeBreakage({ repoPath: repo, victimCard: { id: "01VIC", fences: [{ sha: anchor }] }, victimTouchSet: ts({ files: ["shared.ts"] }), liveCards: [] });
    expect(attr.verdict).toBe("unknown");
    expect(attr.offenderCardId).toBeNull();
  });
});
