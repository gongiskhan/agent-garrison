import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs (internal telemetry module)
import { promptDigest, decisionRecord, formatRouteToken, parseRouteToken, checkHonored, appendDecision, readDecisions } from "../fittings/seed/orchestrator/lib/routing-telemetry.mjs";

const route = { profile: "balanced", role: "expert", ruleId: "cell:code/T2-deep", via: "cell", targetId: "cc-opus-high", target: {} };
const classification = { taskType: "code", tier: "T2-deep", matchedException: null };

describe("route telemetry (MR1e)", () => {
  it("promptDigest is stable + truncated", () => {
    const d = promptDigest("fix the login bug");
    expect(d).toBe(promptDigest("fix the login bug"));
    expect(d).toHaveLength(16);
    expect(d).not.toBe(promptDigest("different prompt"));
  });

  it("decisionRecord captures the resolution at decision time", () => {
    const rec = decisionRecord({ prompt: "fix the login bug", classification, route, at: "2026-06-14T00:00:00Z" });
    expect(rec).toMatchObject({
      taskType: "code",
      tier: "T2-deep",
      role: "expert",
      ruleId: "cell:code/T2-deep",
      targetId: "cc-opus-high",
      profile: "balanced",
      at: "2026-06-14T00:00:00Z"
    });
    expect(rec.promptDigest).toHaveLength(16);
  });

  it("formatRouteToken matches the compiled reply-duty format", () => {
    expect(formatRouteToken(route)).toBe("[route: cc-opus-high | rule: cell:code/T2-deep | profile: balanced]");
  });

  it("parseRouteToken extracts the LAST token from a reply", () => {
    const reply = "Here is the fix.\n\n[route: cc-opus-high | rule: cell:code/T2-deep | profile: balanced]\n[orchestrator-active]";
    expect(parseRouteToken(reply)).toEqual({ targetId: "cc-opus-high", ruleId: "cell:code/T2-deep", profile: "balanced" });
  });

  it("parseRouteToken returns null when no token is present", () => {
    expect(parseRouteToken("no token here")).toBeNull();
  });

  it("checkHonored = true when the token matches the resolved route", () => {
    const reply = `done\n${formatRouteToken(route)}\n[orchestrator-active]`;
    const v = checkHonored(route, reply);
    expect(v.honored).toBe(true);
  });

  it("checkHonored = false (misroute signal) on a target mismatch", () => {
    const reply = "done\n[route: cc-haiku-low | rule: cell:code/T2-deep | profile: balanced]";
    const v = checkHonored(route, reply);
    expect(v.honored).toBe(false);
    expect(v.reason).toContain("mismatch");
    expect(v.expected.targetId).toBe("cc-opus-high");
    expect(v.actual.targetId).toBe("cc-haiku-low");
  });

  it("checkHonored = false when the reply has no token at all", () => {
    expect(checkHonored(route, "I forgot the token").honored).toBe(false);
  });

  it("appendDecision + readDecisions round-trip JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-decisions-"));
    const file = join(dir, "decisions.jsonl");
    await appendDecision(file, decisionRecord({ prompt: "a", classification, route, at: "2026-06-14T00:00:00Z" }));
    await appendDecision(file, decisionRecord({ prompt: "b", classification, route, at: "2026-06-14T00:01:00Z" }));
    const recs = await readDecisions(file);
    expect(recs).toHaveLength(2);
    expect(recs[0].targetId).toBe("cc-opus-high");
    expect(recs[1].promptDigest).not.toBe(recs[0].promptDigest);
  });

  it("readDecisions tolerates a missing file + a corrupt line", async () => {
    expect(await readDecisions("/nonexistent/decisions.jsonl")).toEqual([]);
  });
});
