#!/usr/bin/env node
// probe-chat.mjs — a BARE chat turn (no tool) through agent-sdk + ollama-local.
// This is the path the orchestrator demo needs (send a message → get a response),
// distinct from the tool round trip that the local models can't complete. Lean
// promptMode avoids the ~14k claude_code preset floor. Env-gated; not in the suite.
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { AgentSdkAdapter } from "../lib/agent-sdk-adapter.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "as-chat-"));
const model = process.env.PROBE_MODEL || "qwen3:0.6b";
const promptMode = process.env.PROBE_PROMPT_MODE || "lean";
const question = process.env.PROBE_Q || "In one short sentence, what is the capital of France?";
const adapter = new AgentSdkAdapter({ readSettings: () => null });

async function run() {
  const s = await adapter.spawn({
    provider: "ollama-local",
    model,
    promptMode,
    compositionDir: dir,
    maxTurns: 2,
    settingsJson: null,
    permissionMode: "bypassPermissions"
    // lean promptMode auto-disables tools (harness.disallowedTools) → pure chat
  });
  console.log(`[chat] fence=${s.fence.state} preset=${s.harness.preset} baseUrl=${s.baseUrl} model=${model} promptMode=${promptMode}`);
  await adapter.awaitReady(s);
  const t0 = Date.now();
  await adapter.sendTurn(s, question);
  const r = await adapter.awaitResponse(s);
  await adapter.teardown(s);
  console.log(`[chat] took=${((Date.now() - t0) / 1000).toFixed(1)}s tokens=${s.usedTokens} stopped=${r.stoppedReason}`);
  console.log(`[chat] text=${JSON.stringify(String(r.text || "").slice(0, 300))}`);
  console.log(/paris/i.test(r.text || "") ? `SDK-CHAT-OK model=${model}` : `SDK-CHAT-WEAK model=${model} (no 'Paris')`);
}
run().catch((e) => {
  console.error("[chat] ERROR:", e?.stack || e?.message || e);
  process.exit(3);
});
