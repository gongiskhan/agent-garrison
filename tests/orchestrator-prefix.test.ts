import { describe, expect, it } from "vitest";
import path from "node:path";

const LIB = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");

describe("Phase 9I L1 — orchestrator-prefix / buildOrchestratorTurn", () => {
  it("starts with the literal [origin: X, channel: Y] header", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const turn = mod.buildOrchestratorTurn({
      origin: "ui-tab",
      channel: "main",
      message: "fix the regex bug"
    });
    expect(turn.startsWith("[origin: ui-tab, channel: main]")).toBe(true);
    expect(turn).toContain("fix the regex bug");
  });

  it("uses channel-origin default values when origin/channel are omitted", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const turn = mod.buildOrchestratorTurn({ message: "hello" });
    expect(turn).toContain("[origin: channel, channel: main]");
  });

  it("does not include a summaries block when pendingSummaries is empty", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const turn = mod.buildOrchestratorTurn({
      origin: "channel",
      channel: "main",
      message: "hi"
    });
    expect(turn).not.toContain("Recent sub-session summaries");
  });

  it("prepends a single summaries block when pending summaries exist", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const turn = mod.buildOrchestratorTurn({
      origin: "channel",
      channel: "main",
      message: "next?",
      pendingSummaries: [
        { soul: "engineer", sessionId: "abcd1234-aaaa", summary: "fixed LoginForm regex; tests green" },
        { soul: "researcher", sessionId: "bbbb5678-bbbb", summary: "Anthropic's policy update is mostly cosmetic" }
      ]
    });
    expect(turn).toContain("Recent sub-session summaries");
    expect(turn).toContain("engineer/abcd1234");
    expect(turn).toContain("researcher/bbbb5678");
    expect(turn).toContain("LoginForm regex");
  });

  it("annotates the resolved mode in the header when provided (s1d)", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const turn = mod.buildOrchestratorTurn({
      origin: "channel",
      channel: "dev-env",
      mode: "joe",
      message: "ship it"
    });
    expect(turn.startsWith("[origin: channel, channel: dev-env, mode: joe]")).toBe(true);
  });

  it("omits the mode segment when no mode is resolved (back-compat)", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const turn = mod.buildOrchestratorTurn({ origin: "channel", channel: "main", message: "hi" });
    expect(turn).toContain("[origin: channel, channel: main]");
    expect(turn).not.toContain(", mode:");
  });

  it("truncates very long summaries to keep the prefix bounded", async () => {
    const mod = await import(path.join(LIB, "orchestrator-prefix.mjs"));
    const longSummary = "x".repeat(600);
    const turn = mod.buildOrchestratorTurn({
      origin: "channel",
      channel: "main",
      message: "tick",
      pendingSummaries: [{ soul: "engineer", sessionId: "abcd1234", summary: longSummary }]
    });
    // 400-char truncation per summary, with an ellipsis appended.
    expect(turn).toContain("…");
    const summarySection = turn.split("\n\n")[1];
    // The truncation cap is ~400 chars; allow generous slack for the header.
    expect(summarySection.length).toBeLessThan(600);
  });
});
