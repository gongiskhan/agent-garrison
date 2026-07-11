import { describe, it, expect } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// S6 (D19): runDirs mint ABSOLUTE under the evidence home — sandbox it so
// tests never write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { ulid } from "../fittings/seed/kanban-loop/lib/ulid.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard, saveCardCAS, deriveMembership, loadAllCards } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { parseNextList, buildCardPrompt, classificationFor, processCard, processBatch, getList, validNextFor, triggerFor, isInteractive, mintRunFields, resolveBacklogInference, groupCardsByProject, parseBatchVerdicts } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

const board = {
  version: 2,
  lists: [
    {
      id: "implement", title: "Implement", kind: "agent", trigger: "immediate", skill: "garrison-implement",
      taskType: "code", tier: "T2-deep", executePrompt: "Implement it.", routerPrompt: "Choose next.",
      validNext: ["review"]
    },
    { id: "review", title: "Review", kind: "agent", trigger: "immediate", validNext: ["adversarial-review", "implement"] },
    { id: "todo", title: "To Do", kind: "manual", trigger: "manual", validNext: ["implement"] },
    {
      id: "test", title: "Test", kind: "agent", trigger: "scheduler-beat", batched: true, skill: "garrison-test",
      taskType: "code", tier: "T1-standard",
      executePrompt: "Test it.", routerPrompt: "verdict per card.",
      validNext: ["adversarial-test", "implement"]
    },
    { id: "adversarial-test", title: "Adv Test", kind: "agent", trigger: "immediate", validNext: ["walkthrough", "implement"] },
    { id: "discuss", title: "Discuss", kind: "agent-interactive", trigger: "manual", interactive: true, validNext: ["plan"] }
  ]
};
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-"));

describe("kanban ulid (s5)", () => {
  it("is 26 chars and sorts by creation time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toHaveLength(26);
    expect(b).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});

describe("kanban board (s5 + v1b pointer fields)", () => {
  it("createCard writes a ULID-id card; loadCard reads it; membership is derived", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo", goalMode: true, acceptance: "ACC" });
    expect(c.id).toHaveLength(26);
    expect(c.list).toBe("todo");
    expect(c.status).toBe("ok");
    expect(c.iterations).toBe(0);
    expect(c.goalMode).toBe(true);
    expect((await loadCard(root, c.id)).title).toBe("T");
    expect(deriveMembership(await loadAllCards(root))).toEqual({ todo: [c.id] });
    expect(JSON.parse(readFileSync(join(root, "cards", c.id, "card.json"), "utf8")).id).toBe(c.id);
  });

  it("createCard seeds the V1b pointer fields as empty pointers (FINDING 10 — no inlined bodies)", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "backlog" });
    expect(c.runId).toBeNull();
    expect(c.runDir).toBeNull();
    expect(c.sliceId).toBeNull();
    expect(c.sessionIds).toEqual([]);
    expect(c.briefPath).toBeNull();
    expect(c.videoUrl).toBeNull();
    // The card holds POINTERS only — no field carries a document body.
    const disk = JSON.parse(readFileSync(join(root, "cards", c.id, "card.json"), "utf8"));
    expect(Object.keys(disk)).toEqual(
      expect.arrayContaining(["runId", "runDir", "sliceId", "sessionIds", "briefPath", "videoUrl"])
    );
  });
});

