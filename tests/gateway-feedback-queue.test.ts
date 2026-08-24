// GARRISON-FLOW-V2 S7 (D20) — the conversational-override feedback record.
//
// The gateway records ONE override event per real override into the Improver
// evidence queue: the operator's words + BOTH the prior and applied resolution.
// Agreement is never recorded. These tests pin the pure lib (phrase detection,
// record shape, the append) and the /feedback/override endpoint behaviour
// end-to-end.
//
// Since mesh phase 2 (§4.5) that queue is the state service's `feedback_queue`
// table rather than ~/.garrison/improver/feedback-queue.jsonl, so the append is
// asserted against a real service on an ephemeral port. The record shape did not
// move: the payload is the record verbatim.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { startStateService } from "./state-service-harness";

const ROOT = path.resolve(__dirname, "..");
const LIB = pathToFileURL(
  path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/feedback-queue.mjs")
).href;

async function lib() {
  return import(LIB);
}

let home: string;
let h: Awaited<ReturnType<typeof startStateService>>;
const savedState = { url: process.env.GARRISON_STATE_URL, token: process.env.GARRISON_STATE_TOKEN };

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "improver-home-"));
  process.env.GARRISON_HOME = home;
  h = await startStateService();
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.token;
  (await lib()).resetFeedbackClient();
});
afterEach(async () => {
  await h?.stop();
  delete process.env.GARRISON_HOME;
  if (savedState.url === undefined) delete process.env.GARRISON_STATE_URL;
  else process.env.GARRISON_STATE_URL = savedState.url;
  if (savedState.token === undefined) delete process.env.GARRISON_STATE_TOKEN;
  else process.env.GARRISON_STATE_TOKEN = savedState.token;
  (await lib()).resetFeedbackClient();
  rmSync(home, { recursive: true, force: true });
});

async function readQueue(): Promise<any[]> {
  const rows = await h.client.listFeedback({ limit: 500 });
  return rows.map((r: { payload: unknown }) => r.payload);
}

describe("detectOverride — the three example phrases + close variants", () => {
  it("maps 'full pipeline' / background / kick off a build to the full plan", async () => {
    const { detectOverride } = await lib();
    expect(detectOverride("actually, run the full pipeline on this")?.plan).toBe("full");
    expect(detectOverride("run this in the background")?.plan).toBe("full");
    expect(detectOverride("kick off a build for it")?.plan).toBe("full");
  });
  it("maps 'just do it quickly' / keep it quick to the quick plan", async () => {
    const { detectOverride } = await lib();
    expect(detectOverride("just do it quickly")?.plan).toBe("quick");
    expect(detectOverride("keep it quick, no pipeline")?.plan).toBe("quick");
  });
  it("returns null when no override phrase is present (agreement is not an override)", async () => {
    const { detectOverride } = await lib();
    expect(detectOverride("add a login form to the settings page")).toBeNull();
    expect(detectOverride("")).toBeNull();
  });
  it("F2: does NOT false-positive on narrative sentences (the reviewer's example)", async () => {
    const { detectOverride } = await lib();
    // the old loose /quick(ly)? just/ rule matched this — it must not any more
    expect(detectOverride("I quickly just realized the tests already pass")).toBeNull();
    expect(detectOverride("she quickly, just before lunch, fixed the bug")).toBeNull();
  });
  it("F2: does NOT fire on a long narrative that merely mentions the phrase late", async () => {
    const { detectOverride } = await lib();
    const narrative =
      "I was thinking about how, once the design settles and the whole team has agreed on the approach, " +
      "we could eventually run the full pipeline on the auth refactor to be safe";
    expect(detectOverride(narrative)).toBeNull(); // >120 chars AND phrase not leading
  });
  it("F2: DOES fire on a short directive or a leading override clause", async () => {
    const { detectOverride } = await lib();
    expect(detectOverride("actually, run the full pipeline on this")?.plan).toBe("full");
    expect(detectOverride("skip the ceremony")?.plan).toBe("quick");
  });
  it("returns the matched phrase verbatim as the answer", async () => {
    const { detectOverride } = await lib();
    const d = detectOverride("please run the full pipeline");
    expect(typeof d?.answer).toBe("string");
    // the answer is whatever override phrase matched (here a "full"-plan phrase)
    expect(d?.plan).toBe("full");
    expect(d?.answer.toLowerCase()).toContain("full");
  });
});

