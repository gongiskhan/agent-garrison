import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { writeDutySummary, readGateSummary, appendSessionId, buildContinuationContext, buildCardPrompt } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { composeHandoff, doneTransition } from "../fittings/seed/kanban-loop/lib/handoff.mjs";
// @ts-ignore — pure .mjs
import { enumerateArtifactRefs, resolveArtifactRef } from "../fittings/seed/kanban-loop/lib/links.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ULID_A = "01JH000000000000000000000A";
const ULID_B = "01JH000000000000000000000B";

describe("WS2 — duty summary + gate summary + sessionIds (engine)", () => {
  it("writeDutySummary writes <runDir>/duty-summary.<phase>.json with the capped fields", () => {
    const runDir = tmp("ws2-run-");
    const rec = writeDutySummary("/proj", {
      card: { id: ULID_A, runDir, level: 2 },
      phase: "implement",
      listFrom: "implement",
      listTo: "review",
      summary: "x".repeat(2000),
      logRef: "log:3",
      gateSummary: "gate said done",
      context: { contextPct: 41, peakContextPct: 63 },
      now: () => "2026-07-14T00:00:00Z"
    });
    expect(rec).toBeTruthy();
    const file = join(runDir, "duty-summary.implement.json");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written).toMatchObject({
      cardId: ULID_A,
      phase: "implement",
      level: 2,
      listFrom: "implement",
      listTo: "review",
      logRef: "log:3",
      gateSummary: "gate said done",
      context: { contextPct: 41, peakContextPct: 63 }
    });
    expect(written.summary.length).toBe(1200); // capped at ~1200
  });

  it("writeDutySummary is a silent no-op when runDir is null", () => {
    expect(writeDutySummary("/proj", { card: { id: ULID_A, runDir: null }, phase: "plan" })).toBeNull();
  });

  it("readGateSummary reads summary|notes from the accepted gate shapes", () => {
    const runDir = tmp("ws2-gate-");
    writeFileSync(join(runDir, "gate-status.plan.json"), JSON.stringify({ status: "passed", summary: "planned it" }));
    expect(readGateSummary("/proj", runDir, "plan")).toBe("planned it");

    const runDir2 = tmp("ws2-gate2-");
    writeFileSync(join(runDir2, "gate-status.json"), JSON.stringify({ gates: { review: { status: "passed", notes: "looks good" } } }));
    expect(readGateSummary("/proj", runDir2, "review")).toBe("looks good");

    expect(readGateSummary("/proj", runDir, "nonexistent")).toBeNull();
  });

  it("appendSessionId appends uniquely and ignores empty", () => {
    expect(appendSessionId([], "s1")).toEqual(["s1"]);
    expect(appendSessionId(["s1"], "s1")).toEqual(["s1"]);
    expect(appendSessionId(["s1"], "s2")).toEqual(["s1", "s2"]);
    expect(appendSessionId(["s1"], null)).toEqual(["s1"]);
    expect(appendSessionId(undefined, "s1")).toEqual(["s1"]);
  });
});

describe("WS2 — links.mjs artifact-ref enumeration", () => {
  it("enumerates the ref vocabulary with one-liners", () => {
    const runDir = tmp("ws2-links-");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "after.png"), "img");
    writeFileSync(join(runDir, "FLOW_PLAN.md"), "# plan");
    const card = { id: ULID_A, runDir, sliceId: "slice-1", sessionIds: ["sess-x"], iterations: 2 };
    const refs = enumerateArtifactRefs(card, { root: "/board", cwd: "/proj" });
    const tokens = refs.map((r: any) => r.ref);
    expect(tokens).toContain("plan");
    expect(tokens).toContain("evidenceIndex");
    expect(tokens).toContain("gateMarkers");
    expect(tokens).toContain("evidence:after.png");
    expect(tokens).toContain("session:0");
    expect(tokens).toContain("log:1");
    expect(tokens).toContain("log:2");
    const planRef = refs.find((r: any) => r.ref === "plan");
    expect(planRef.oneLiner).toContain("FLOW_PLAN.md");
    // still resolves to the right path via resolveArtifactRef (the shared core); runDir
    // is absolute so path.resolve(cwd, runDir, ...) == join(runDir, ...).
    expect(resolveArtifactRef(card, "plan", { root: "/board", cwd: "/proj" })).toBe(join(runDir, "FLOW_PLAN.md"));
  });
});