describe("kanban CAS (s5 cross-model gate — lost-update guard)", () => {
  it("saveCardCAS rejects a stale-rev write so a concurrent tick / manual edit is not clobbered", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo" });
    expect(c.rev).toBe(0);
    const w1 = await saveCardCAS(root, { ...c, title: "A" }, 0);
    expect(w1.ok).toBe(true);
    expect(w1.card.rev).toBe(1);
    const w2 = await saveCardCAS(root, { ...c, title: "B" }, 0);
    expect(w2.ok).toBe(false);
    expect(w2.conflict).toBe(true);
    expect((await loadCard(root, c.id)).title).toBe("A");
  });

  it("processCard increments rev and a re-run with the STALE card skips on conflict", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    const runFn = async () => ({ reply: "review" });
    const { card: moved } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(moved.rev).toBeGreaterThan(card.rev);
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("conflict");
  });

  it("CONCURRENT saveCardCAS at the same rev — the per-card O_EXCL lock lets EXACTLY one win (no double-acquire)", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "implement" });
    // Fire many racing CAS writes that all read rev 0. The lock serializes the
    // read-compare-write, so exactly one observes rev 0 and commits; the rest see the
    // bumped rev and conflict. This is the double-acquire / double-mint guard.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => saveCardCAS(root, { ...c, title: `w${i}` }, 0))
    );
    const ok = results.filter((r: any) => r.ok);
    const conflicts = results.filter((r: any) => !r.ok && r.conflict);
    expect(ok.length).toBe(1);
    expect(conflicts.length).toBe(7);
    expect((await loadCard(root, c.id)).rev).toBe(1); // bumped exactly once
  });

  it("CONCURRENT processCard ticks mint a runId at most ONCE (CAS-safe first-entry mint)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    const runFn = async () => ({ reply: "review" });
    // Two ticks race on the card's first agent-list entry; only one acquires + mints.
    const [a, b] = await Promise.all([
      processCard({ root, board, card, runFn, cap: 10 }),
      processCard({ root, board, card, runFn, cap: 10 }),
    ]);
    const moved = [a, b].filter((r) => r.outcome.status === "moved");
    const skipped = [a, b].filter((r) => r.outcome.status === "skipped" && r.outcome.reason === "conflict");
    expect(moved.length).toBe(1);
    expect(skipped.length).toBe(1);
    const disk = await loadCard(root, card.id);
    expect(typeof disk.runId).toBe("string");
    expect(disk.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "no-project", disk.runId)); // S6: absolute, evidence home
    expect(disk.iterations).toBe(1); // ran once, not twice
  });
});

describe("kanban engine — parse + prompt + classification", () => {
  it("parseNextList exact-matches the final line against validNext (no fuzzy)", () => {
    expect(parseNextList("did stuff\nreview", ["review", "implement"])).toBe("review");
    expect(parseNextList("review ", ["review"])).toBe("review");
    expect(parseNextList("reviewing", ["review"])).toBeNull();
    expect(parseNextList("done", ["review", "test"])).toBeNull();
    expect(parseNextList("", ["review"])).toBeNull();
  });

  it("buildCardPrompt: goal-mode prepends /goal + acceptance and injects validNext ids", () => {
    const list = getList(board, "implement");
    const vn = validNextFor(board, "implement");
    const g = buildCardPrompt({ list, card: { goalMode: true, acceptance: "ACC" }, validNext: vn });
    expect(g.startsWith("/goal ACC")).toBe(true);
    expect(g).toContain("review");
    expect(g).toContain("Implement it.");
    expect(buildCardPrompt({ list, card: { goalMode: false }, validNext: vn })).not.toContain("/goal");
  });

  it("buildCardPrompt threads the card's runDir + sliceId into the prompt as literal text (FINDING 4/10)", () => {
    const list = getList(board, "implement");
    const vn = validNextFor(board, "implement");
    const p = buildCardPrompt({ list, card: { runDir: "docs/autothing/runs/ABC", sliceId: "slice-1" }, validNext: vn });
    expect(p).toContain("Run directory");
    expect(p).toContain("docs/autothing/runs/ABC");
    expect(p).toContain("slice-1");
    // A card with no runDir does not leak a run-directory line.
    expect(buildCardPrompt({ list, card: {}, validNext: vn })).not.toContain("Run directory");
  });

  it("classificationFor derives from the list's PHASE (D15 — per-list pins are dead)", () => {
    expect(classificationFor(getList(board, "implement"))).toEqual({ taskType: "implement", tier: "T1-standard" });
    expect(classificationFor(getList(board, "review"))).toEqual({ taskType: "review", tier: "T1-standard" });
  });
});

