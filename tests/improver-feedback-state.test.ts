// The improver feedback queue, after it moved off the shared JSONL file and into
// the state service (mesh phase 2, §4.5).
//
// The file was one machine's queue with three concurrent writers and a path
// computed identically in four places. Getting any one of those four wrong split
// the loop in half, and both halves then looked under-evidenced. The service
// replaces the "one path, four spellings" contract with one endpoint, and
// replaces the append-only DISCIPLINE with an append-only API — there is no
// update and no delete verb for either table, so a deletion can only be a
// tombstone.
//
// These tests pin the three things that migration had to preserve exactly:
//
//   1. all three producers still land in ONE queue, in order, with their record
//      shape carried through verbatim (every reader reconstructs what it read
//      off the line before);
//   2. a tombstone still hides a record from every consumer's read while leaving
//      it retrievable — deletion is an append, never a rewrite;
//   3. a record imported from the pre-mesh file, whose only handle is the
//      byte-identical DERIVED key, is still deletable by that key.
//
// And one thing the migration deliberately did NOT preserve: there is no local
// fallback queue. An unreachable state service is a loud error, because a
// feedback loop that silently splits is worse than one that stops.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateClient, StateUnavailableError } from "@garrison/state-client";

import { startStateService } from "./state-service-harness";
import { recordDecisionVerdict } from "@/lib/decision-verdicts-store";
import { buildVerdictRecord } from "@/lib/decision-verdicts";
import { resetStateClient } from "@/lib/state-client";
import { readEvidence } from "@/lib/routing-tracks";

// @ts-ignore - pure .mjs
import * as signals from "../fittings/seed/improver/lib/feedback-signals.mjs";
// @ts-ignore - pure .mjs
import * as store from "../fittings/seed/improver/lib/probe-store.mjs";
// @ts-ignore - pure .mjs
import * as feedbackRule from "../fittings/seed/improver/lib/feedback-rule.mjs";
// @ts-ignore - pure .mjs
import * as view from "../fittings/seed/improver/lib/signals-view.mjs";
// @ts-ignore - pure .mjs
import * as probeCore from "../fittings/seed/improver/lib/probe-core.mjs";
// @ts-ignore - pure .mjs
import * as gatewayQueue from "../fittings/seed/http-gateway/scripts/lib/feedback-queue.mjs";

const AT = "2026-08-24T09:00:00.000Z";

let h: Awaited<ReturnType<typeof startStateService>>;
let home: string;
let compositionDir: string;

const saved = {
  url: process.env.GARRISON_STATE_URL,
  token: process.env.GARRISON_STATE_TOKEN,
  node: process.env.GARRISON_NODE_NAME,
  home: process.env.GARRISON_HOME,
  data: process.env.IMPROVER_DATA
};

/** Every producer discovers the service from the env the runner projects. Setting
 *  it here (rather than threading a client through every call) is the point: it
 *  proves the discovery path the fittings actually run on. */
function useHarness() {
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.token;
  process.env.GARRISON_NODE_NAME = "test-node";
  resetStateClient();
  signals.resetFeedbackClient();
  gatewayQueue.resetFeedbackClient();
}

// A FRESH service (and DB) per test. Both tables are append-only by design —
// there is no delete verb to reset them with — so isolation is a new database,
// not a cleanup. That is also the honest shape: nothing in this area is allowed
// to remove a row, including a test.
beforeEach(async () => {
  h = await startStateService();
  useHarness();
});

afterEach(async () => {
  await h?.stop();
});

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "gar-feedback-state-"));
  compositionDir = path.join(home, "composition");
  await mkdir(path.join(compositionDir, ".garrison"), { recursive: true });
  process.env.GARRISON_HOME = home;
  process.env.IMPROVER_DATA = path.join(home, "improver");
}, 30_000);

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  for (const [key, value] of [
    ["GARRISON_STATE_URL", saved.url],
    ["GARRISON_STATE_TOKEN", saved.token],
    ["GARRISON_NODE_NAME", saved.node],
    ["GARRISON_HOME", saved.home],
    ["IMPROVER_DATA", saved.data]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStateClient();
  signals.resetFeedbackClient();
  gatewayQueue.resetFeedbackClient();
});