describe("WS2 — handoff packet composition", () => {
  function fakeRun() {
    const runDir = tmp("ws2-handoff-run-");
    // Two engine-written duty summaries (plan then implement).
    writeFileSync(join(runDir, "duty-summary.plan.json"), JSON.stringify({ cardId: ULID_A, phase: "plan", at: "2026-07-14T00:00:01Z", summary: "planned the change", gateSummary: "plan gate: approach agreed" }));
    writeFileSync(join(runDir, "duty-summary.implement.json"), JSON.stringify({ cardId: ULID_A, phase: "implement", at: "2026-07-14T00:00:02Z", summary: "implemented the change end to end", gateSummary: "implement gate: tests pass" }));
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({ version: 1, files: ["src/a.ts", "src/b.ts"] }));
    return runDir;
  }

  it("composes completionSummary, keyDecisions, filesTouched, and the evidence manifest", () => {
    const root = tmp("ws2-handoff-board-");
    const runDir = fakeRun();
    // A card-owned brief with decision bullets.
    mkdirSync(join(root, "cards", ULID_A), { recursive: true });
    writeFileSync(join(root, "cards", ULID_A, "brief.md"), "# Brief\n\n## Decisions\n- use JWT\n- keep it small\n");
    const card = { id: ULID_A, title: "Add login", runDir, sliceId: "s1", iterations: 1, lastReply: "fallback reply" };
    const packet = composeHandoff(card, { root, cwd: "/proj", at: "2026-07-14T00:00:03Z" });
    expect(packet.cardId).toBe(ULID_A);
    expect(packet.completionSummary).toBe("implemented the change end to end"); // last duty summary
    expect(packet.keyDecisions).toContain("plan: plan gate: approach agreed");
    expect(packet.keyDecisions).toContain("implement: implement gate: tests pass");
    expect(packet.keyDecisions).toContain("use JWT"); // brief bullet
    expect(packet.filesTouched).toEqual(["src/a.ts", "src/b.ts"]);
    expect(packet.evidenceManifest.map((e: any) => e.ref)).toContain("plan");
    expect(packet.chainIndex).toEqual([]);
  });

  it("falls back to lastReply when there are no duty summaries", () => {
    const root = tmp("ws2-handoff-board2-");
    const card = { id: ULID_B, title: "quick", runDir: null, lastReply: "did the quick thing", fences: [{ phase: "implement", sha: "abcdef1234567" }] };
    const packet = composeHandoff(card, { root, cwd: "/proj" });
    expect(packet.completionSummary).toBe("did the quick thing");
    expect(packet.filesTouched).toEqual(["commit abcdef1234 (implement)"]); // from fences
  });

  it("resolves a chain of 3 transitively via predecessor handoff.json", () => {
    const root = tmp("ws2-chain-");
    const c1 = "01JH00000000000000000000C1";
    const c2 = "01JH00000000000000000000C2";
    const c3 = "01JH00000000000000000000C3";
    // c1: root of the chain (no predecessor).
    mkdirSync(join(root, "cards", c1), { recursive: true });
    writeFileSync(join(root, "cards", c1, "handoff.json"), JSON.stringify({ cardId: c1, title: "first", completionSummary: "did first", chainIndex: [] }));
    // c2: continues c1 — its stored chainIndex is [c1].
    mkdirSync(join(root, "cards", c2), { recursive: true });
    writeFileSync(join(root, "cards", c2, "handoff.json"), JSON.stringify({ cardId: c2, title: "second", completionSummary: "did second", chainIndex: [{ cardId: c1, title: "first", oneLiner: "did first" }] }));
    // c3 continues c2 -> composeHandoff walks c2's chain + c2 itself.
    const packet = composeHandoff({ id: c3, title: "third", continues: c2, runDir: null }, { root, cwd: "/proj" });
    expect(packet.chainIndex.map((x: any) => x.cardId)).toEqual([c1, c2]); // oldest first
    expect(packet.chainIndex[1]).toMatchObject({ cardId: c2, title: "second" });
  });

  it("doneTransition fires only on the edge INTO done", () => {
    expect(doneTransition({ list: "review" }, { list: "done" })).toBe(true);
    expect(doneTransition(null, { list: "done" })).toBe(true);
    expect(doneTransition({ list: "done" }, { list: "done" })).toBe(false);
    expect(doneTransition({ list: "review" }, { list: "needs-attention" })).toBe(false);
    expect(doneTransition({ list: "todo" }, { list: "todo" })).toBe(false);
  });
});