describe("kanban engine — triggers + runId minting", () => {
  it("triggerFor defaults agent lists to immediate and manual lists to manual, honoring an explicit trigger", () => {
    expect(triggerFor(getList(board, "implement"))).toBe("immediate");
    expect(triggerFor(getList(board, "todo"))).toBe("manual");
    expect(triggerFor(getList(board, "test"))).toBe("scheduler-beat");
    expect(triggerFor({ kind: "agent" })).toBe("immediate"); // no trigger field → immediate
    expect(triggerFor({ kind: "manual" })).toBe("manual");
  });

  it("isInteractive flags the Discuss-style list", () => {
    expect(isInteractive(getList(board, "discuss"))).toBe(true);
    expect(isInteractive(getList(board, "implement"))).toBe(false);
  });

  it("mintRunFields mints once (idempotent) with a project-relative runDir", () => {
    const m = mintRunFields({ runId: null, runDir: null }, () => 1234);
    expect(m.runId).toHaveLength(26);
    expect(m.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "no-project", m.runId)); // S6: absolute
    // already minted → null (no re-mint)
    expect(mintRunFields({ runId: "X", runDir: "docs/autothing/runs/X" })).toBeNull();
  });

  it("processCard mints runId + runDir on the card's FIRST agent-list entry and threads runDir into the prompt", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    let seen = "";
    const runFn = async ({ prompt }: { prompt: string }) => { seen = prompt; return { reply: "review" }; };
    const { card: updated, outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(updated.runId).toHaveLength(26);
    expect(updated.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "no-project", updated.runId));
    // the runDir reached the execute-prompt as literal text
    expect(seen).toContain(updated.runDir);
    // a second entry does NOT re-mint
    const reentry = await processCard({ root, board, card: updated, runFn, cap: 10 });
    expect(reentry.card.runId).toBe(updated.runId);
  });

  it("processCard skips an interactive list (board opens the web chat instead)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "discuss" });
    const { outcome } = await processCard({ root, board, card, runFn: async () => ({ reply: "plan" }) });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("interactive");
  });
});

describe("kanban engine — transitions (FINDING 5)", () => {
  it("processCard moves the card on an exact router match + increments iterations + logs", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    let seen = "";
    const runFn = async ({ prompt }: { prompt: string }) => { seen = prompt; return { reply: "wrote code\nreview" }; };
    const { card: updated, outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("review");
    expect(updated.list).toBe("review");
    expect(updated.status).toBe("ok");
    expect(updated.iterations).toBe(1);
    expect(seen).toContain("Implement it.");
    expect(existsSync(join(root, "cards", card.id, "log-1.md"))).toBe(true);
  });

  it("a Review PASS moves to adversarial-review; a Review FAIL moves to implement (FINDING 5)", async () => {
    const root = tmp();
    const pass = await createCard(root, { title: "P", list: "review" });
    const passed = await processCard({ root, board, card: pass, runFn: async () => ({ reply: "clean\nadversarial-review" }) });
    expect(passed.outcome.to).toBe("adversarial-review");

    const fail = await createCard(root, { title: "F", list: "review" });
    const failed = await processCard({ root, board, card: fail, runFn: async () => ({ reply: "found a bug\nimplement" }) });
    expect(failed.outcome.to).toBe("implement");
  });

  it("parks in needs-attention on a no-exact-match verdict", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    const { card: updated, outcome } = await processCard({ root, board, card, runFn: async () => ({ reply: "maybe review-ish" }) });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-exact-match");
    expect(updated.status).toBe("needs-attention");
  });

  it("parks on an iteration-cap breach without running (the convergence guard — Decision 7)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    let ran = false;
    const runFn = async () => { ran = true; return { reply: "review" }; };
    const { outcome } = await processCard({ root, board, card: { ...card, iterations: 10 }, runFn, cap: 10 });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("iteration-cap");
    expect(ran).toBe(false);
  });

  it("parks on a runFn throw (run-failed) and skips a manual list", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    const thrown = await processCard({ root, board, card, runFn: async () => { throw new Error("boom"); } });
    expect(thrown.outcome.status).toBe("needs-attention");
    expect(thrown.outcome.reason).toBe("run-failed");

    const manual = await createCard(root, { title: "M", list: "todo" });
    const skipped = await processCard({ root, board, card: manual, runFn: async () => ({ reply: "implement" }) });
    expect(skipped.outcome.status).toBe("skipped");
  });
});

