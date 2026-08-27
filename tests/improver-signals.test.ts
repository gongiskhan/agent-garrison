// The feedback queue's IDENTITY and DELETE contract.
//
// Three producers append to one shared queue, and until ids existed a record on
// it could not be named, so it could not be deleted, so a wrong inference could
// only be corrected by hand-editing the file. These tests pin the two things
// that make deletion work:
//
//   1. every producer stamps an id, and
//   2. every READER — the improver's feedback rule, the Signals view, and the
//      shell's autonomy bands — resolves tombstones the same way.
//
// Since mesh phase 2 (§4.5) the queue is the state service's two append-only
// tables rather than a JSONL file, which changes WHERE (2) is enforced but not
// what it means: the tombstone join now runs once in SQL, so the three readers
// agree by construction instead of by three matching implementations.
//
// The key derivation for id-less historical records still matters and is still
// duplicated across a language boundary (.mjs in the fitting, .ts in the shell,
// and once more in the importer). It is what named every pre-mesh record when
// the importer moved it into the `legacy_key` column, and it is what a
// transition read of a leftover `*.pre-mesh` file needs. If those derivations
// drift, a historical record becomes permanently undeletable — so the parity is
// asserted here rather than assumed.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startStateService } from "./state-service-harness";
import { buildVerdictRecord } from "@/lib/decision-verdicts";
import { readEvidence, evidenceFromVerdict, parseFeedbackQueue as parseShell } from "@/lib/routing-tracks";
import { resetStateClient } from "@/lib/state-client";

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
let compositionDir: string;
let h: Awaited<ReturnType<typeof startStateService>>;
const saved = {
  home: process.env.GARRISON_HOME,
  data: process.env.IMPROVER_DATA,
  url: process.env.GARRISON_STATE_URL,
  token: process.env.GARRISON_STATE_TOKEN
};

/** Append one record the way its producer would. */
function queueRecord(record: unknown) {
  return signals.appendFeedbackRecord(record);
}

/**
 * Insert a row the way the one-time importer did: a record that predates ids,
 * keyed ONLY by the derived hash of its raw line, stored in `legacy_key`.
 * Returns that key — the only handle such a record will ever have.
 */
async function importLegacyLine(record: unknown): Promise<string> {
  const rawLine = JSON.stringify(record);
  const legacyKey = signals.derivedKeyForLine(rawLine);
  await h.client.appendFeedback({ id: legacyKey, legacyKey, payload: record as Record<string, unknown> });
  return legacyKey;
}

// A fresh service per test: both tables are append-only and have no delete verb,
// so isolation is a new database rather than a cleanup.
beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "gar-signals-"));
  mkdirSync(path.join(home, "improver"), { recursive: true });
  compositionDir = path.join(home, "composition");
  mkdirSync(path.join(compositionDir, ".garrison"), { recursive: true });
  process.env.GARRISON_HOME = home;
  process.env.IMPROVER_DATA = path.join(home, "improver");
  h = await startStateService();
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.token;
  resetStateClient();
  signals.resetFeedbackClient();
  gatewayQueue.resetFeedbackClient();
});