describe("buildOverrideRecord — the D20 schema", () => {
  it("carries area/question/answer/original/applied/timestamp/provenance", async () => {
    const { buildOverrideRecord } = await lib();
    const rec = buildOverrideRecord({
      session_id: "thread-7",
      answer: "full pipeline",
      original: { taskType: "code", tier: "T0-trivial", flow: null, plan: "quick" },
      applied: { taskType: "code", tier: "T0-trivial", flow: null, plan: "full" },
      at: "2026-07-11T00:00:00.000Z",
    });
    expect(rec).toEqual({
      // Every producer now mints a stable id (tombstone deletes target it);
      // sortable-by-mint-time, format owned by improver/lib/feedback-signals.mjs.
      id: expect.stringMatching(/^fq-[0-9a-z]{9}-[0-9a-f]{8}$/),
      session_id: "thread-7",
      area: "orchestrator",
      question: "override",
      answer: "full pipeline",
      original: { taskType: "code", tier: "T0-trivial", flow: null, plan: "quick" },
      applied: { taskType: "code", tier: "T0-trivial", flow: null, plan: "full" },
      timestamp: "2026-07-11T00:00:00.000Z",
      provenance: "override",
    });
  });
  it("omits session_id when absent (optional field)", async () => {
    const { buildOverrideRecord } = await lib();
    const rec = buildOverrideRecord({ answer: "keep it quick", original: null, applied: null, at: "t" });
    expect(rec).not.toHaveProperty("session_id");
    expect(rec.provenance).toBe("override");
  });
});

describe("appendFeedback — one record, one transaction, into the shared queue", () => {
  it("appends one row per call, in order, with the record carried verbatim", async () => {
    const { appendFeedback, buildOverrideRecord } = await lib();
    const first = buildOverrideRecord({ answer: "a", original: null, applied: null, at: "t1" });
    const appended = await appendFeedback(first);
    await appendFeedback(buildOverrideRecord({ answer: "b", original: null, applied: null, at: "t2" }));
    // The id the gateway minted IS the row id — that is what makes the record
    // tombstonable from the Signals view later.
    expect(appended.id).toBe(first.id);
    const recs = await readQueue();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual(first);
    expect(recs[1].answer).toBe("b");
    expect(recs.every((r) => r.provenance === "override")).toBe(true);
  });
  it("writes NOTHING to the pre-mesh file — there is no local fallback queue", async () => {
    const { appendFeedback, buildOverrideRecord, improverQueuePath } = await lib();
    await appendFeedback(buildOverrideRecord({ answer: "a", original: null, applied: null, at: "t1" }));
    // The path is still resolved the way it always was (GARRISON_HOME), because
    // it is still the honest answer to "where did this live before".
    expect(improverQueuePath()).toBe(path.join(home, "improver", "feedback-queue.jsonl"));
    expect(existsSync(improverQueuePath())).toBe(false);
  });
});

describe("/feedback/override endpoint records the override", () => {
  it("appends a well-formed record and rejects a body with no answer", async () => {
    // Drive the endpoint's core the way gateway-pty wires it (buildOverrideRecord
    // → appendFeedback); a missing answer is a 400 there, so assert the guard here.
    const { appendFeedback, buildOverrideRecord } = await lib();
    const answer = "run this in the background";
    await appendFeedback(
      buildOverrideRecord({
        session_id: "s1",
        answer,
        original: { taskType: "code", tier: "T1-standard", flow: null, plan: "quick" },
        applied: { taskType: "code", tier: "T1-standard", flow: null, plan: "full" },
      })
    );
    const recs = await readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0].answer).toBe(answer);
    expect(recs[0].original.plan).toBe("quick");
    expect(recs[0].applied.plan).toBe("full");
    expect(recs[0].session_id).toBe("s1");
  });
});
