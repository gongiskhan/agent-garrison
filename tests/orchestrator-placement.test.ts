import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { placeOrchestratedSession, safeComposition } from "@/lib/orchestrator-placement";

describe("Orchestrator session placement", () => {
  it("uses the authoritative assembled prompt and no persona model bias", async () => {
    const decisionsPath = path.join(mkdtempSync(path.join(tmpdir(), "placement-")), "decisions.jsonl");
    const result = await placeOrchestratedSession({
      composition: "default",
      channel: "dev-env",
      decisionsPath
    });
    expect(result.identity).toBe("operative");
    expect(result.model).toBeNull();
    expect(result.targetId).toBeNull();
    expect(existsSync(result.promptPath)).toBe(true);
    const prompt = readFileSync(result.promptPath, "utf8");
    expect(prompt.match(/\bZeca\b/g) ?? []).toHaveLength(1);
    expect(prompt).not.toMatch(/\b(?:Verity|Joe|James)\b/);
    expect(JSON.parse(readFileSync(decisionsPath, "utf8").trim())).toMatchObject({
      kind: "session-placement",
      via: "orchestrator-authored-prompt",
      channel: "dev-env"
    });
  });

  it("confines composition ids", () => {
    expect(safeComposition("dogfood-dev")).toBe("dogfood-dev");
    expect(safeComposition("../../etc")).toBe("default");
  });
});
