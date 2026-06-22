#!/usr/bin/env node
// probe-ollama.mjs — the LIVE agent-sdk + ollama-local tool-call round trip
// (BRIEF acceptance: sdk-ollama-live-ok). Uses the REAL Agent SDK (default client
// factory → lib/sdk-client.mjs), THE FENCE (non-Anthropic base URL), and THE
// HARNESS (full claude_code preset), drives ONE turn that must include a real
// tool-call round trip (Read), and reads the SDK's STRUCTURED messages — no
// scraping. Free + local; env-gated so it never runs in the normal suite.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { AgentSdkAdapter } from "../lib/agent-sdk-adapter.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "agent-sdk-probe-"));
const FIRST_LINE = "GARRISON_PROBE_LINE_42";
writeFileSync(path.join(dir, "probe.txt"), `${FIRST_LINE}\nsecond line\nthird line\n`, "utf8");

const model = process.env.PROBE_MODEL || "qwen3:8b";
const promptMode = process.env.PROBE_PROMPT_MODE || "full";
const adapter = new AgentSdkAdapter({ readSettings: () => null });

async function run() {
  const session = await adapter.spawn({
    provider: "ollama-local",
    model,
    promptMode,
    compositionDir: dir,
    maxTurns: 6,
    settingsJson: null,
    allowedTools: ["Read"],
    permissionMode: "bypassPermissions"
  });
  console.log(
    `[probe] fence=${session.fence.state} | baseUrl=${session.baseUrl} | preset=${session.harness.preset} | settingSources=${JSON.stringify(
      session.harness.settingSources
    )} | caps.mcp=${session.capabilities.mcp}`
  );
  await adapter.awaitReady(session);
  const prompt = `Use the Read tool to read the file "probe.txt" in your current working directory, then reply with ONLY its exact first line.`;
  await adapter.sendTurn(session, prompt);
  const resp = await adapter.awaitResponse(session);
  await adapter.teardown(session);

  const toolNames = (resp.toolUses || []).map((t) => t.name);
  console.log(`[probe] toolUses=${JSON.stringify(toolNames)} stoppedReason=${resp.stoppedReason} tokens=${session.usedTokens}`);
  console.log(`[probe] text=${JSON.stringify(String(resp.text || "").slice(0, 400))}`);

  const toolRoundTrip = toolNames.includes("Read");
  const sawLine = String(resp.text || "").includes(FIRST_LINE);
  if (toolRoundTrip && sawLine) {
    console.log(`SDK-OLLAMA-LIVE-OK model=${model} toolRoundTrip=Read sawFirstLine=true`);
  } else {
    console.log(`SDK-OLLAMA-LIVE-PARTIAL model=${model} toolRoundTrip=${toolRoundTrip} sawFirstLine=${sawLine}`);
    process.exitCode = 4;
  }
}
run().catch((e) => {
  console.error("[probe] ERROR:", e?.stack || e?.message || e);
  process.exit(3);
});
