// GARRISON-FLOW-V2 S8 (D26/E13) — the garrison-control record_improver_feedback
// tool: the Improver-Probe capture FALLBACK for surfaces without a PostToolUse
// hook. It appends one D26 record directly to the shared feedback queue.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const TOOLS = pathToFileURL(path.join(ROOT, "fittings/seed/mcp-gateway/scripts/lib/tools.mjs")).href;

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "gw-fb-"));
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

describe("callRecordImproverFeedback", () => {
  it("appends a D26 probe record (provenance probe) to ~/.garrison/improver/feedback-queue.jsonl", async () => {
    const { callRecordImproverFeedback } = await import(TOOLS);
    const res = await callRecordImproverFeedback({ session_id: "s1", area: "orchestrator", question: "Was that right?", answer: "Right call" });
    expect(res.recorded).toBe(true);
    expect(res.queue).toBe(path.join(home, "improver", "feedback-queue.jsonl"));
    const recs = readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      session_id: "s1",
      area: "orchestrator",
      question: "Was that right?",
      answer: "Right call",
      provenance: "probe",
    });
    expect(recs[0]).toHaveProperty("timestamp");
    expect(recs[0].classification).toEqual({ kind: null, tier: null, plan: null });
  });

  it("appends one record per call (single-writer JSONL)", async () => {
    const { callRecordImproverFeedback } = await import(TOOLS);
    await callRecordImproverFeedback({ area: "went-well", question: "How did it go?", answer: "Went well" });
    await callRecordImproverFeedback({ area: "went-well", question: "How did it go?", answer: "Rough but done" });
    expect(readQueue()).toHaveLength(2);
  });

  it("rejects a call missing area/question/answer", async () => {
    const { callRecordImproverFeedback } = await import(TOOLS);
    await expect(callRecordImproverFeedback({ area: "orchestrator", question: "Q" })).rejects.toThrow(/area, question, answer/);
  });
});
