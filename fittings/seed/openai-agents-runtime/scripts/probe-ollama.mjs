#!/usr/bin/env node
// probe-ollama.mjs - the LIVE openai-agents + ollama-local tool-call round trip.
// Uses the REAL @openai/agents SDK (default runner factory → lib/openai-client.mjs)
// and the `full` harness (file tools enabled), drives ONE turn that must include a
// real tool-call round trip (read_file), and reads the SDK's STRUCTURED result -
// no scraping. Free + local; run on demand.
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { OpenAiAgentsAdapter } from "../lib/openai-adapter.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "openai-agents-probe-"));
// A distinctive numeric marker: small local models reproduce a digit string more
// faithfully than a long underscore token, so the round-trip proof stays robust
// without depending on perfect verbatim fidelity.
const MARKER = "517342";
writeFileSync(path.join(dir, "probe.txt"), `garrison probe marker ${MARKER}\nsecond line\nthird line\n`, "utf8");

const model = process.env.PROBE_MODEL || "qwen2.5:3b";
const promptMode = process.env.PROBE_PROMPT_MODE || "full";
const adapter = new OpenAiAgentsAdapter();

async function run() {
  const session = await adapter.spawn({
    provider: "ollama-local",
    model,
    promptMode,
    compositionDir: dir,
    maxTurns: 6,
    permissionMode: "bypassPermissions"
  });
  console.log(
    `[probe] baseUrl=${session.baseUrl} | toolsEnabled=${session.harness.toolsEnabled} | caps.toolUse=${session.capabilities.toolUse}`
  );
  await adapter.awaitReady(session);
  const prompt = `Use the read_file tool to read the file "probe.txt" in your working directory, then reply with the numeric marker it contains.`;
  await adapter.sendTurn(session, prompt);
  const resp = await adapter.awaitResponse(session);
  await adapter.teardown(session);

  const toolNames = (resp.toolUses || []).map((t) => t.name);
  console.log(`[probe] toolUses=${JSON.stringify(toolNames)} stoppedReason=${resp.stoppedReason} tokens=${session.usedTokens}`);
  console.log(`[probe] text=${JSON.stringify(String(resp.text || "").slice(0, 400))}`);

  const toolRoundTrip = toolNames.includes("read_file");
  const sawMarker = String(resp.text || "").includes(MARKER);
  if (toolRoundTrip && sawMarker) {
    console.log(`OPENAI-OLLAMA-LIVE-OK model=${model} toolRoundTrip=read_file sawMarker=true`);
  } else {
    console.log(`OPENAI-OLLAMA-LIVE-PARTIAL model=${model} toolRoundTrip=${toolRoundTrip} sawMarker=${sawMarker}`);
    process.exitCode = 4;
  }
}
run().catch((e) => {
  console.error("[probe] ERROR:", e?.stack || e?.message || e);
  process.exit(3);
});
