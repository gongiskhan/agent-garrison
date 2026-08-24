// GARRISON-FLOW-V2 S8 (D27) — the Improver's nightly consumer of the feedback
// queue. Probe / retrospective / override records become reviewable policy
// proposals (phase-plan / matrix / kind-matcher); dismissed answers carry no
// signal; nothing is auto-applied. Acceptance #20.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { startStateService } from "./state-service-harness";

// @ts-ignore - pure .mjs
import * as rule from "../fittings/seed/improver/lib/feedback-rule.mjs";
// @ts-ignore - pure .mjs
import * as signals from "../fittings/seed/improver/lib/feedback-signals.mjs";

const AT = "2026-07-11T00:00:00Z";

describe("analyzeFeedbackProposals — high-weight, never auto-applied", () => {
  it("repeated overrides to 'full' for a kind → a fuller-phase-plan proposal", () => {
    const records = [
      { provenance: "override", applied: { plan: "full", flow: "docs-change" }, answer: "full pipeline" },
      { provenance: "override", applied: { plan: "full", flow: "docs-change" }, answer: "run in the background" },
    ];
    const props = rule.analyzeFeedbackProposals({ records, at: AT });
    const p = props.find((x: any) => x.id === "feedback-deeper-" + short("docs-change"));
    expect(p).toBeTruthy();
    expect(p.rule).toBe("feedback");
    expect(p.targetClass).toBe("orchestrator/policy");
    expect(p.applyVia).toContain("PUT /routing");
    expect(p.evidence.count).toBe(2);
    expect(p.evidence.provenances).toContain("override");
  });

  it("repeated retrospective 'run less' for a kind → a lighter-plan proposal", () => {
    const records = [
      { provenance: "retrospective", classification: { kind: "ui-change" }, answer: "Should have run less" },
      { provenance: "retrospective", classification: { kind: "ui-change" }, answer: "Should have run less" },
    ];
    const props = rule.analyzeFeedbackProposals({ records, at: AT });
    expect(props.some((p: any) => p.id === "feedback-lighter-" + short("ui-change"))).toBe(true);
  });

  it("repeated probe 'Wrong task type' → a kind-matcher review proposal", () => {
    const records = [
      { provenance: "probe", classification: { kind: "api-change" }, answer: "Wrong task type" },
      { provenance: "probe", classification: { kind: "api-change" }, answer: "Wrong task type" },
    ];
    const props = rule.analyzeFeedbackProposals({ records, at: AT });
    expect(props.some((p: any) => p.id === "feedback-kindmatch-" + short("api-change"))).toBe(true);
  });

  it("repeated went-well 'Needed rework' → a plan/binding review proposal", () => {
    const records = [
      { provenance: "probe", area: "went-well", classification: { kind: "full-feature" }, answer: "Needed rework" },
      { provenance: "probe", area: "went-well", classification: { kind: "full-feature" }, answer: "Wrong approach" },
    ];
    const props = rule.analyzeFeedbackProposals({ records, at: AT });
    expect(props.some((p: any) => p.id === "feedback-wentpoorly-" + short("full-feature"))).toBe(true);
  });

  it("dismissed answers and positive answers carry NO signal", () => {
    const records = [
      { provenance: "probe", classification: { kind: "code" }, answer: "dismissed" },
      { provenance: "probe", classification: { kind: "code" }, answer: "Right call" },
      { provenance: "probe", classification: { kind: "code" }, answer: "Went well" },
      { provenance: "retrospective", classification: { kind: "code" }, answer: "That was right" },
    ];
    expect(rule.analyzeFeedbackProposals({ records, at: AT })).toHaveLength(0);
  });

  it("a single occurrence is below the min-signal bar (default 2)", () => {
    const records = [{ provenance: "override", applied: { plan: "full", flow: "docs-change" }, answer: "full pipeline" }];
    expect(rule.analyzeFeedbackProposals({ records, at: AT })).toHaveLength(0);
  });

  it("proposals are emitted in a stable (sorted) order", () => {
    const records = [
      { provenance: "probe", classification: { kind: "zeta" }, answer: "Wrong task type" },
      { provenance: "probe", classification: { kind: "zeta" }, answer: "Wrong task type" },
      { provenance: "override", applied: { plan: "full", flow: "alpha" }, answer: "full pipeline" },
      { provenance: "override", applied: { plan: "full", flow: "alpha" }, answer: "full pipeline" },
    ];
    const ids = rule.analyzeFeedbackProposals({ records, at: AT }).map((p: any) => p.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("collectFeedback + runFeedbackRule — reads the state service's queue", () => {
  // The collector used to parse ~/.garrison/improver/feedback-queue.jsonl. Since
  // mesh phase 2 (§4.5) it reads GET /v1/feedback, and the tombstone join that
  // decides which records survive happens in the service rather than in three
  // matching client implementations. The "malformed line" case has no successor:
  // there are no lines to malform, and a row that fails to insert is a 4xx at
  // write time rather than a silently skipped line at read time.
  let h: Awaited<ReturnType<typeof startStateService>>;
  const saved = { url: process.env.GARRISON_STATE_URL, token: process.env.GARRISON_STATE_TOKEN };

  beforeEach(async () => {
    h = await startStateService();
    process.env.GARRISON_STATE_URL = h.url;
    process.env.GARRISON_STATE_TOKEN = h.token;
    signals.resetFeedbackClient();
  });

  afterEach(async () => {
    await h?.stop();
    if (saved.url === undefined) delete process.env.GARRISON_STATE_URL;
    else process.env.GARRISON_STATE_URL = saved.url;
    if (saved.token === undefined) delete process.env.GARRISON_STATE_TOKEN;
    else process.env.GARRISON_STATE_TOKEN = saved.token;
    signals.resetFeedbackClient();
  });

  it("reads records from the queue and returns proposals (empty queue → none)", async () => {
    expect((await rule.runFeedbackRule({ now: AT })).proposals).toHaveLength(0);
    for (const answer of ["full pipeline", "kick off a build"]) {
      await signals.appendFeedbackRecord({
        id: signals.mintFeedbackId(AT),
        provenance: "override",
        applied: { plan: "full", flow: "docs-change" },
        answer
      });
    }
    const res = await rule.runFeedbackRule({ now: AT });
    expect(res.inputs.records).toBe(2);
    expect(res.proposals.length).toBeGreaterThanOrEqual(1);
  });
});

// same 8-hex sha256 slice the rule uses for proposal ids
function short(s: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:crypto").createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}
