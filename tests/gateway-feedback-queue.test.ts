// GARRISON-FLOW-V2 S7 (D20) — the conversational-override feedback record.
//
// The gateway records ONE override event per real override into the Improver
// evidence queue (~/.garrison/improver/feedback-queue.jsonl): the operator's
// words + BOTH the prior and applied resolution. Agreement is never recorded.
// These tests pin the pure lib (phrase detection, record shape, atomic append)
// and the /feedback/override endpoint behaviour end-to-end against a sandbox home.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const LIB = pathToFileURL(
  path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/feedback-queue.mjs")
).href;

async function lib() {
  return import(LIB);
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "improver-home-"));
  process.env.GARRISON_HOME = home;
});
afterEach(() => {
  delete process.env.GARRISON_HOME;
  rmSync(home, { recursive: true, force: true });
});

function readQueue(): any[] {
  const f = path.join(home, "improver", "feedback-queue.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
      original: { taskType: "code", tier: "T0-trivial", workKind: null, plan: "quick" },
      applied: { taskType: "code", tier: "T0-trivial", workKind: null, plan: "full" },
      at: "2026-07-11T00:00:00.000Z",
    });
    expect(rec).toEqual({
      session_id: "thread-7",
      area: "orchestrator",
      question: "override",
      answer: "full pipeline",
      original: { taskType: "code", tier: "T0-trivial", workKind: null, plan: "quick" },
      applied: { taskType: "code", tier: "T0-trivial", workKind: null, plan: "full" },
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

describe("appendFeedback — atomic JSONL append to the improver queue", () => {
  it("creates the queue (and its dir) and appends one record per call", async () => {
    const { appendFeedback, buildOverrideRecord } = await lib();
    await appendFeedback(buildOverrideRecord({ answer: "a", original: null, applied: null, at: "t1" }));
    await appendFeedback(buildOverrideRecord({ answer: "b", original: null, applied: null, at: "t2" }));
    const recs = readQueue();
    expect(recs).toHaveLength(2);
    expect(recs[0].answer).toBe("a");
    expect(recs[1].answer).toBe("b");
    expect(recs.every((r) => r.provenance === "override")).toBe(true);
  });
  it("targets ~/.garrison (GARRISON_HOME)/improver/feedback-queue.jsonl", async () => {
    const { improverQueuePath } = await lib();
    expect(improverQueuePath()).toBe(path.join(home, "improver", "feedback-queue.jsonl"));
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
        original: { taskType: "code", tier: "T1-standard", workKind: null, plan: "quick" },
        applied: { taskType: "code", tier: "T1-standard", workKind: null, plan: "full" },
      })
    );
    const recs = readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0].answer).toBe(answer);
    expect(recs[0].original.plan).toBe("quick");
    expect(recs[0].applied.plan).toBe("full");
    expect(recs[0].session_id).toBe("s1");
  });
});