describe("kanban engine — backlog inference (FINDING 3)", () => {
  it("applies the inferred project only at >=70% confidence; below that it parks", () => {
    const card = { title: "(untitled)", project: null, status: "ok" };
    const confident = resolveBacklogInference(card, { title: "Add login", project: "garrison", projectConfidence: 0.82 });
    expect(confident.park).toBe(false);
    expect(confident.card.title).toBe("Add login");
    expect(confident.card.project).toBe("garrison");

    const lowConf = resolveBacklogInference(card, { title: "Add login", project: "garrison", projectConfidence: 0.4 });
    expect(lowConf.park).toBe(true);
    expect(lowConf.reason).toBe("low-confidence-project");
    expect(lowConf.card.title).toBe("Add login"); // title still inferred eagerly
    expect(lowConf.card.project).toBeNull();
    expect(lowConf.card.status).toBe("needs-attention");
  });

  it("parks when no project is inferred at all even with high confidence", () => {
    const r = resolveBacklogInference({ title: "x", project: null }, { title: "T", project: null, projectConfidence: 0.99 });
    expect(r.park).toBe(true);
  });
});

describe("kanban engine — Test batching (FINDING 7)", () => {
  it("groupCardsByProject groups a list's eligible cards by project and skips running/parked", () => {
    const cards = [
      { id: "a", list: "test", project: "p1", status: "ok" },
      { id: "b", list: "test", project: "p1", status: "ok" },
      { id: "c", list: "test", project: "p2", status: "ok" },
      { id: "d", list: "test", project: "p1", status: "running" }, // skipped
      { id: "e", list: "review", project: "p1", status: "ok" }     // wrong list
    ];
    const g = groupCardsByProject(cards, "test");
    expect(g.p1.map((c: any) => c.id)).toEqual(["a", "b"]);
    expect(g.p2.map((c: any) => c.id)).toEqual(["c"]);
  });

  it("parseBatchVerdicts exact-matches each card's verdict against THAT card's validNext", () => {
    const cards = [
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FA0", list: "test" },
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FA1", list: "test" },
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FA2", list: "test" }
    ];
    const reply = [
      "01ARZ3NDEKTSV4RRFFQ69G5FA0 adversarial-test",   // pass
      "01ARZ3NDEKTSV4RRFFQ69G5FA1: implement",          // fail (colon separator)
      "01ARZ3NDEKTSV4RRFFQ69G5FA2 -> done"              // not a valid next for test → null
    ].join("\n");
    const v = parseBatchVerdicts(reply, cards, board);
    expect(v["01ARZ3NDEKTSV4RRFFQ69G5FA0"]).toBe("adversarial-test");
    expect(v["01ARZ3NDEKTSV4RRFFQ69G5FA1"]).toBe("implement");
    expect(v["01ARZ3NDEKTSV4RRFFQ69G5FA2"]).toBeNull(); // no exact match → null
  });

  it("processBatch runs ONE session per project and moves each card per its own verdict", async () => {
    const root = tmp();
    const a = await createCard(root, { title: "A", list: "test", project: "p1" });
    const b = await createCard(root, { title: "B", list: "test", project: "p1" });
    const c = await createCard(root, { title: "C", list: "test", project: "p2" });

    const sessions: Record<string, string[]> = {};
    const batchRunFn = async ({ project, cards }: { project: string; cards: any[] }) => {
      sessions[project] = cards.map((x) => x.id);
      // p1: a passes (adversarial-test), b fails (implement). p2: c passes.
      const lines = cards.map((x) =>
        project === "p1" && x.title === "B" ? `${x.id} implement` : `${x.id} adversarial-test`
      );
      return { reply: lines.join("\n") };
    };

    const all = await loadAllCards(root);
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: all, batchRunFn, cap: 10 });

    // one session per project, covering that project's cards
    expect(Object.keys(sessions).sort()).toEqual(["p1", "p2"]);
    expect(sessions.p1.sort()).toEqual([a.id, b.id].sort());
    expect(sessions.p2).toEqual([c.id]);

    const byId = Object.fromEntries(outcomes.map((o: any) => [o.id, o]));
    expect(byId[a.id].to).toBe("adversarial-test");
    expect(byId[b.id].to).toBe("implement");
    expect(byId[c.id].to).toBe("adversarial-test");

    // verdicts landed on disk + runId was minted on first agent-list entry
    expect((await loadCard(root, a.id)).list).toBe("adversarial-test");
    expect((await loadCard(root, b.id)).list).toBe("implement");
    expect((await loadCard(root, a.id)).runId).toHaveLength(26);
  });

  it("processBatch parks a card on a no-match verdict and parks on cap breach without running it", async () => {
    const root = tmp();
    const ok = await createCard(root, { title: "OK", list: "test", project: "p1" });
    const capped = await createCard(root, { title: "CAP", list: "test", project: "p1" });
    // push capped to the cap
    await saveCardCAS(root, { ...capped, iterations: 10 }, capped.rev);

    let rosterSize = 0;
    const batchRunFn = async ({ cards }: { cards: any[] }) => {
      rosterSize = cards.length;
      // emit a junk verdict for the ok card → no exact match → park
      return { reply: `${cards[0].id} not-a-list` };
    };
    const all = await loadAllCards(root);
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: all, batchRunFn, cap: 10 });
    const byId = Object.fromEntries(outcomes.map((o: any) => [o.id, o]));
    // capped card parked without entering the session roster
    expect(rosterSize).toBe(1);
    expect(byId[capped.id].status).toBe("needs-attention");
    expect(byId[capped.id].reason).toBe("iteration-cap");
    expect(byId[ok.id].status).toBe("needs-attention");
    expect(byId[ok.id].reason).toBe("no-exact-match");
  });
});

