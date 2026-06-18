import { describe, it, expect } from "vitest";
import path from "node:path";
// @ts-ignore — pure .mjs
import { parseTranscriptLine, scanSkillTelemetry, telemetryToJSON } from "../fittings/seed/improver/lib/skill-telemetry.mjs";

const FIXTURES = path.join(__dirname, "fixtures", "improver");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

describe("skill-telemetry: single-line parser (MR5c — telemetry-parse)", () => {
  it("extracts a Skill tool_use with sessionId + timestamp + args", () => {
    const line = JSON.stringify({
      type: "assistant",
      sessionId: S1,
      timestamp: "2026-06-17T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "foo", args: "bar" } }] },
    });
    const parsed = parseTranscriptLine(line);
    expect(parsed?.uses).toHaveLength(1);
    expect(parsed.uses[0]).toMatchObject({ skill: "foo", sessionId: S1, toolUseId: "t1", argsExcerpt: "bar" });
  });

  it("captures an is_error tool_result back-reference", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: "t1", content: "boom" }] },
    });
    const parsed = parseTranscriptLine(line);
    expect(parsed?.results).toEqual([{ toolUseId: "t1" }]);
  });

  it("returns null for irrelevant or malformed lines (never throws)", () => {
    expect(parseTranscriptLine("{not json")).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: "user" }))).toBeNull();
  });
});

describe("skill-telemetry: scan (MR5c — telemetry-scan)", () => {
  it("accumulates per-skill usage from the fixture transcripts", () => {
    const tel = scanSkillTelemetry({ projectsDir: path.join(FIXTURES, "projects"), now: "2026-06-17T12:00:00Z" });
    expect(tel.bySkill["garrison-helper"]).toBeTruthy();
    expect(tel.bySkill["garrison-helper"].useCount).toBe(1);
    expect(tel.bySkill["garrison-helper"].sessionIds.has(S1)).toBe(true);
    expect(tel.bySkill["garrison-helper"].lastCitation.error).toBe(true); // adjacent is_error
    expect(tel.bySkill["legacy-helper"].sessionIds.has(S2)).toBe(true);
    expect(tel.bySkill["legacy-helper"].lastUsedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("surfaces scan stats and serializes Sets to arrays", () => {
    const tel = scanSkillTelemetry({ projectsDir: path.join(FIXTURES, "projects") });
    expect(tel.scanned.files).toBeGreaterThanOrEqual(2);
    const json = telemetryToJSON(tel);
    expect(Array.isArray(json.bySkill["garrison-helper"].sessionIds)).toBe(true);
    expect(json.bySkill["garrison-helper"].sessionIds).toContain(S1);
  });

  it("a missing projects dir yields an empty, non-throwing result", () => {
    const tel = scanSkillTelemetry({ projectsDir: path.join(FIXTURES, "does-not-exist") });
    expect(tel.bySkill).toEqual({});
    expect(tel.scanned.files).toBe(0);
  });
});