afterEach(async () => {
  await h?.stop();
  for (const [key, value] of [
    ["GARRISON_HOME", saved.home],
    ["IMPROVER_DATA", saved.data],
    ["GARRISON_STATE_URL", saved.url],
    ["GARRISON_STATE_TOKEN", saved.token]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStateClient();
  signals.resetFeedbackClient();
  gatewayQueue.resetFeedbackClient();
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

  it("the minted id becomes the row's own id, so a tombstone can name it", async () => {
    const rec = buildVerdictRecord({ decisionId: "dec-1", verdict: "wrong", at: AT })!;
    const { id } = await queueRecord(rec);
    expect(id).toBe(rec.id);
  });
});

describe("tombstone round-trip", () => {
  it("a deleted verdict stops feeding collectFeedback AND the shell's readEvidence", async () => {
    // Two "wrong" verdicts correcting the same dimension: enough for the feedback
    // rule's min-signal bar, and real evidence for the level track.
    const a = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: AT })!;
    const b = buildVerdictRecord({ decisionId: "d2", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: "2026-08-13T11:00:00.000Z" })!;
    await queueRecord(a);
    await queueRecord(b);

    expect(await feedbackRule.collectFeedback()).toHaveLength(2);
    expect((await feedbackRule.runFeedbackRule({ now: AT })).proposals.length).toBeGreaterThanOrEqual(1);
    const before = await readEvidence(compositionDir);
    expect(before.length).toBeGreaterThan(0);

    const res = await view.tombstoneSignal(String(a.id), { reason: "misclicked" });
    expect(res.ok).toBe(true);
    await view.tombstoneSignal(String(b.id), { reason: "misclicked" });

    // The improver's consumer no longer sees them …
    expect(await feedbackRule.collectFeedback()).toHaveLength(0);
    expect((await feedbackRule.runFeedbackRule({ now: AT })).proposals).toHaveLength(0);
    // … and neither do the autonomy bands, which is the half that used to be
    // impossible: deleting the record is what deletes the inference.
    expect(await readEvidence(compositionDir)).toHaveLength(0);
  });

  it("deletes by APPENDING — the original record is untouched and still retrievable", async () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", at: AT })!;
    await queueRecord(rec);
    await view.tombstoneSignal(String(rec.id));
    // The row was never rewritten: it comes back byte-for-byte, flagged deleted.
    const { entries } = await signals.readFeedbackQueue({ includeTombstoned: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].record).toEqual(rec);
    expect(entries[0].tombstoned).toBe(true);
  });

  it("a record with NO id is deletable by its derived line key", async () => {
    // Every record the importer moved off the file predates ids. They must still
    // be deletable, or the historical queue is permanently uncorrectable.
    const legacy = { area: "orchestrator", question: "decision-verdict", answer: "wrong", original: { duty: "fix" }, timestamp: AT, provenance: "decision-verdict" };
    const legacyKey = await importLegacyLine(legacy);
    expect((await readEvidence(compositionDir)).length).toBeGreaterThan(0);

    const collected = await view.collectSignals({ dir: path.join(home, "improver") });
    const row = collected.signals[0];
    expect(row.id).toBeNull();
    expect(row.key).toBe(legacyKey);
    expect(row.key).toMatch(/^raw:[0-9a-f]{32}$/);

    expect((await view.tombstoneSignal(row.key)).ok).toBe(true);
    expect(await readEvidence(compositionDir)).toHaveLength(0);
    expect(await feedbackRule.collectFeedback()).toHaveLength(0);
  });

  it("deleting one record leaves its neighbours alone", async () => {
    const keep = buildVerdictRecord({ decisionId: "keep", verdict: "wrong", resolved: { duty: "fix" }, at: AT })!;
    const drop = buildVerdictRecord({ decisionId: "drop", verdict: "wrong", resolved: { duty: "review" }, at: AT })!;
    await queueRecord(keep);
    await queueRecord(drop);
    await view.tombstoneSignal(String(drop.id));
    const shapes = (await readEvidence(compositionDir)).map((e) => e.shape);
    expect(shapes).toContain("fix");
    expect(shapes).not.toContain("review");
  });

  it("a tombstone naming nothing is refused rather than silently recorded", async () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "right", at: AT })!;
    await queueRecord(rec);
    expect(await view.tombstoneSignal("fq-000000000-deadbeef")).toMatchObject({ ok: false, code: "not-found" });
    // Nothing was hidden, and no tombstone naming nothing was written.
    expect((await signals.readFeedbackQueue()).entries).toHaveLength(1);
  });

  it("re-deleting is a no-op success, not a second tombstone", async () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", at: AT })!;
    await queueRecord(rec);
    await view.tombstoneSignal(String(rec.id));
    expect(await view.tombstoneSignal(String(rec.id))).toMatchObject({ ok: true, alreadyDeleted: true });
    const { entries } = await signals.readFeedbackQueue({ includeTombstoned: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].tombstoned).toBe(true);
  });
});