describe("kanban seed board (FINDING 2 — full pipeline)", () => {
  const seeded = seedBoard();
  const byId = Object.fromEntries(seeded.lists.map((l: any) => [l.id, l]));

  it("has the full pipeline in order with the exact list ids", () => {
    expect(seeded.lists.map((l: any) => l.id)).toEqual([
      "backlog", "todo", "discuss", "plan", "implement", "review", "adversarial-review",
      "test", "adversarial-test", "walkthrough", "validate", "done", "needs-attention"
    ]);
  });

  it("every list carries a trigger (immediate | manual | scheduler-beat)", () => {
    for (const l of seeded.lists) {
      expect(["immediate", "manual", "scheduler-beat"]).toContain(triggerFor(l));
    }
    expect(triggerFor(byId.test)).toBe("scheduler-beat");
    expect(triggerFor(byId.plan)).toBe("immediate");
    expect(triggerFor(byId.backlog)).toBe("manual");
  });

  it("each agent list maps to a PHASE and validNext only (D15 — no per-list pins)", () => {
    // The list IS the phase; skill/model/effort resolve from the compiled policy.
    for (const id of ["plan", "implement", "review", "adversarial-review", "test", "adversarial-test", "walkthrough", "validate"]) {
      expect(byId[id].phase).toBe(id);
      expect(byId[id].skill).toBeUndefined();
      expect(byId[id].taskType).toBeUndefined();
      expect(byId[id].tier).toBeUndefined();
      expect(byId[id].mode).toBeUndefined();
    }
    expect(classificationFor(byId.plan)).toEqual({ taskType: "plan", tier: "T1-standard" });
    expect(byId.plan.validNext).toEqual(["implement"]);
    expect(byId.implement.validNext).toEqual(["review"]);
    expect(byId.review.validNext).toEqual(["adversarial-review", "implement"]);
    expect(byId["adversarial-review"].validNext).toEqual(["test", "implement"]);
    expect(byId.test.batched).toBe(true);
    expect(byId.test.validNext).toEqual(["adversarial-test", "implement"]);
    expect(byId["adversarial-test"].validNext).toEqual(["walkthrough", "implement"]);
    expect(byId.walkthrough.validNext).toEqual(["validate", "implement"]);
    expect(byId.validate.validNext).toEqual(["done", "implement"]);
  });

  it("manual + interactive + terminal lists are shaped right", () => {
    expect(byId.backlog.kind).toBe("manual");
    expect(byId.todo.validNext).toEqual(["discuss", "plan"]);
    expect(byId.discuss.kind).toBe("agent-interactive");
    expect(isInteractive(byId.discuss)).toBe(true);
    // D15: per-list mode is dead — the gateway resolves the face.
    expect(byId.discuss.mode).toBeUndefined();
    expect(byId.discuss.validNext).toEqual(["plan"]);
    expect(byId.done.terminal).toBe(true);
    expect(byId.done.validNext).toEqual([]);
    expect(byId["needs-attention"].notifyOnEntry).toBe(true);
    expect(byId["needs-attention"].validNext).toEqual(["todo", "plan", "implement"]);
  });

  it("every validNext token is a real list id (so a router reply can exact-match)", () => {
    const ids = new Set(seeded.lists.map((l: any) => l.id));
    for (const l of seeded.lists) {
      for (const n of l.validNext || []) expect(ids.has(n)).toBe(true);
    }
  });

  it("walks the full agent pipeline end-to-end with stub passes (Start → done)", async () => {
    const root = tmp();
    // Start = drop onto the first agent list (plan), as the engine sees it.
    let card = await createCard(root, { title: "Build X", list: "plan", project: "p1" });
    // the happy path each list takes its first validNext
    const passReply: Record<string, string> = {
      plan: "implement",
      implement: "review",
      review: "adversarial-review",
      "adversarial-review": "test",
      "adversarial-test": "walkthrough",
      walkthrough: "validate",
      validate: "done"
    };
    // Walkthrough now ENFORCES evidence on disk before advancing, so the stub must
    // actually leave a file under <cwd>/<runDir>/evidence/ when it runs that step.
    const cwd = mkdtempSync(join(tmpdir(), "kanban-pipe-cwd-"));
    const runFn = async ({ card: c }: { card: any }) => {
      if (c.list === "walkthrough") {
        mkdirSync(join(c.runDir, "evidence"), { recursive: true }); // S6: runDir absolute
        writeFileSync(join(c.runDir, "evidence", "evidence.md"), "# evidence\nstub\n");
      }
      return { reply: passReply[c.list] };
    };
    // walk immediate lists; the test list is scheduler-beat/batched so drive it via processBatch.
    const guard = 20;
    let steps = 0;
    while (card.list !== "done" && steps++ < guard) {
      const list = getList(seeded, card.list);
      if (triggerFor(list) === "scheduler-beat") {
        const all = await loadAllCards(root);
        const batchRunFn = async ({ cards }: { cards: any[] }) => ({ reply: cards.map((x) => `${x.id} adversarial-test`).join("\n") });
        await processBatch({ root, board: seeded, listId: card.list, cards: all, batchRunFn, cap: 10 });
        card = await loadCard(root, card.id);
        continue;
      }
      const { card: moved } = await processCard({ root, board: seeded, card, runFn, cap: 20, cwd });
      card = moved;
    }
    expect(card.list).toBe("done");
    expect(card.runId).toHaveLength(26); // minted on the first (plan) entry
  });
});
