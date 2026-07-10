// V1d execution-visibility regression. The user added a no-project card, moved it to
// Plan, and it parked in 35s with the cryptic "did not end with a valid next list" and
// zero visibility — because (a) the operative was never TOLD what the card was
// (buildCardPrompt omitted title/description unless goalMode), (b) an empty reply was
// treated identically to a real wrong-format reply, and (c) nothing recorded WHAT
// happened. These tests pin the fixes: the prompt carries the work item; outcomes are
// distinguished (empty vs no-match vs moved) with honest reasons + the operative's
// actual reply; every transition appends a timeline event; and project inference parses.
import { describe, it, expect } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { buildCardPrompt, processCard, processBatch, withEvent, replySnippet } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, loadAllCards } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { parseInferredProject, buildInferencePrompt, inferProject } from "../fittings/seed/kanban-loop/lib/infer-project.mjs";

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-vis-"));
const planList = board.lists.find((l: any) => l.id === "plan");

describe("V1d buildCardPrompt — the operative is TOLD what the card is", () => {
  it("includes the title, description and project even WITHOUT goalMode", () => {
    const p = buildCardPrompt({
      list: planList,
      card: { title: "site word change", description: "change Automatizar to Automático", project: "ekoa" },
      validNext: ["implement"]
    });
    expect(p).toContain("site word change");
    expect(p).toContain("Automatizar");
    expect(p).toContain("ekoa");
  });

  it("a no-project card asks the operative to INFER the project", () => {
    const p = buildCardPrompt({ list: planList, card: { title: "x", description: "do a thing" }, validNext: ["implement"] });
    expect(p.toLowerCase()).toContain("infer");
    expect(p.toLowerCase()).toContain("none assigned");
  });

  it("forces a forward choice even when the work is already done, and demands a bare final-line token", () => {
    const p = buildCardPrompt({ list: planList, card: { title: "x", description: "d", project: "p" }, validNext: ["implement"] });
    expect(p.toLowerCase()).toMatch(/already complete|nothing left to do/);
    expect(p.toLowerCase()).toContain("do not explain instead of choosing");
    expect(p.toLowerCase()).toContain("final line");
    expect(p).toContain("implement"); // the validNext token is still injected verbatim
  });
});

describe("V1d processCard — honest, distinguished outcomes + a timeline", () => {
  it("an EMPTY reply parks with an empty-output reason (NOT 'no valid next list') + events", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p", list: "plan" });
    const { outcome } = await processCard({ root, board, card, runFn: async () => ({ reply: "   " }), cap: 10 });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("empty-reply");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/no output|returned nothing/i);
    expect(disk.attentionReason).not.toMatch(/did not end with a valid next list/i);
    const kinds = disk.events.map((e: any) => e.kind);
    expect(kinds).toContain("dispatch");
    expect(kinds).toContain("parked");
    expect(disk.runningSince).toBeNull();
  });

  it("a NON-empty no-match reply parks AND surfaces WHAT the operative said", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p", list: "plan" });
    const reply = "I need more information about the repository before I can plan this.";
    const { outcome } = await processCard({ root, board, card, runFn: async () => ({ reply }), cap: 10 });
    expect(outcome.reason).toBe("no-exact-match");
    const disk = await loadCard(root, card.id);
    expect(disk.lastReply).toContain("more information");
    expect(disk.attentionReason).toContain("more information"); // the snippet is IN the reason
    const parked = disk.events.find((e: any) => e.kind === "parked");
    expect(parked.detail).toContain(reply); // the FULL reply is in the event detail
  });

  it("a routed reply records a routed event, sets lastReply, clears runningSince", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p", list: "plan" });
    const { outcome } = await processCard({ root, board, card, runFn: async () => ({ reply: "all set\nimplement" }), cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("implement");
    const disk = await loadCard(root, card.id);
    expect(disk.runningSince).toBeNull();
    expect(disk.events.some((e: any) => e.kind === "routed")).toBe(true);
  });

  it("the acquire records a 'dispatch' event with runningSince before the run", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p", list: "plan" });
    let sawRunning: any = null;
    const runFn = async () => { sawRunning = await loadCard(root, card.id); return { reply: "implement" }; };
    await processCard({ root, board, card, runFn, cap: 10 });
    expect(sawRunning.status).toBe("running");
    expect(typeof sawRunning.runningSince).toBe("string");
    expect(sawRunning.events.some((e: any) => e.kind === "dispatch")).toBe(true);
  });

  it("createCard seeds a 'created' event", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", list: "backlog" });
    expect(card.events[0].kind).toBe("created");
  });

  it("NUDGES a verdict when the operative narrates instead of emitting the token (the validate park)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p", list: "validate" });
    // First turn: a mid-action narration with no verdict (the exact failure: "Writing the
    // durable gate record now."). Follow-up turn: the bare token.
    let call = 0;
    const runFn = async () => {
      call += 1;
      return { reply: call === 1 ? "Writing the durable gate record now." : "done" };
    };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(call).toBe(2);                 // one main turn + one nudge
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("done");
    expect(outcome.nudged).toBe(true);
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("done");
    expect(disk.events.some((e: any) => e.kind === "routed" && /follow-up/.test(e.message))).toBe(true);
  });

  it("parks (no infinite retry) when even the nudge fails to produce a verdict", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p", list: "validate" });
    let call = 0;
    const runFn = async () => { call += 1; return { reply: "still just narrating, no token" }; };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(call).toBe(2);                  // main + exactly ONE nudge, then park
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-exact-match");
  });
});

