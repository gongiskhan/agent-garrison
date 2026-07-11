// GARRISON-FLOW-V2 S8 — the Improver Probe's PURE logic (probe-core.mjs): the
// fail-closed gates, the "real task just completed" heuristic, decisions.jsonl
// correlation, policy target resolution (fail loud), answer matching, and the
// deterministic question / retrospective / record builders.
import { describe, it, expect } from "vitest";

// @ts-ignore - pure .mjs
import * as core from "../fittings/seed/improver/lib/probe-core.mjs";

describe("isAttended — A10 fail-closed attended gating", () => {
  const state = {
    version: 1,
    projects: {
      "/repo": {
        sessions: {
          "attended-1": { claudeSessionId: "attended-1", source: "dev-env-open", openedInDevEnv: true },
          "ambient-1": { claudeSessionId: "ambient-1", source: "hook-autocreated", openedInDevEnv: false },
        },
      },
    },
  };
  it("true only for a positively-tagged dev-env-open session", () => {
    expect(core.isAttended("attended-1", state)).toBe(true);
  });
  it("false for an ambient/hook-autocreated session (never probed)", () => {
    expect(core.isAttended("ambient-1", state)).toBe(false);
  });
  it("false for an unknown session, empty state, or no id (fail closed)", () => {
    expect(core.isAttended("nope", state)).toBe(false);
    expect(core.isAttended("attended-1", {})).toBe(false);
    expect(core.isAttended("", state)).toBe(false);
  });
});

describe("hasGoalSentinel — defer to the goal loop", () => {
  it("true when any sentinel path is present (goal loop owns the stop)", () => {
    expect(core.hasGoalSentinel("s", ["/x/.garrison/sentinels/s.json"])).toBe(true);
  });
  it("false when no sentinel exists for the session", () => {
    expect(core.hasGoalSentinel("s", [])).toBe(false);
  });
  it("true (defer) when there is no session id — cannot prove it isn't a goal session", () => {
    expect(core.hasGoalSentinel(null, [])).toBe(true);
  });
});

describe("taskLooksComplete — cheap real-task heuristic over the transcript tail", () => {
  const asst = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const toolTurn = () => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Edit" }] } });
  it("true when the last assistant turn used a tool", () => {
    expect(core.taskLooksComplete([asst("hi"), toolTurn()])).toBe(true);
  });
  it("true when the last assistant text is substantial", () => {
    expect(core.taskLooksComplete([asst("x".repeat(80))])).toBe(true);
  });
  it("false for a tiny reply or an empty tail (not a real task boundary)", () => {
    expect(core.taskLooksComplete([asst("ok")])).toBe(false);
    expect(core.taskLooksComplete([])).toBe(false);
  });
});

describe("correlateDecision — E11 digest/timestamp correlation (no sessionId on the record)", () => {
  const decisions = [
    { at: "2026-07-11T10:00:00Z", promptDigest: "aaa", taskType: "docs", tier: "T0-trivial" },
    { at: "2026-07-11T11:00:00Z", promptDigest: "bbb", taskType: "code", tier: "T1-standard" },
  ];
  it("prefers an exact digest match", () => {
    const d = core.correlateDecision(decisions, { digest: "aaa", at: "2026-07-11T12:00:00Z" });
    expect(d.taskType).toBe("docs");
  });
  it("falls back to the most recent decision at-or-before the stop time", () => {
    const d = core.correlateDecision(decisions, { digest: "no-match", at: "2026-07-11T12:00:00Z" });
    expect(d.taskType).toBe("code");
  });
  it("returns null for an empty ledger", () => {
    expect(core.correlateDecision([], {})).toBeNull();
  });
});

describe("resolveProbeTarget — reads the compiled policy cell, fails LOUD when absent", () => {
  const cell = { targetId: "agent-sdk-haiku-fast", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", effort: "low" };
  it("resolves the probe-question cell target", () => {
    const t = core.resolveProbeTarget({ matrix: { "probe-question": { "T0-trivial": cell } } });
    expect(t.targetId).toBe("agent-sdk-haiku-fast");
    expect(t.runtime).toBe("agent-sdk");
  });
  it("throws when the probe-question row is missing (never silent)", () => {
    expect(() => core.resolveProbeTarget({ matrix: {} })).toThrow(/probe-question/);
  });
  it("throws when the cell resolves to no target", () => {
    expect(() => core.resolveProbeTarget({ matrix: { "probe-question": { "T0-trivial": {} } } })).toThrow(/no target/);
  });
});

describe("matchAnswers — capture side", () => {
  const pending = (qs: any[]) => ({ questions: qs });
  it("matches answered pending questions by exact question text", () => {
    const p = pending([{ question: "Q1" }, { question: "Q2" }]);
    const { answered, unanswered } = core.matchAnswers(p, { Q1: "A" });
    expect(answered).toHaveLength(1);
    expect(answered[0].answer).toBe("A");
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0].question).toBe("Q2");
  });
  it("rephrase fallback: one pending question + one answer matches even without an exact key", () => {
    const p = pending([{ question: "the exact question" }]);
    const { answered } = core.matchAnswers(p, { "slightly rephrased?": "Yes" });
    expect(answered).toHaveLength(1);
    expect(answered[0].answer).toBe("Yes");
  });
  it("no match when none of the pending questions are answered (unrelated AskUserQuestion)", () => {
    const p = pending([{ question: "Q1" }, { question: "Q2" }]);
    const { answered } = core.matchAnswers(p, { "operative's own question": "X" });
    expect(answered).toHaveLength(0);
  });
});