describe("WS2 — continues field + continuation prompt injection", () => {
  it("createCard shape-validates continues and stamps origin 'continuation'", async () => {
    const root = tmp("ws2-cards-");
    const cont = await createCard(root, { list: "backlog", title: "cont", continues: ULID_A });
    expect(cont.continues).toBe(ULID_A);
    expect(cont.origin).toBe("continuation");
    // Invalid continues -> null, no origin stamp.
    const bad = await createCard(root, { list: "backlog", title: "bad", continues: "not-a-ulid" });
    expect(bad.continues).toBeNull();
    expect(bad.origin).toBeNull();
    // Explicit origin wins over the continuation default.
    const keep = await createCard(root, { list: "backlog", title: "keep", continues: ULID_A, origin: "board" });
    expect(keep.origin).toBe("board");
  });

  it("buildContinuationContext reads the predecessor handoff, and buildCardPrompt injects it", () => {
    const root = tmp("ws2-cont-");
    mkdirSync(join(root, "cards", ULID_A), { recursive: true });
    writeFileSync(
      join(root, "cards", ULID_A, "handoff.json"),
      JSON.stringify({
        cardId: ULID_A,
        title: "Add login",
        completionSummary: "shipped JWT login",
        keyDecisions: ["use JWT", "keep it small"],
        filesTouched: ["src/auth.ts"],
        evidenceManifest: [{ ref: "plan", oneLiner: "FLOW_PLAN.md - the plan duty output" }],
        chainIndex: [{ cardId: "01JH00000000000000000000C0", title: "root", oneLiner: "started it" }]
      })
    );
    const card = { id: ULID_B, continues: ULID_A };
    const block = buildContinuationContext(root, card);
    expect(block).toContain("Continuing from 01JH000000000000000000000A - Add login");
    expect(block).toContain("shipped JWT login");
    expect(block).toContain("- use JWT");
    expect(block).toContain("src/auth.ts");
    expect(block).toContain("plan: FLOW_PLAN.md - the plan duty output");
    expect(block).toContain(`fetch_evidence("${ULID_A}"`);

    const prompt = buildCardPrompt({
      list: { kind: "agent", title: "Plan", executePrompt: "Plan it." },
      card: { id: ULID_B, title: "cont", continues: ULID_A },
      validNext: ["implement"],
      continuationContext: block,
      phase: "plan"
    });
    expect(prompt).toContain("Continuing from 01JH000000000000000000000A");
    expect(prompt).toContain("shipped JWT login");

    // No handoff yet -> null, and the prompt omits the block.
    expect(buildContinuationContext(root, { id: ULID_B, continues: "01JH00000000000000000000ZZ" })).toBeNull();
    expect(buildContinuationContext(root, { id: ULID_B, continues: null })).toBeNull();
  });
});
