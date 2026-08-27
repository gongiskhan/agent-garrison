// L1 summary.md: structural parse/render round-trip, the one-page cap that
// REFUSES (never truncates silently), trimSummary keeping the floor whole,
// and the current-stretch write guard.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation, parseSummary, renderSummary, parseEscalationFloor, SUMMARY_MAX_BYTES, SUMMARY_MAX_LINES } from "../packages/claude-pty/src/conversation-store.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "convsum-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const sample = {
  title: "Fix the widget",
  objective: "Make the widget spin.",
  currentState: "Implement done; review pending.",
  decisions: ["Spin clockwise", "No jQuery"],
  activeConstraints: ["no new branches", "summary stays one page"],
  escalationFloor: {
    implement: { duty: "implement", rung: "middle", raisedAt: "2026-08-26T10:00:00Z", reason: "2 consecutive test-fail loops" },
    review: { duty: "review", rung: "cross", raisedAt: null, reason: null },
  },
};

describe("summary.md", () => {
  it("parse/render round-trips all five sections including the floor", () => {
    const text = renderSummary(sample);
    const parsed = parseSummary(text);
    expect(parsed.title).toBe("Fix the widget");
    expect(parsed.objective).toBe("Make the widget spin.");
    expect(parsed.currentState).toBe("Implement done; review pending.");
    expect(parsed.decisions).toEqual(sample.decisions);
    expect(parsed.activeConstraints).toEqual(sample.activeConstraints);
    expect(parsed.escalationFloor.implement).toMatchObject({ rung: "middle", reason: "2 consecutive test-fail loops" });
    expect(parsed.escalationFloor.review).toMatchObject({ rung: "cross", raisedAt: null });
    expect(parseEscalationFloor(text).implement.rung).toBe("middle");
  });

  it("writeSummary refuses over-cap by bytes AND by lines", () => {
    const store = openConversation("s1", { role: "gateway", env });
    const fatBytes = { ...sample, objective: "x".repeat(SUMMARY_MAX_BYTES) };
    expect(store.writeSummary(fatBytes)).toMatchObject({ ok: false, reason: "over-cap" });
    const fatLines = { ...sample, decisions: Array.from({ length: SUMMARY_MAX_LINES + 1 }, (_, i) => `d${i}`) };
    expect(store.writeSummary(fatLines)).toMatchObject({ ok: false, reason: "over-cap" });
    expect(store.writeSummary(sample).ok).toBe(true);
    expect(store.readSummary()).toContain("## Escalation floor");
  });

  it("write guard: only the current stretch may write while one is open", () => {
    const store = openConversation("s2", { role: "gateway", env });
    expect(store.writeSummary(sample).ok).toBe(true); // no stretch open: allowed (init/seed path)
    store.claimStretch("st-1");
    expect(store.writeSummary(sample, { stretchId: "st-2" })).toMatchObject({ ok: false, reason: "not-current-stretch" });
    expect(store.writeSummary(sample, { stretchId: "st-1" }).ok).toBe(true);
    store.releaseStretch("st-1");
    expect(store.writeSummary(sample).ok).toBe(true);
  });

  it("trimSummary keeps objective, current state and the WHOLE floor; drops oldest items; records the trim", () => {
    const store = openConversation("s3", { role: "gateway", env });
    const fat = {
      ...sample,
      decisions: Array.from({ length: 60 }, (_, i) => `decision number ${i} with some length to it`),
      activeConstraints: Array.from({ length: 40 }, (_, i) => `constraint ${i}`),
    };
    expect(store.writeSummary(fat).ok).toBe(false);
    const res = store.trimSummary(fat);
    expect(res.ok).toBe(true);
    const parsed = store.parseSummary();
    expect(parsed.objective).toBe(sample.objective);
    expect(parsed.currentState).toBe(sample.currentState);
    expect(Object.keys(parsed.escalationFloor)).toEqual(["implement", "review"]); // floor whole
    expect(parsed.decisions.length).toBeLessThan(60);
    // newest survive, oldest dropped
    expect(parsed.decisions[parsed.decisions.length - 1]).toContain("decision number 59");
    const [trimEvt] = store.tail(1, { kinds: ["summary-trimmed"] });
    expect(trimEvt.payload.dropped.length).toBeGreaterThan(0);
    expect(store.readPayload(trimEvt.payload.preTrimRef)).toHaveProperty("preTrimSummary");
  });
});
