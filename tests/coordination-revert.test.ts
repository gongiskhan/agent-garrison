// GARRISON-FLOW-V2 S2 (Q7/D8) — abandonment revert, the SERVER half. Boots the REAL
// own-port board server (makeRequestHandler over an ephemeral port) against a
// sandboxed board + a coordination-ON policy, and a REAL temp git repo per case (the
// card's `project` is the repo's absolute path, so repoPathForProject resolves it
// directly). It asserts the five behaviours the design (plan-coord-engine Q7) requires:
//   (a) POST /abandon builds the prepared-revert descriptor from EXACTLY the card's
//       trailer-attributed commits, parks the card with the abandoned flag, and
//       releases its coordination ledger intents;
//   (b) POST /revert without { confirm: true } is a 400 (never auto-applied);
//   (c) POST /revert with { confirm: true } lands the revert commits (verified in git
//       log) and flips the descriptor to "applied";
//   (d) the x-garrison-engine header on /abandon is a 403 (abandon is human-only);
//   (e) a revert that conflicts (a later commit touched the same line) is a 409 with
//       descriptor state "conflict" and a clean working tree (aborted cleanly).
//
// Sandboxed exactly like tests/coordination-server.test.ts + tests/coordination-
// attribution.test.ts: tmp GARRISON_KANBAN_DIR / GARRISON_HOME / GARRISON_RUNS_DIR and
// a written GARRISON_POLICY_PATH with { coordination: { enabled: true } }.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

// ── env sandbox (set BEFORE importing the server / board / coordination modules) ──
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "revert-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "revert-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "revert-runs-"));
const POLICY_PATH = join(mkdtempSync(join(tmpdir(), "revert-policy-")), "policy.json");
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = POLICY_PATH;
writeFileSync(POLICY_PATH, JSON.stringify({ coordination: { enabled: true } }));

// @ts-ignore — pure ESM .mjs, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard, loadCard, updateCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore
import { registerTouchSetIntent } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

// ── git helpers (same shape as tests/coordination-attribution.test.ts) ──
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}
function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "revert-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Tester");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed.txt"), "line1\nline2\nline3\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed");
  return repo;
}
// A commit carrying the card's Garrison-Card trailer (what prepareRevert --greps for).
function trailerCommit(repo: string, cardId: string, file: string, content: string, subject: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `${subject}\n\nGarrison-Card: ${cardId}`);
  return git(repo, "rev-parse", "HEAD").trim();
}
// A commit with NO garrison trailer (must NOT be attributed to any card).
function plainCommit(repo: string, file: string, content: string, subject: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", subject);
  return git(repo, "rev-parse", "HEAD").trim();
}

// The intents ledger path for a repo (the same derivation coordination.mjs uses:
// <GARRISON_HOME>/coord/intents/<sha1(resolve(repoPath)).slice(0,16)>.jsonl).
function ledgerFor(repo: string): string {
  const slug = crypto.createHash("sha1").update(resolve(repo)).digest("hex").slice(0, 16);
  return join(GARRISON_HOME, "coord", "intents", `${slug}.jsonl`);
}

// Create a card whose project IS the repo path (so repoPathForProject resolves via the
// absolute-path branch) and give it a runDir (where the descriptor is persisted).
async function makeCard(repo: string, title: string) {
  const card = await createCard(KANBAN_DIR, { title, project: repo, list: "implement" });
  const runDir = join(RUNS_DIR, card.id);
  mkdirSync(runDir, { recursive: true });
  await updateCardCAS(KANBAN_DIR, card.id, (c: any) => ({ ...c, runId: card.id, runDir }));
  return { id: card.id, runDir };
}
function descriptorOf(runDir: string): any {
  return JSON.parse(readFileSync(join(runDir, "coordination", "prepared-revert.json"), "utf8"));
}

let server: http.Server;
let base = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as any).port;
}
async function jsend(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { /* some errors have no body */ }
  return { status: r.status, body: parsed };
}

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);
  const opts = { root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 };
  server = http.createServer(makeRequestHandler(opts, join(FITTING, "dist")));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("(a) POST /abandon builds the descriptor, parks, releases intents", () => {
  it("descriptor = exactly the card's trailer commits; card parked + abandoned; ledger released", async () => {
    const repo = newRepo();
    const { id, runDir } = await makeCard(repo, "feature x");

    // Register a ledger intent so we can assert abandonment releases it.
    registerTouchSetIntent({
      repoPath: repo,
      card: { id, title: "feature x", project: repo, runId: id },
      touchSet: { files: ["a.txt"], dirs: [] }
    });
    expect(readFileSync(ledgerFor(repo), "utf8")).toContain(`kanban:${id}`);

    // Two commits carry THIS card's trailer; one plain commit does not.
    const a = trailerCommit(repo, id, "a.txt", "aaa\n", "card work a");
    const b = trailerCommit(repo, id, "b.txt", "bbb\n", "card work b");
    const plain = plainCommit(repo, "c.txt", "ccc\n", "unrelated work by no card");

    const res = await jsend("POST", `/cards/${id}/abandon`);
    expect(res.status).toBe(200);
    expect(res.body.card.list).toBe("needs-attention");
    expect(res.body.card.preparedRevert.state).toBe("prepared");
    expect(res.body.card.preparedRevert.commits).toBe(2);

    // The durable descriptor names EXACTLY the two trailer commits (newest first),
    // never the plain one.
    const d = descriptorOf(runDir);
    expect(d.state).toBe("prepared");
    expect(d.commits).toEqual([b, a]);
    expect(d.commits).not.toContain(plain);

    // Parked in needs-attention with the abandoned flag + the exact reason string. The
    // abandoned flag is what releases terminal-waiters on the next engine reevaluation.
    const disk = await loadCard(KANBAN_DIR, id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.status).toBe("needs-attention");
    expect(disk.abandoned).toBe(true);
    expect(disk.attentionReason).toBe("Abandoned - prepared revert of 2 commits ready; confirm to apply");

    // The card's ledger intent row is gone.
    expect(readFileSync(ledgerFor(repo), "utf8")).not.toContain(`kanban:${id}`);
  });
});

