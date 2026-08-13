// The feedback queue's IDENTITY and DELETE contract.
//
// Three producers append to one shared JSONL, and until now a record on it could
// not be named, so it could not be deleted, so a wrong inference could only be
// corrected by hand-editing the file. These tests pin the two things that make
// deletion work:
//
//   1. every producer stamps an id, and
//   2. every READER — the improver's feedback rule, the Signals view, and the
//      shell's autonomy bands — resolves tombstones the same way.
//
// (2) is the one worth being strict about. The key derivation for id-less
// historical records is duplicated across a language boundary (.mjs in the
// fitting, .ts in the shell) because a fitting cannot import the shell. If those
// two derivations drift, a record deleted in the Signals view keeps feeding the
// bands on the home page and nothing tells you — the exact class of silent
// disagreement this whole area exists to end. So the parity is asserted here
// rather than assumed.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildVerdictRecord } from "@/lib/decision-verdicts";
import { readEvidence, evidenceFromVerdict } from "@/lib/routing-tracks";

// @ts-ignore - pure .mjs
import * as signals from "../fittings/seed/improver/lib/feedback-signals.mjs";
// @ts-ignore - pure .mjs
import * as feedbackRule from "../fittings/seed/improver/lib/feedback-rule.mjs";
// @ts-ignore - pure .mjs
import * as view from "../fittings/seed/improver/lib/signals-view.mjs";
// @ts-ignore - pure .mjs
import * as probeCore from "../fittings/seed/improver/lib/probe-core.mjs";
// @ts-ignore - pure .mjs
import * as gatewayQueue from "../fittings/seed/http-gateway/scripts/lib/feedback-queue.mjs";

const AT = "2026-08-13T09:00:00.000Z";
const ID_SHAPE = /^fq-[0-9a-z]{9}-[0-9a-f]{8}$/;

let home: string;
let queueFile: string;
let compositionDir: string;
const savedHome = process.env.GARRISON_HOME;
const savedData = process.env.IMPROVER_DATA;

function queueLine(record: unknown) {
  appendFileSync(queueFile, JSON.stringify(record) + "\n", "utf8");
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "gar-signals-"));
  mkdirSync(path.join(home, "improver"), { recursive: true });
  queueFile = path.join(home, "improver", "feedback-queue.jsonl");
  compositionDir = path.join(home, "composition");
  mkdirSync(path.join(compositionDir, ".garrison"), { recursive: true });
  process.env.GARRISON_HOME = home;
  process.env.IMPROVER_DATA = path.join(home, "improver");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = savedHome;
  if (savedData === undefined) delete process.env.IMPROVER_DATA;
  else process.env.IMPROVER_DATA = savedData;
  rmSync(home, { recursive: true, force: true });
});

describe("id stamping — all three producers", () => {
  it("the Decisions panel's verdict writer stamps one", () => {
    const rec = buildVerdictRecord({ decisionId: "dec-1", verdict: "wrong", at: AT })!;
    expect(String(rec.id)).toMatch(ID_SHAPE);
  });

  it("the gateway's override writer stamps one", () => {
    const rec = gatewayQueue.buildOverrideRecord({ answer: "full pipeline", applied: { plan: "full" }, at: AT });
    expect(String(rec.id)).toMatch(ID_SHAPE);
  });

  it("the Probe's record builder stamps one", () => {
    const rec = probeCore.buildFeedbackRecord({ area: "orchestrator", question: "q", answer: "Right call", at: AT });
    expect(String(rec.id)).toMatch(ID_SHAPE);
  });

  it("all three agree on the format, and ids sort by mint time", () => {
    const early = probeCore.buildFeedbackRecord({ question: "q", answer: "a", at: "2026-08-13T09:00:00.000Z" }).id;
    const late = gatewayQueue.buildOverrideRecord({ answer: "x", at: "2026-08-13T10:00:00.000Z" }).id;
    expect(early < late).toBe(true);
  });

  it("two records minted in the same millisecond do not collide", () => {
    const ids = new Set(Array.from({ length: 200 }, () => signals.mintFeedbackId(AT)));
    expect(ids.size).toBe(200);
  });
});