describe("V1d processBatch — batched parks are honest too (reachable via the Run button on Test)", () => {
  it("a no-verdict card MOVES to needs-attention with a reason + parked/dispatch events", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", description: "d", project: "p1", list: "test" });
    const batchRunFn = async () => ({ reply: "just prose, no `<cardId> next-list` verdict line here" });
    const all = await loadAllCards(root);
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: all, batchRunFn, cap: 10 });
    expect(outcomes[0].reason).toBe("no-exact-match");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");   // actually moved to the column, not just flagged
    expect(disk.parkedFrom).toBe("test");
    expect(disk.attentionReason).toMatch(/no valid verdict/i);
    expect(disk.runningSince).toBeNull();
    const kinds = disk.events.map((e: any) => e.kind);
    expect(kinds).toContain("dispatch");
    expect(kinds).toContain("parked");
  });

  it("a valid batch verdict routes the card forward with a routed event", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "T", project: "p1", list: "test" });
    const batchRunFn = async ({ cards }: { cards: any[] }) => ({ reply: `${cards[0].id} adversarial-test` });
    const all = await loadAllCards(root);
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: all, batchRunFn, cap: 10 });
    expect(outcomes[0].status).toBe("moved");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("adversarial-test");
    expect(disk.events.some((e: any) => e.kind === "routed")).toBe(true);
  });
});

describe("V1d withEvent / replySnippet", () => {
  it("withEvent appends and caps the timeline", () => {
    let card: any = { events: [] };
    for (let i = 0; i < 70; i++) card = { events: withEvent(card, { at: "t", kind: "x", message: String(i) }) };
    expect(card.events.length).toBeLessThanOrEqual(60);
    expect(card.events[card.events.length - 1].message).toBe("69");
  });
  it("replySnippet trims + truncates with an ellipsis", () => {
    expect(replySnippet("  hi  ")).toBe("hi");
    expect(replySnippet("x".repeat(400), 280).endsWith("…")).toBe(true);
    expect(replySnippet("")).toBe("");
  });
});

describe("V1d project inference — parse + injected runFn", () => {
  it("parseInferredProject accepts a clean slug, rejects NONE / uncertainty / junk", () => {
    expect(parseInferredProject("ekoa")).toBe("ekoa");
    expect(parseInferredProject("blah\nproject: my-repo")).toBe("my-repo");
    expect(parseInferredProject("`ekoa-web`.")).toBe("ekoa-web");
    expect(parseInferredProject("ekoa\n[route: cc-opus]")).toBe("ekoa"); // ignores a trailing badge
    expect(parseInferredProject("NONE")).toBeNull();
    expect(parseInferredProject("I'm not sure")).toBeNull();
    expect(parseInferredProject("")).toBeNull();
  });
  it("buildInferencePrompt includes the title, description and known projects", () => {
    const p = buildInferencePrompt({ title: "Title", description: "Desc" }, ["alpha", "beta"]);
    expect(p).toContain("Title");
    expect(p).toContain("Desc");
    expect(p).toContain("alpha, beta");
  });
  it("inferProject returns the slug via an injected runFn", async () => {
    const r = await inferProject({ title: "x", description: "y" }, async () => ({ reply: "ekoa" }));
    expect(r.project).toBe("ekoa");
  });
});
