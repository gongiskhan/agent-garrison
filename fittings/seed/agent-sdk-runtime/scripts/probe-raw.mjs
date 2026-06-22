#!/usr/bin/env node
// probe-raw.mjs — raw SDK message trace against ollama (diagnostic). Logs every
// streamed SDKMessage with a timestamp so we can see WHERE the turn stalls
// (no messages = CLI not connecting; thinking deltas = model thinking; tool loop;
// result = done). Bypasses the adapter to isolate the SDK behavior.
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createSdkClient } from "../lib/sdk-client.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "as-raw-"));
const model = process.env.PROBE_MODEL || "qwen2.5:7b";
const env = { ...process.env, ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" };
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const options = {
  systemPrompt: "You are a concise assistant. Answer the question directly in one sentence. Do not use any tools.",
  settingSources: [],
  cwd: dir,
  model,
  maxTurns: 1,
  env,
  permissionMode: "bypassPermissions",
  // Pure chat: deny every built-in tool so a small model just answers instead of
  // hallucinating an agentic task (allowedTools:[] reads as "no allow-list").
  disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "BashOutput", "KillBash", "Skill"],
  includePartialMessages: true
};

console.log(`[raw] start model=${model} cwd=${dir}`);
const q = createSdkClient({ prompt: "In one short sentence, what is the capital of France?", options });
try {
  for await (const m of q) {
    const t = m?.type;
    let extra = "";
    if (t === "assistant") extra = JSON.stringify(m.message?.content ?? []).slice(0, 200);
    else if (t === "result") extra = `subtype=${m.subtype} result=${JSON.stringify(m.result ?? "").slice(0, 200)}`;
    else if (t === "system") extra = `subtype=${m.subtype ?? ""} session=${m.session_id ?? ""}`;
    else if (t === "stream_event") extra = `ev=${m.event?.type ?? ""} ${JSON.stringify(m.event?.delta ?? m.event?.content_block ?? "").slice(0, 80)}`;
    else extra = JSON.stringify(m).slice(0, 160);
    console.log(`[raw] ${el()} type=${t} ${extra}`);
  }
  console.log(`[raw] ${el()} DONE`);
} catch (e) {
  console.error(`[raw] ${el()} ERROR ${e?.stack || e?.message || e}`);
  process.exit(3);
}
