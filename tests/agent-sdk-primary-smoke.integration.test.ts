import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

// S2a2 — the COMMITTED, gated live smoke proving a NON-Claude primary boots and
// serves sessions cleanly end-to-end through the RuntimeAdapter interface:
//   1. boot the RoutedGateway with an agent-sdk primary over the free local
//      ollama-local provider (no Anthropic billing),
//   2. serve ONE real turn on the operative's own adapter (ollama answers),
//   3. applySwitch to a different model/effort on the same agent-sdk runtime and
//      assert the switch took the ADAPTER-MOVES path (S2a change 1) — never the
//      historical route-switch-skipped.
// It also exercises the S2a classifier fallback (change 3) live by forcing
// claude-code unresolvable, so the whole gateway runs on the agent-sdk/ollama
// path. Gated like the other live suites: GARRISON_INTEGRATION=1 + a real ollama
// daemon at 127.0.0.1:11434 with the model.
const LIVE = process.env.GARRISON_INTEGRATION === "1";
const OLLAMA_MODEL = process.env.GARRISON_OLLAMA_MODEL ?? "qwen2.5:3b";

describe.skipIf(!LIVE)("agent-sdk primary over ollama serves a turn + adapter-moves switch (S2a2 live smoke)", () => {
  it("boots agent-sdk/ollama primary, serves one real turn, then switches model/effort via adapter-moves", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a2-"));
    const events: any[] = [];
    const gw: any = await createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      operativeSpawnConfig: {
        compositionDir: tmp,
        provider: "ollama-local",
        model: OLLAMA_MODEL,
        promptMode: "lean", // pure chat: fast + robust on a small local model
      },
      initialTarget: { provider: "ollama-local", model: OLLAMA_MODEL, effort: null },
      // Force the classifier off claude-code too, so the whole gateway runs on the
      // agent-sdk/ollama path (exercises the S2a classifier fallback live).
      claudeCodeResolvable: false,
      logFn: (e: any) => events.push(e),
    });
    try {
      await gw.start();

      // the classifier fell back to the primary adapter (claude-code forced absent)
      const fallback = events.find((e) => e.kind === "classifier-fallback");
      expect(fallback).toMatchObject({ from: "claude-code", to: "agent-sdk" });

      // the operative runs on the agent-sdk adapter, a non-PTY session (no writeKeys)
      const adapter = gw.operativeAdapter();
      expect(adapter.id).toBe("agent-sdk");
      const session = gw.getOperativeSession();
      expect(typeof session.writeKeys).not.toBe("function");

      // 1) serve ONE real turn through the operative's own adapter → ollama answers
      await adapter.sendTurn(session, "Reply with the single word: pong.");
      const resp = await adapter.awaitResponse(session);
      expect(resp && typeof resp.text === "string").toBe(true);
      expect(resp.text.trim().length).toBeGreaterThan(0);

      // 2) switch to a DIFFERENT model + effort on the same agent-sdk runtime.
      //    setModel/setEffort are local state moves (no ollama round-trip); a
      //    non-PTY primary MUST take the adapter-moves path, never the old skip.
      gw.injectSettleMs = 1;
      const switchTarget = { runtime: "agent-sdk", provider: "ollama-local", model: "qwen2.5:1.5b", effort: "high" };
      const plan = await gw.applySwitch({ targetId: "ollama-switch", target: switchTarget });
      expect(plan.path).toBe("slash-inject"); // planSwitch classified the model+effort change

      const moves = gw.switchLog.filter((s: any) => s.path === "adapter-moves");
      expect(moves.length).toBeGreaterThanOrEqual(1);
      const adapterMoveLog = events.find((e) => e.kind === "route-switch" && e.path === "adapter-moves");
      expect(adapterMoveLog).toBeTruthy();
      expect(adapterMoveLog.runtime).toBe("agent-sdk");
      // the historical hard-skip did NOT fire
      expect(events.some((e) => e.kind === "route-switch-skipped")).toBe(false);
      // the adapter actually recorded the move on the live session
      expect(session.model).toBe("qwen2.5:1.5b");
      expect(session.effort).toBe("high");
      expect(gw.currentTarget.model).toBe("qwen2.5:1.5b");

      // surface the real evidence for the run report
      console.log("[S2a2] classifier-fallback:", JSON.stringify(fallback));
      console.log("[S2a2] ollama reply:", JSON.stringify(resp.text.trim().slice(0, 200)));
      console.log("[S2a2] adapter-moves log:", JSON.stringify(adapterMoveLog));
    } finally {
      gw.shutdown();
    }
  }, 90000);
});
