import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startStateService } from "./state-service-harness";
import { resetStateClient } from "../src/lib/state-client";
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
      // Minted per record, so it is matched by shape rather than by value. It is
      // the handle a tombstone names when this verdict is deleted from the
      // Signals view — without it the record can only be addressed by hashing
      // its own line.
      id: expect.stringMatching(/^fq-[0-9a-z]{9}-[0-9a-f]{8}$/),
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
    // The id's timestamp half is derived from the record's own `at`, so ids
    // sort in the order the verdicts were actually given.
    expect(String(rec.id)).toContain(Date.parse("2026-07-29T12:00:00.000Z").toString(36));
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
  // The verdict queue is the state service's `feedback_queue` since mesh phase 2
  // (§4.5) — one shared queue for all three producers on every node, instead of
  // one JSONL file per machine. The writer takes no file argument any more:
  // there is no file, and no local fallback if the service is unreachable.
  let h: Awaited<ReturnType<typeof startStateService>>;
  const saved = { url: process.env.GARRISON_STATE_URL, token: process.env.GARRISON_STATE_TOKEN };

  beforeEach(async () => {
    h = await startStateService();
    process.env.GARRISON_STATE_URL = h.url;
    process.env.GARRISON_STATE_TOKEN = h.token;
    resetStateClient();
  });

  afterEach(async () => {
    await h?.stop();
    if (saved.url === undefined) delete process.env.GARRISON_STATE_URL;
    else process.env.GARRISON_STATE_URL = saved.url;
    if (saved.token === undefined) delete process.env.GARRISON_STATE_TOKEN;
    else process.env.GARRISON_STATE_TOKEN = saved.token;
    resetStateClient();
  });

  it("appends one row per verdict, in order, carrying the record verbatim", async () => {
    expect(await recordDecisionVerdict({ decisionId: "a1", verdict: "right" })).toBe(true);
    expect(await recordDecisionVerdict({ decisionId: "a2", verdict: "wrong" })).toBe(true);
    const rows = await h.client.listFeedback({ limit: 100 });
    expect(rows).toHaveLength(2);
    expect((rows[1].payload as { decision_id: string }).decision_id).toBe("a2");
    // The minted id is the row id, which is the handle a tombstone names.
    expect(rows[1].id).toBe((rows[1].payload as { id: string }).id);
    expect(rows[1].kind).toBe("decision-verdict");
  });

  it("reports a refusal instead of silently writing nothing", async () => {
    expect(await recordDecisionVerdict({ decisionId: "", verdict: "right" })).toBe(false);
    expect(await h.client.listFeedback({ limit: 100 })).toHaveLength(0);
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