describe("buildProbeQuestion — area-tagged, 2-4 options", () => {
  it("orchestrator question names the kind + tier", () => {
    const q = core.buildProbeQuestion({ area: "orchestrator", classification: { kind: "ui-change", tier: "T2-deep" } });
    expect(q.area).toBe("orchestrator");
    expect(q.question).toContain("ui-change");
    expect(q.question).toContain("T2-deep");
    expect(q.options.length).toBeGreaterThanOrEqual(2);
    expect(q.options.length).toBeLessThanOrEqual(4);
  });
  it("went-well question asks how the work went", () => {
    const q = core.buildProbeQuestion({ area: "went-well", classification: { kind: "code" } });
    expect(q.area).toBe("went-well");
    expect(q.question.toLowerCase()).toContain("go");
  });
});

describe("retrospective selection (D25)", () => {
  const now = "2026-07-11T12:00:00Z";
  it("selects up to 4 cards updated yesterday that carry a kind/plan", () => {
    const cards = [
      { id: "a", workKind: "ui-change", phasePlan: "ui-change", updatedAt: "2026-07-10T09:00:00Z" },
      { id: "b", workKind: "docs-change", phasePlan: "implement-only-text", updatedAt: "2026-07-10T22:00:00Z" },
      { id: "old", workKind: "code", updatedAt: "2026-07-01T00:00:00Z" }, // not yesterday
      { id: "today", workKind: "code", updatedAt: "2026-07-11T08:00:00Z" }, // today, not yesterday
    ];
    const picked = core.selectRetrospectiveCards(cards, { now });
    expect(picked.map((c: any) => c.id).sort()).toEqual(["a", "b"]);
  });
  it("builds one question per selected card, tagged with card_id and plan", () => {
    const qs = core.buildRetrospectiveQuestions(
      [{ id: "a", workKind: "ui-change", phasePlan: "ui-change", updatedAt: "2026-07-10T09:00:00Z" }],
      { now }
    );
    expect(qs).toHaveLength(1);
    expect(qs[0].card_id).toBe("a");
    expect(qs[0].question).toContain("full pipeline");
    expect(qs[0].classification.plan).toBe("ui-change");
  });
});

describe("buildFeedbackRecord — the D26 schema shared with the override writer", () => {
  it("carries session_id/area/question/options/answer/timestamp/provenance/classification", () => {
    const rec = core.buildFeedbackRecord({
      session_id: "s1",
      area: "orchestrator",
      question: "Q?",
      options: ["a", "b"],
      answer: "a",
      classification: { kind: "code", tier: "T1-standard", plan: null },
      card_id: "c1",
      provenance: "probe",
      at: "2026-07-11T00:00:00Z",
    });
    expect(rec).toEqual({
      session_id: "s1",
      area: "orchestrator",
      question: "Q?",
      options: ["a", "b"],
      answer: "a",
      timestamp: "2026-07-11T00:00:00Z",
      provenance: "probe",
      classification: { kind: "code", tier: "T1-standard", plan: null },
      card_id: "c1",
    });
  });
  it("omits session_id and card_id when absent", () => {
    const rec = core.buildFeedbackRecord({ area: "went-well", question: "Q", answer: "x", at: "t" });
    expect(rec).not.toHaveProperty("session_id");
    expect(rec).not.toHaveProperty("card_id");
  });
});

describe("relayReason — the verbatim D24 relay instruction", () => {
  it("instructs a verbatim AskUserQuestion relay and embeds the exact question + options", () => {
    const reason = core.relayReason({ questions: [{ question: "Was that right?", options: ["Yes", "No"] }] });
    expect(reason).toContain("AskUserQuestion");
    expect(reason).toContain("verbatim");
    expect(reason).toContain("Was that right?");
    expect(reason).toContain('["Yes","No"]');
  });
});