async function liveRecords(): Promise<Array<Record<string, unknown>>> {
  const rows = await h.client.listFeedback({ limit: 500 });
  return rows.map((r: { payload: Record<string, unknown> }) => r.payload);
}

describe("three producers, one queue", () => {
  it("gateway override, probe answer and decision verdict all land, in order, verbatim", async () => {
    const override = gatewayQueue.buildOverrideRecord({
      session_id: "s1",
      answer: "run the full pipeline",
      original: { plan: "quick" },
      applied: { plan: "full" },
      at: AT
    });
    const probe = probeCore.buildFeedbackRecord({
      session_id: "s2",
      area: "went-well",
      question: "How did that go?",
      answer: "Needed rework",
      classification: { kind: "fix" },
      provenance: "probe",
      at: AT
    });
    const verdict = buildVerdictRecord({
      decisionId: "d1",
      verdict: "wrong",
      resolved: { duty: "fix" },
      correction: { duty: "review" },
      at: AT
    })!;

    const appended = await gatewayQueue.appendFeedback(override);
    await store.appendFeedback(probe);
    expect(await recordDecisionVerdict({ decisionId: "d1", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: AT })).toBe(true);

    // The service accepts the id the producer minted — the record's own handle IS
    // the row's primary key, which is what makes it tombstonable.
    expect(appended.id).toBe(override.id);

    const records = await liveRecords();
    expect(records.map((r) => r.provenance)).toEqual(["override", "probe", "decision-verdict"]);
    // Verbatim: the payload is the record every reader used to parse off the line.
    expect(records[0]).toEqual(override);
    expect(records[1]).toEqual(probe);
    expect(records[2]).toMatchObject({
      area: "orchestrator",
      question: "decision-verdict",
      answer: verdict.answer,
      decision_id: "d1",
      original: { duty: "fix" },
      applied: { duty: "review" }
    });
  });

  it("nothing is written to the pre-mesh file — there is no fallback queue", async () => {
    await store.appendFeedback(probeCore.buildFeedbackRecord({ question: "q", answer: "Went well", at: AT }));
    expect(existsSync(signals.feedbackQueuePath())).toBe(false);
    expect(existsSync(gatewayQueue.improverQueuePath())).toBe(false);
  });

  it("a duplicate id is a 409, not a second copy of the signal", async () => {
    const rec = probeCore.buildFeedbackRecord({ question: "q", answer: "Right call", at: AT });
    await store.appendFeedback(rec);
    await expect(store.appendFeedback(rec)).rejects.toMatchObject({ status: 409 });
  });

  it("an unreachable service throws rather than queueing locally", async () => {
    // Port 1 is never listening; the client retries once and then fails loudly.
    const dead = new StateClient({ url: "http://127.0.0.1:1", token: "t", timeoutMs: 500 });
    await expect(
      signals.appendFeedbackRecord(probeCore.buildFeedbackRecord({ question: "q", answer: "a", at: AT }), {
        client: dead
      })
    ).rejects.toBeInstanceOf(StateUnavailableError);
  });
});

