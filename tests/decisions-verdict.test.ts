import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildVerdictRecord,
  sanitizeCorrection,
  CORRECTION_FIELDS
} from "../src/lib/decision-verdicts";
import { recordDecisionVerdict } from "../src/lib/decision-verdicts-store";
import { normalizeDecision } from "../src/lib/decisions-feed";

// RUN-SPEC-V1 verdicts: the correction channel for an orchestrator that now decides
// almost everything by default.
//
// Two properties matter and are easy to lose:
//   1. a verdict must NAME a decision, and name the same one on a re-read;
//   2. it must land in the queue the Improver already reads, in the shape that
//      rule already parses — a record nothing consumes is worse than no record,
//      because it looks like the loop is closed.

let decisionId: (input: Record<string, unknown>) => string;
let analyzeFeedbackProposals: (opts: { records: unknown[]; at?: string; minSignal?: number }) => {
  id: string;
  rule: string;
  claim: string;
  decision: string;
}[];

beforeAll(async () => {
  const repo = path.resolve(__dirname, "..");
  const telemetry = await import(
    pathToFileURL(path.join(repo, "fittings/seed/orchestrator/lib/routing-telemetry.mjs")).href
  );
  const feedback = await import(
    pathToFileURL(path.join(repo, "fittings/seed/improver/lib/feedback-rule.mjs")).href
  );
  decisionId = telemetry.decisionId;
  analyzeFeedbackProposals = feedback.analyzeFeedbackProposals;
});

describe("decision identity", () => {
  it("the reader derives the SAME id the gateway writes", () => {
    // The two live in different processes (the app cannot import a fitting), so the
    // derivation is duplicated. If they ever disagree, a verdict recorded against a
    // freshly-written record would silently name a different decision than the one
    // the user clicked. This is that alarm.
    const at = "2026-07-29T12:00:00.000Z";
    const promptDigest = "0123456789abcdef";
    const targetId = "cc-opus-high";
    const written = decisionId({ at, promptDigest, targetId });
    const derived = normalizeDecision({ at, promptDigest, targetId })!.id;
    expect(derived).toBe(written);
  });

  it("changes when the target changes, so two routes are never one decision", () => {
    const base = { at: "2026-07-29T12:00:00.000Z", promptDigest: "abc" };
    expect(normalizeDecision({ ...base, targetId: "cc-haiku-low" })!.id).not.toBe(
      normalizeDecision({ ...base, targetId: "cc-opus-high" })!.id
    );
  });
});

describe("buildVerdictRecord", () => {
  it("mirrors the queue shape the Improver already parses", () => {
    const rec = buildVerdictRecord({
      decisionId: "abc123",
      verdict: "wrong",
      resolved: { target: "cc-haiku-low", effort: "low" },
      correction: { target: "cc-opus-high" },
      sessionId: "thread-1",
      at: "2026-07-29T12:00:00.000Z"
    })!;
    expect(rec).toEqual({
      session_id: "thread-1",
      area: "orchestrator",
      question: "decision-verdict",
      answer: "wrong",
      decision_id: "abc123",
      original: { target: "cc-haiku-low", effort: "low" },
      applied: { target: "cc-opus-high" },
      timestamp: "2026-07-29T12:00:00.000Z",
      provenance: "decision-verdict"
    });
  });

  it("refuses a verdict with no decision to attach to, or an unknown verdict", () => {
    expect(buildVerdictRecord({ decisionId: "", verdict: "wrong" })).toBe(null);
    expect(buildVerdictRecord({ decisionId: "abc", verdict: "maybe" as never })).toBe(null);
    // Path- and control-character-shaped ids are refused: the id is a lookup key,
    // never a filename.
    expect(buildVerdictRecord({ decisionId: "../../etc/passwd", verdict: "right" })).toBe(null);
    expect(buildVerdictRecord({ decisionId: "abc\ndef", verdict: "right" })).toBe(null);
  });

  it("records a bare 'wrong' with no counterfactual rather than losing it", () => {
    const rec = buildVerdictRecord({ decisionId: "abc123", verdict: "wrong" })!;
    expect(rec.applied).toBeUndefined();
    expect(rec.answer).toBe("wrong");
  });

  it("keeps only run-spec dimensions in a correction", () => {
    expect(sanitizeCorrection({ target: "cc-opus", runtime: "gemini", cwd: "/etc", effort: "  " })).toEqual({
      target: "cc-opus"
    });
    expect(sanitizeCorrection({})).toBeUndefined();
    expect(sanitizeCorrection("target=opus")).toBeUndefined();
    // Every dimension the run spec has is correctable - a control you can set but
    // not correct teaches nothing.
    for (const field of CORRECTION_FIELDS) {
      expect(sanitizeCorrection({ [field]: "x" }), field).toEqual({ [field]: "x" });
    }
  });
});