describe("(d) /abandon is human-only", () => {
  it("the x-garrison-engine header is rejected with 403 and leaves the card untouched", async () => {
    const repo = newRepo();
    const { id } = await makeCard(repo, "engine tries to abandon");
    trailerCommit(repo, id, "x.txt", "x\n", "card work");

    const res = await jsend("POST", `/cards/${id}/abandon`, undefined, { "x-garrison-engine": "1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human-only");

    const disk = await loadCard(KANBAN_DIR, id);
    expect(disk.abandoned ?? false).toBe(false);
    expect(disk.list).toBe("implement");
    expect(disk.preparedRevert ?? null).toBeNull();
  });
});

describe("(b) POST /revert requires an explicit confirm", () => {
  it("no body → 400; { confirm: false } → 400; the card is not touched", async () => {
    const repo = newRepo();
    const { id } = await makeCard(repo, "needs confirm");
    trailerCommit(repo, id, "f.txt", "f\n", "card work");
    await jsend("POST", `/cards/${id}/abandon`);

    const noBody = await jsend("POST", `/cards/${id}/revert`);
    expect(noBody.status).toBe(400);
    const falseConfirm = await jsend("POST", `/cards/${id}/revert`, { confirm: false });
    expect(falseConfirm.status).toBe(400);

    // Still prepared — nothing applied.
    const disk = await loadCard(KANBAN_DIR, id);
    expect(disk.preparedRevert.state).toBe("prepared");
  });
});

describe("(c) POST /revert { confirm: true } applies the revert", () => {
  it("the revert commits land in git (with the trailers) and the descriptor flips to applied", async () => {
    const repo = newRepo();
    const { id, runDir } = await makeCard(repo, "revertable feature");
    // A commit that ADDS a file — reverting it removes the file, a clean assertion.
    trailerCommit(repo, id, "feat.txt", "the feature\n", "add feature");
    expect(existsSync(join(repo, "feat.txt"))).toBe(true);

    await jsend("POST", `/cards/${id}/abandon`);
    const res = await jsend("POST", `/cards/${id}/revert`, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.card.preparedRevert.state).toBe("applied");
    expect(res.body.reverted.length).toBe(1);

    // The revert actually landed: the added file is gone and a Garrison-Revert commit
    // carrying the card trailer is at HEAD.
    expect(existsSync(join(repo, "feat.txt"))).toBe(false);
    const bodies = git(repo, "log", "--format=%B");
    expect(bodies).toContain("Garrison-Revert: true");
    expect(bodies).toContain(`Garrison-Card: ${id}`);

    // The descriptor on disk is applied with the revert commit recorded.
    const d = descriptorOf(runDir);
    expect(d.state).toBe("applied");
    expect(Array.isArray(d.revertCommits) && d.revertCommits.length).toBe(1);

    // The card stays parked in needs-attention for the user to archive.
    const disk = await loadCard(KANBAN_DIR, id);
    expect(disk.list).toBe("needs-attention");
  });
});

describe("(e) a conflicting revert aborts cleanly", () => {
  it("→ 409, descriptor state conflict, working tree left clean and nothing applied", async () => {
    const repo = newRepo();
    const { id, runDir } = await makeCard(repo, "conflicting feature");
    // Card commit changes line2; a LATER plain commit changes the SAME line, so
    // reverting the card commit cannot apply cleanly.
    trailerCommit(repo, id, "seed.txt", "line1\nCARD-CHANGE\nline3\n", "card changes line2");
    plainCommit(repo, "seed.txt", "line1\nOTHER-CHANGE\nline3\n", "another change to line2");

    const ab = await jsend("POST", `/cards/${id}/abandon`);
    expect(ab.status).toBe(200);
    // conflictRisk flagged seed.txt (a later foreign commit touched the same file).
    expect(descriptorOf(runDir).conflictRisk.length).toBeGreaterThan(0);
    expect(ab.body.card.preparedRevert.conflictRisk).toBeGreaterThan(0);

    const res = await jsend("POST", `/cards/${id}/revert`, { confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.preparedRevert.state).toBe("conflict");

    // Aborted cleanly: no half-reverted state left behind, and HEAD still holds the
    // later change (nothing was applied).
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(join(repo, "seed.txt"), "utf8")).toContain("OTHER-CHANGE");
    expect(descriptorOf(runDir).state).toBe("conflict");

    // The descriptor is now non-prepared, so a re-confirm is refused (never retried
    // silently).
    const again = await jsend("POST", `/cards/${id}/revert`, { confirm: true });
    expect(again.status).toBe(409);
  });
});
