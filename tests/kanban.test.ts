import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { ulid } from "../fittings/seed/kanban-loop/lib/ulid.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard, saveCardCAS, deriveMembership, loadAllCards } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { parseNextList, buildCardPrompt, classificationFor, processCard, getList, validNextFor } from "../fittings/seed/kanban-loop/lib/engine.mjs";

const board = {
  version: 1,
  lists: [
    {
      id: "implement", title: "Implement", kind: "agent", skill: "garrison-architecture",
      taskType: "code", tier: "T2-deep", executePrompt: "Implement it.", routerPrompt: "Choose next.",
      validNext: ["review", "needs-attention"]
    },
    { id: "review", title: "Review", kind: "agent", validNext: ["test", "implement"] },
    { id: "todo", title: "To Do", kind: "manual", validNext: ["implement"] }
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

describe("kanban board (s5)", () => {
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
});

describe("kanban CAS (s5 cross-model gate — lost-update guard)", () => {
  it("saveCardCAS rejects a stale-rev write so a concurrent tick / manual edit is not clobbered", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo" });
    expect(c.rev).toBe(0);
    // first writer holding rev 0 → CAS ok, disk rev advances to 1
    const w1 = await saveCardCAS(root, { ...c, title: "A" }, 0);
    expect(w1.ok).toBe(true);
    expect(w1.card.rev).toBe(1);
    // a second writer still holding the stale rev 0 → conflict, disk untouched
    const w2 = await saveCardCAS(root, { ...c, title: "B" }, 0);
    expect(w2.ok).toBe(false);
    expect(w2.conflict).toBe(true);
    expect((await loadCard(root, c.id)).title).toBe("A"); // "B" did NOT overwrite "A"
  });

  it("processCard increments rev and a re-run with the STALE card skips on conflict", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    const runFn = async () => ({ reply: "review" });
    const { card: moved } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(moved.rev).toBeGreaterThan(card.rev); // rev advanced through running + terminal writes
    // re-processing with the original (stale-rev) card object must not double-process
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("conflict");
  });
});

describe("kanban engine (s5)", () => {
  it("parseNextList exact-matches the final line against validNext (no fuzzy)", () => {
    expect(parseNextList("did stuff\nreview", ["review", "needs-attention"])).toBe("review");
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
    expect(g).toContain("review, needs-attention");
    expect(g).toContain("Implement it.");
    expect(buildCardPrompt({ list, card: { goalMode: false }, validNext: vn })).not.toContain("/goal");
  });

  it("classificationFor returns the list's explicit {taskType,tier} (§10)", () => {
    expect(classificationFor(getList(board, "implement"))).toEqual({ taskType: "code", tier: "T2-deep" });
    expect(classificationFor(getList(board, "review"))).toEqual({ taskType: "other", tier: "T1-standard" });
  });

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

  it("parks in needs-attention on a no-exact-match verdict", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "implement" });
    const { card: updated, outcome } = await processCard({ root, board, card, runFn: async () => ({ reply: "maybe review-ish" }) });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-exact-match");
    expect(updated.status).toBe("needs-attention");
  });

  it("parks on an iteration-cap breach without running", async () => {
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