describe("reader parity across the language boundary", () => {
  it("a tombstone naming a legacy key silences BOTH readers", async () => {
    // Both readers now read the same rows through the service, which does the
    // tombstone join in SQL — so what this asserts is that the derived key the
    // improver writes a tombstone against is the one the importer stored.
    const legacy = { question: "decision-verdict", answer: "wrong", original: { duty: "fix" }, timestamp: AT, provenance: "decision-verdict" };
    const legacyKey = await importLegacyLine(legacy);
    expect((await view.tombstoneSignal(legacyKey)).ok).toBe(true);
    expect(await readEvidence(compositionDir)).toHaveLength(0);
    expect(await feedbackRule.collectFeedback()).toHaveLength(0);
  });

  it("the .mjs and .ts derived keys agree, byte for byte, on a pre-mesh line", () => {
    // The two pre-mesh parsers are off the live path but not dead: they are what
    // reads a leftover `feedback-queue.jsonl(.pre-mesh)`, and their derivation is
    // what the importer used to fill `legacy_key`. A drift here means a
    // historical record the Signals view deletes stays alive in the bands.
    const legacy = { question: "decision-verdict", answer: "wrong", original: { duty: "fix" }, timestamp: AT, provenance: "decision-verdict" };
    const line = JSON.stringify(legacy);
    const key = signals.derivedKeyForLine(line);

    // The .ts derivation is private to routing-tracks; it is exercised through
    // its OBSERVABLE effect, which is the only thing that actually matters: a
    // tombstone keyed by the .mjs derivation must silence the .ts reader.
    const text = [line, JSON.stringify({ kind: "tombstone", target: key })].join("\n");
    expect(parseShell(text)).toHaveLength(0);
    expect(parseShell(line)).toHaveLength(1);
    // …and the .mjs parser reaches the same verdict on the same bytes.
    const mjs = signals.parseFeedbackQueue(text);
    expect(mjs.entries).toHaveLength(1);
    expect(mjs.entries[0].tombstoned).toBe(true);
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
  it("says what each record feeds, so a delete has a stated consequence", async () => {
    await queueRecord(gatewayQueue.buildOverrideRecord({ answer: "full pipeline", applied: { plan: "full", flow: "fix" }, at: AT }));
    await queueRecord(probeCore.buildFeedbackRecord({ question: "How did that go?", answer: "Went well", classification: { kind: "fix" }, at: AT }));
    const out = await view.collectSignals({ dir: path.join(home, "improver") });
    const [wentWell, override] = out.signals; // newest first
    expect(override.feedsRule.category).toBe("deeper");
    expect(override.contributes).toBe(true);
    // "Went well" is a real answer that proposes nothing. The view says so
    // instead of implying every row is driving something.
    expect(wentWell.feedsRule.category).toBeNull();
    expect(wentWell.contributes).toBe(false);
  });

  it("carries pending probe questions and the probe-skip tail, labelled as such", async () => {
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
    const out = await view.collectSignals({ dir });
    expect(out.pendingProbes).toHaveLength(1);
    expect(out.pendingProbes[0].deliveredVia.channels).toEqual(["web-channel-default"]);
    expect(out.probeSkips[0]).toContain("target unreachable");
  });

  it("counts deleted records separately rather than hiding them", async () => {
    const rec = buildVerdictRecord({ decisionId: "d1", verdict: "wrong", at: AT })!;
    await queueRecord(rec);
    await view.tombstoneSignal(String(rec.id), { reason: "wrong tap" });
    const out = await view.collectSignals({ dir: path.join(home, "improver") });
    expect(out.counts).toMatchObject({ total: 1, live: 0, deleted: 1, tombstones: 1 });
    expect(out.signals[0].tombstoned).toBe(true);
    // WHEN and WHY are recorded in `feedback_tombstones`, which the service
    // exposes no read verb for — so the view reports the deletion without
    // inventing its metadata. (A GET /v1/feedback/tombstones would restore it.)
    expect(out.signals[0].tombstoneReason).toBeNull();
  });
});