describe("recordDecisionVerdict", () => {
  it("appends one line per verdict, creating the queue on first write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-"));
    const file = path.join(dir, "improver", "feedback-queue.jsonl");
    expect(await recordDecisionVerdict({ decisionId: "a1", verdict: "right" }, file)).toBe(true);
    expect(await recordDecisionVerdict({ decisionId: "a2", verdict: "wrong" }, file)).toBe(true);
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).decision_id).toBe("a2");
  });

  it("reports a refusal instead of silently writing nothing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-"));
    const file = path.join(dir, "q.jsonl");
    expect(await recordDecisionVerdict({ decisionId: "", verdict: "right" }, file)).toBe(false);
    await expect(fs.readFile(file, "utf8")).rejects.toThrow();
  });
});

describe("the Improver consumes a verdict", () => {
  const verdict = (applied?: Record<string, string>) => ({
    area: "orchestrator",
    question: "decision-verdict",
    answer: "wrong",
    decision_id: "d1",
    ...(applied ? { applied } : {}),
    provenance: "decision-verdict"
  });

  it("turns repeated compute corrections into a retarget proposal quoting the value", () => {
    const proposals = analyzeFeedbackProposals({
      records: [verdict({ target: "cc-opus-high" }), verdict({ target: "cc-opus-high" })],
      at: "2026-07-29T12:00:00.000Z"
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].rule).toBe("feedback");
    expect(proposals[0].claim).toContain("cc-opus-high");
    expect(proposals[0].claim).toContain("wrong target");
  });

  it("separates a plan correction from a compute one", () => {
    const proposals = analyzeFeedbackProposals({
      records: [verdict({ flow: "ui-change" }), verdict({ flow: "ui-change" })],
      at: "2026-07-29T12:00:00.000Z"
    });
    expect(proposals[0].id).toContain("replan");
    expect(proposals[0].decision).toContain("flow");
  });

  it("never proposes from agreement, and never from a single correction", () => {
    // Approval must not drift the policy: if "right" counted, ordinary use would
    // steadily harden whatever the orchestrator already does.
    expect(
      analyzeFeedbackProposals({
        records: [
          { ...verdict({ target: "cc-opus-high" }), answer: "right" },
          { ...verdict({ target: "cc-opus-high" }), answer: "right" },
          { ...verdict({ target: "cc-opus-high" }), answer: "unsure" },
          { ...verdict({ target: "cc-opus-high" }), answer: "unsure" }
        ],
        at: "x"
      })
    ).toEqual([]);
    // One correction is an anecdote (minSignal = 2).
    expect(analyzeFeedbackProposals({ records: [verdict({ target: "cc-opus-high" })], at: "x" })).toEqual([]);
  });

  it("does not let two DIFFERENT corrections add up to one proposal", () => {
    // Grouping by the corrected value is what makes the count mean something: two
    // people disagreeing about two dimensions is not two votes for either.
    expect(
      analyzeFeedbackProposals({
        records: [verdict({ target: "cc-opus-high" }), verdict({ target: "cc-sonnet-med" })],
        at: "x"
      })
    ).toEqual([]);
  });
});