describe("deletion is a tombstone, never a rewrite", () => {
  it("hides the record from every consumer's read, and keeps it retrievable", async () => {
    const a = buildVerdictRecord({ decisionId: "t1", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: AT })!;
    const b = buildVerdictRecord({ decisionId: "t2", verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "review" }, at: AT })!;
    await signals.appendFeedbackRecord(a);
    await signals.appendFeedbackRecord(b);

    expect(await feedbackRule.collectFeedback()).toHaveLength(2);
    expect((await feedbackRule.runFeedbackRule({ now: AT })).proposals.length).toBeGreaterThanOrEqual(1);

    const deleted = await view.tombstoneSignal(String(a.id), { reason: "misclicked" });
    expect(deleted).toMatchObject({ ok: true, target: a.id });

    // The default read drops it …
    const live = await signals.readFeedbackQueue();
    expect(live.entries.map((e: { key: string }) => e.key)).toEqual([b.id]);
    expect(await feedbackRule.collectFeedback()).toHaveLength(1);

    // … and the tombstoned read still has it, flagged. The row was never rewritten.
    const all = await signals.readFeedbackQueue({ includeTombstoned: true });
    const row = all.entries.find((e: { key: string }) => e.key === a.id);
    expect(row).toBeTruthy();
    expect(row.tombstoned).toBe(true);
    expect(row.record).toEqual(a);
    expect(all.entries.find((e: { key: string }) => e.key === b.id).tombstoned).toBe(false);
  });

  it("refuses a tombstone that names nothing, and re-deleting is a no-op success", async () => {
    const rec = buildVerdictRecord({ decisionId: "t3", verdict: "wrong", at: AT })!;
    await signals.appendFeedbackRecord(rec);
    expect(await view.tombstoneSignal("fq-000000000-deadbeef")).toMatchObject({ ok: false, code: "not-found" });
    expect(await view.tombstoneSignal(String(rec.id))).toMatchObject({ ok: true });
    expect(await view.tombstoneSignal(String(rec.id))).toMatchObject({ ok: true, alreadyDeleted: true });
  });

  it("the Signals view counts deleted records rather than hiding them", async () => {
    const rec = buildVerdictRecord({ decisionId: "t4", verdict: "wrong", at: AT })!;
    await signals.appendFeedbackRecord(rec);
    await view.tombstoneSignal(String(rec.id), { reason: "wrong tap" });
    const out = await view.collectSignals({ dir: path.join(home, "improver") });
    const shown = out.signals.find((s: { key: string }) => s.key === rec.id);
    expect(shown.tombstoned).toBe(true);
    expect(out.counts.deleted).toBeGreaterThanOrEqual(1);
  });

  it("deleting the record deletes the inference the shell drew from it", async () => {
    const rec = buildVerdictRecord({ decisionId: "t5", verdict: "wrong", resolved: { duty: "fix" }, at: AT })!;
    await recordDecisionVerdict({ decisionId: "t5", verdict: "wrong", resolved: { duty: "fix" }, at: AT });
    const before = await readEvidence(compositionDir);
    expect(before.length).toBeGreaterThan(0);

    // The verdict's own id is what the panel writes and what the view deletes.
    const entries = (await signals.readFeedbackQueue()).entries;
    const target = entries[entries.length - 1].key;
    expect(String(target)).toMatch(/^fq-/);
    expect(rec.provenance).toBe("decision-verdict"); // same producer, same shape
    await view.tombstoneSignal(target);
    expect(await readEvidence(compositionDir)).toHaveLength(0);
  });
});

describe("records imported from the pre-mesh file", () => {
  // The importer walked the old JSONL: a record with no id got a key DERIVED from
  // its raw line (`raw:<sha256[..32]>`), stored in `legacy_key`. That derivation
  // has to stay byte-identical here or a historical record becomes permanently
  // undeletable — nothing else on the row can name it.
  const legacy = {
    area: "orchestrator",
    question: "decision-verdict",
    answer: "wrong",
    original: { duty: "fix" },
    timestamp: AT,
    provenance: "decision-verdict"
  };

  async function importLegacyRow() {
    const rawLine = JSON.stringify(legacy);
    const legacyKey = signals.derivedKeyForLine(rawLine);
    await h.client.appendFeedback({ id: legacyKey, legacyKey, area: "orchestrator", payload: legacy });
    return legacyKey;
  }

  it("read back with the derived key as their handle", async () => {
    const legacyKey = await importLegacyRow();
    const { entries } = await signals.readFeedbackQueue();
    const row = entries.find((e: { key: string }) => e.key === legacyKey);
    expect(row).toBeTruthy();
    expect(row.key).toMatch(/^raw:[0-9a-f]{32}$/);
    expect(row.record).toEqual(legacy);
    // The view says "no minted id" honestly rather than showing the row key as one.
    const described = view.describeSignal(row);
    expect(described.id).toBeNull();
    expect(described.key).toBe(legacyKey);
  });

  it("are hidden by a tombstone naming the LEGACY key", async () => {
    const legacyKey = await importLegacyRow();
    expect(await readEvidence(compositionDir)).toHaveLength(2); // one flow + one level
    expect(await view.tombstoneSignal(legacyKey)).toMatchObject({ ok: true });
    expect((await signals.readFeedbackQueue()).entries).toHaveLength(0);
    expect(await feedbackRule.collectFeedback()).toHaveLength(0);
    expect(await readEvidence(compositionDir)).toHaveLength(0);
  });
});
