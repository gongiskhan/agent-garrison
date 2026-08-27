// GARRISON-FLOW-V2 S8 (D26/E13) — the garrison-control record_improver_feedback
// tool: the Improver-Probe capture FALLBACK for surfaces without a PostToolUse
// hook. It records one D26 record into the shared feedback queue — the state
// service's `feedback_queue` since mesh phase 2 (§4.5).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startStateService } from "./state-service-harness";

const ROOT = path.resolve(__dirname, "..");
const TOOLS = pathToFileURL(path.join(ROOT, "fittings/seed/mcp-gateway/scripts/lib/tools.mjs")).href;

let home: string;
let h: Awaited<ReturnType<typeof startStateService>>;
const savedState = { url: process.env.GARRISON_STATE_URL, token: process.env.GARRISON_STATE_TOKEN };

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "gw-fb-"));
  process.env.GARRISON_HOME = home;
  h = await startStateService();
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.token;
  const { resetFeedbackClient } = await import(TOOLS);
  resetFeedbackClient();
});
afterEach(async () => {
  await h?.stop();
  const { resetFeedbackClient } = await import(TOOLS);
  resetFeedbackClient();
  delete process.env.GARRISON_HOME;
  if (savedState.url === undefined) delete process.env.GARRISON_STATE_URL;
  else process.env.GARRISON_STATE_URL = savedState.url;
  if (savedState.token === undefined) delete process.env.GARRISON_STATE_TOKEN;
  else process.env.GARRISON_STATE_TOKEN = savedState.token;
  rmSync(home, { recursive: true, force: true });
});

async function readQueue(): Promise<any[]> {
  const rows = await h.client.listFeedback({ limit: 100 });
  return rows.map((r: { payload: unknown }) => r.payload);
}

describe("callRecordImproverFeedback", () => {
  it("records a D26 probe record (provenance probe) into the shared feedback queue", async () => {
    const { callRecordImproverFeedback } = await import(TOOLS);
    const res = await callRecordImproverFeedback({ session_id: "s1", area: "orchestrator", question: "Was that right?", answer: "Right call" });
    expect(res.recorded).toBe(true);
    // The row's id is the record's own minted id — the handle the Signals view
    // needs to delete it. This writer stamped none while the queue was a file.
    expect(String(res.id)).toMatch(/^fq-[0-9a-z]{9}-[0-9a-f]{8}$/);
    const recs = await readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: res.id,
      session_id: "s1",
      area: "orchestrator",
      question: "Was that right?",
      answer: "Right call",
      provenance: "probe",
    });
    expect(recs[0]).toHaveProperty("timestamp");
    expect(recs[0].classification).toEqual({ kind: null, tier: null, plan: null });
    // No local fallback file: the pre-mesh path stays empty.
    expect(existsSync(path.join(home, "improver", "feedback-queue.jsonl"))).toBe(false);
  });

  it("records one row per call", async () => {
    const { callRecordImproverFeedback } = await import(TOOLS);
    await callRecordImproverFeedback({ area: "went-well", question: "How did it go?", answer: "Went well" });
    await callRecordImproverFeedback({ area: "went-well", question: "How did it go?", answer: "Rough but done" });
    expect(await readQueue()).toHaveLength(2);
  });

  it("rejects a call missing area/question/answer", async () => {
    const { callRecordImproverFeedback } = await import(TOOLS);
    await expect(callRecordImproverFeedback({ area: "orchestrator", question: "Q" })).rejects.toThrow(/area, question, answer/);
  });
});
