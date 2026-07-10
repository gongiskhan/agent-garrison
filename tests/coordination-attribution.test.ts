// GARRISON-FLOW-V2 S2 (Q6/D5/D7) — breakage attribution. The pure partition
// (own/foreign/unattributed) plus the end-to-end engine behaviour: a victim whose
// gate fails because a FOREIGN card's commit touched its claims does NOT loop to
// implement — it waits for the offender's fix fence, its iteration is refunded,
// and the offender is notified in BOTH runDirs. Also the batched (D7) red path.
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
// @ts-ignore — pure .mjs
import { processCard, processBatch } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { resetCoordinationCache } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

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
const kroot = () => mkdtempSync(join(tmpdir(), "attr-kanban-"));

beforeEach(() => resetCoordinationCache());

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

describe("processCard — foreign breakage makes the victim WAIT (never loops to implement)", () => {
  it("waits on the offender's fence, refunds the iteration, notifies both runDirs", async () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    const root = kroot();
    const board = { ...seedBoard(), projects: { proj: { path: repo } } };

    // Offender: a live card whose fence touched src/shared.ts after the anchor.
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "shared.ts"), "offender change\n");
    let offender = await createCard(root, { title: "offender", project: "proj", list: "implement" });
    const offRunDir = join(root, "runs", "off");
    mkdirSync(offRunDir, { recursive: true });
    writeFileSync(join(offRunDir, "touch-set.json"), JSON.stringify(ts({ files: ["src/shared.ts"] })));
    const fence = commitFence({ repoPath: repo, card: { id: offender.id, runId: "01RO", project: "proj", title: "offender" }, phase: "implement", touchSet: ts({ files: ["src/shared.ts"] }) });
    offender = await saveCard(root, { ...offender, runId: "01RO", runDir: offRunDir, fences: [fence.record] });

    // Victim on Review, anchored before the offender's commit, claiming the same file.
    let victim = await createCard(root, { title: "victim", project: "proj", list: "review" });
    const vicRunDir = join(root, "runs", "vic");
    mkdirSync(vicRunDir, { recursive: true });
    writeFileSync(join(vicRunDir, "touch-set.json"), JSON.stringify(ts({ files: ["src/shared.ts"] })));
    victim = await saveCard(root, { ...victim, runId: "01RV", runDir: vicRunDir, iterations: 2, fences: [{ phase: "plan", sha: anchor, empty: true }] });

    const runFn = async () => ({ reply: "implement" }); // gate FAILS -> loop-back edge
    const { outcome } = await processCard({ root, board, card: victim, runFn, cap: 10 });

    expect(outcome.status).toBe("waiting");
    const disk = await loadCard(root, victim.id);
    expect(disk.list).toBe("review"); // did NOT loop to implement
    expect(disk.waitingOn.grade).toBe("interference");
    expect(disk.waitingOn.until).toBe("fence");
    expect(disk.waitingOn.cardId).toBe(offender.id);
    expect(disk.waitingOn.offenderFenceSha).toBe(fence.record.sha);
    expect(disk.iterations).toBe(2); // (2+1 acquired) - 1 refunded = 2, cap not eaten
    expect(disk.events.some((e: any) => e.kind === "interference")).toBe(true);

    // offender learns it is blocking + gets an interference event
    const offDisk = await loadCard(root, offender.id);
    expect(offDisk.blocking).toContain(victim.id);
    expect(offDisk.events.some((e: any) => e.kind === "interference")).toBe(true);

    // mail record landed in BOTH runDirs
    const mailIn = (dir: string) => existsSync(join(dir, "coordination", "mail")) && readdirSync(join(dir, "coordination", "mail")).length > 0;
    expect(mailIn(vicRunDir)).toBe(true);
    expect(mailIn(offRunDir)).toBe(true);
  });
});

describe("processBatch — the D7 red path attributes before the loop-back", () => {
  it("a batched Test fail with foreign breakage makes the card wait, not loop", async () => {
    const repo = newRepo();
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    const root = kroot();
    const board = { ...seedBoard(), projects: { proj: { path: repo } } };

    writeFileSync(join(repo, "mod.ts"), "offender\n");
    let offender = await createCard(root, { title: "offender", project: "proj", list: "implement" });
    const offRunDir = join(root, "runs", "boff");
    mkdirSync(offRunDir, { recursive: true });
    writeFileSync(join(offRunDir, "touch-set.json"), JSON.stringify(ts({ files: ["mod.ts"] })));
    const fence = commitFence({ repoPath: repo, card: { id: offender.id, runId: "01BRO", project: "proj", title: "offender" }, phase: "implement", touchSet: ts({ files: ["mod.ts"] }) });
    offender = await saveCard(root, { ...offender, runId: "01BRO", runDir: offRunDir, fences: [fence.record] });

    let victim = await createCard(root, { title: "victim", project: "proj", list: "test" });
    const vicRunDir = join(root, "runs", "bvic");
    mkdirSync(vicRunDir, { recursive: true });
    writeFileSync(join(vicRunDir, "touch-set.json"), JSON.stringify(ts({ files: ["mod.ts"] })));
    victim = await saveCard(root, { ...victim, runId: "01BRV", runDir: vicRunDir, iterations: 1, fences: [{ phase: "plan", sha: anchor, empty: true }] });

    const batchRunFn = async () => ({ reply: `${victim.id} implement` }); // fail edge
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: [victim], batchRunFn, cap: 10 });

    expect(outcomes[0].status).toBe("waiting");
    expect(outcomes[0].reason).toBe("interference");
    const disk = await loadCard(root, victim.id);
    expect(disk.list).toBe("test"); // did NOT loop to implement
    expect(disk.waitingOn.grade).toBe("interference");
    expect(disk.iterations).toBe(1); // (1+1) - 1 = 1 refunded
  });
});