describe("tombstone round-trip", () => {
  it("a deleted verdict stops feeding collectFeedback AND the shell's readEvidence", async () => {
    // Two "wrong" verdicts correcting the same dimension: enough for the feedback
    // rule's min-signal bar, and real evidence for the level track.
    const a = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: AT })!;
    const b = buildVerdictRecord({ decisionId: "d2", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: "2026-08-13T11:00:00.000Z" })!;
    queueLine(a);
    queueLine(b);

    expect(feedbackRule.collectFeedback(queueFile)).toHaveLength(2);
    expect(feedbackRule.runFeedbackRule({ now: AT, queueFile }).proposals.length).toBeGreaterThanOrEqual(1);
    const before = await readEvidence(compositionDir);
    expect(before.length).toBeGreaterThan(0);

    const res = view.tombstoneSignal(String(a.id), { reason: "misclicked", queueFile });
    expect(res.ok).toBe(true);
    view.tombstoneSignal(String(b.id), { reason: "misclicked", queueFile });

    // The improver's consumer no longer sees them …
    expect(feedbackRule.collectFeedback(queueFile)).toHaveLength(0);
    expect(feedbackRule.runFeedbackRule({ now: AT, queueFile }).proposals).toHaveLength(0);
    // … and neither do the autonomy bands, which is the half that used to be
    // impossible: deleting the record is what deletes the inference.
    expect(await readEvidence(compositionDir)).toHaveLength(0);
  });

  it("deletes by APPENDING — the original line is still on disk", () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", at: AT })!;
    queueLine(rec);
    view.tombstoneSignal(String(rec.id), { queueFile });
    const text = readFileSync(queueFile, "utf8");
    expect(text).toContain(String(rec.id));
    expect(text.split("\n").filter(Boolean)).toHaveLength(2); // record + tombstone
    expect(JSON.parse(text.split("\n")[1]).kind).toBe("tombstone");
  });

  it("a record with NO id is deletable by its derived line key", async () => {
    // Every record already on disk predates ids. They must still be deletable, or
    // the historical queue is permanently uncorrectable.
    const legacy = { area: "orchestrator", question: "decision-verdict", answer: "wrong", original: { duty: "fix" }, timestamp: AT, provenance: "decision-verdict" };
    queueLine(legacy);
    expect((await readEvidence(compositionDir)).length).toBeGreaterThan(0);

    const collected = view.collectSignals({ queueFile, dir: path.join(home, "improver") });
    const row = collected.signals[0];
    expect(row.id).toBeNull();
    expect(row.key).toMatch(/^raw:[0-9a-f]{32}$/);

    expect(view.tombstoneSignal(row.key, { queueFile }).ok).toBe(true);
    expect(await readEvidence(compositionDir)).toHaveLength(0);
    expect(feedbackRule.collectFeedback(queueFile)).toHaveLength(0);
  });

  it("deleting one record leaves its neighbours alone", async () => {
    const keep = buildVerdictRecord({ decisionId: "keep", verdict: "wrong", resolved: { duty: "fix" }, at: AT })!;
    const drop = buildVerdictRecord({ decisionId: "drop", verdict: "wrong", resolved: { duty: "review" }, at: AT })!;
    queueLine(keep);
    queueLine(drop);
    view.tombstoneSignal(String(drop.id), { queueFile });
    const shapes = (await readEvidence(compositionDir)).map((e) => e.shape);
    expect(shapes).toContain("fix");
    expect(shapes).not.toContain("review");
  });

  it("a tombstone naming nothing is refused rather than silently recorded", () => {
    queueLine(buildVerdictRecord({ decisionId: "d1", verdict: "right", at: AT })!);
    expect(view.tombstoneSignal("fq-000000000-deadbeef", { queueFile })).toMatchObject({ ok: false, code: "not-found" });
    expect(readFileSync(queueFile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("re-deleting is a no-op success, not a second tombstone", () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", at: AT })!;
    queueLine(rec);
    view.tombstoneSignal(String(rec.id), { queueFile });
    expect(view.tombstoneSignal(String(rec.id), { queueFile })).toMatchObject({ ok: true, alreadyDeleted: true });
    expect(readFileSync(queueFile, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("reader parity across the language boundary", () => {
  it("the .mjs and .ts derived keys agree, so a tombstone written by one is honoured by the other", async () => {
    // The .ts derivation is private to routing-tracks; it is exercised through
    // its OBSERVABLE effect, which is the only thing that actually matters: a
    // tombstone the improver wrote must silence the shell's reader.
    const legacy = { question: "decision-verdict", answer: "wrong", original: { duty: "fix" }, timestamp: AT, provenance: "decision-verdict" };
    queueLine(legacy);
    const key = signals.derivedKeyForLine(JSON.stringify(legacy));
    expect(view.tombstoneSignal(key, { queueFile }).ok).toBe(true);
    expect(await readEvidence(compositionDir)).toHaveLength(0);
  });

  it("trackContributionForRecord mirrors evidenceFromVerdict for every verdict shape", () => {
    const cases = [
      { verdict: "right" as const, resolved: { duty: "fix" } },
      { verdict: "wrong" as const, resolved: { duty: "fix" }, correction: { flow: "feature" } },
      { verdict: "wrong" as const, resolved: { flow: "fix" }, correction: { tier: "T2" } },
      { verdict: "wrong" as const, resolved: { duty: "fix" }, correction: { model: "opus" } },
      { verdict: "wrong" as const, resolved: { duty: "fix" } },
      { verdict: "unsure" as const, resolved: { duty: "fix" } }
    ];
    for (const c of cases) {
      const record = JSON.parse(JSON.stringify(buildVerdictRecord({ decisionId: "d", at: AT, ...c })!));
      const shell = evidenceFromVerdict(record).map(({ category, shape, signal }) => ({ category, shape, signal }));
      expect(signals.trackContributionForRecord(record)).toEqual(shell);
    }
  });

  it("a record from another producer is not read as a verdict by either side", () => {
    const override = gatewayQueue.buildOverrideRecord({ answer: "full pipeline", applied: { plan: "full", flow: "fix" }, at: AT });
    expect(signals.trackContributionForRecord(override)).toEqual([]);
    expect(evidenceFromVerdict(override)).toEqual([]);
  });
});

describe("the Signals payload", () => {
  it("says what each record feeds, so a delete has a stated consequence", () => {
    queueLine(gatewayQueue.buildOverrideRecord({ answer: "full pipeline", applied: { plan: "full", flow: "fix" }, at: AT }));
    queueLine(probeCore.buildFeedbackRecord({ question: "How did that go?", answer: "Went well", classification: { kind: "fix" }, at: AT }));
    const out = view.collectSignals({ queueFile, dir: path.join(home, "improver") });
    const [wentWell, override] = out.signals; // newest first
    expect(override.feedsRule.category).toBe("deeper");
    expect(override.contributes).toBe(true);
    // "Went well" is a real answer that proposes nothing. The view says so
    // instead of implying every row is driving something.
    expect(wentWell.feedsRule.category).toBeNull();
    expect(wentWell.contributes).toBe(false);
  });

  it("carries pending probe questions and the probe-skip tail, labelled as such", () => {
    const dir = path.join(home, "improver");
    writeFileSync(
      path.join(dir, "probe-pending-abc.json"),
      JSON.stringify({
        id: "p-1",
        session_id: "abc",
        mode: "probe",
        askedAt: AT,
        deliveredVia: { relay: true, channels: ["web-channel-default"] },
        questions: [{ area: "went-well", question: "How did that go?", options: ["Went well"] }]
      })
    );
    writeFileSync(path.join(dir, "probe-skip.log"), `${AT} probe-question target unreachable\n`);
    const out = view.collectSignals({ queueFile, dir });
    expect(out.pendingProbes).toHaveLength(1);
    expect(out.pendingProbes[0].deliveredVia.channels).toEqual(["web-channel-default"]);
    expect(out.probeSkips[0]).toContain("target unreachable");
  });

  it("counts deleted records separately rather than hiding them", () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", at: AT })!;
    queueLine(rec);
    view.tombstoneSignal(String(rec.id), { reason: "wrong tap", queueFile });
    const out = view.collectSignals({ queueFile, dir: path.join(home, "improver") });
    expect(out.counts).toMatchObject({ total: 1, live: 0, deleted: 1, tombstones: 1 });
    expect(out.signals[0].tombstoned).toBe(true);
    expect(out.signals[0].tombstoneReason).toBe("wrong tap");
  });
});
