#!/usr/bin/env node
// Spike A — claude --resume <id> --model <other> preserves context across model swap
// Spike D — --append-system-prompt identity persists across multiple stream-JSON turns
//
// Run: node scripts/spike/phase9/a-d-resume-identity.mjs

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const COMMON = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--permission-mode", "bypassPermissions"
];

function spawnClaude(args) {
  return spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
}

function userMsg(content) {
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

async function runTurn(child, content, label) {
  child.stdin.write(userMsg(content));
  let buf = "";
  let assistantText = "";
  let model = null;
  for await (const chunk of child.stdout) {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "system" && ev.subtype === "init") {
        model = ev.model;
        console.log(`[${label}] init: session_id=${ev.session_id} model=${ev.model}`);
      } else if (ev.type === "assistant") {
        for (const block of (ev.message?.content ?? [])) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (ev.type === "result") {
        console.log(`[${label}] result text=${JSON.stringify(assistantText.trim())} model=${model}`);
        return { text: assistantText.trim(), model, sessionId: ev.session_id };
      }
    }
  }
  throw new Error(`[${label}] stdout closed before result`);
}

// =============================================================
// Spike A — resume with different model preserves context
// =============================================================
console.log("\n=== SPIKE A: --resume <id> --model <other> preserves context ===");
const uuidA = randomUUID();
console.log(`uuid=${uuidA}`);

const a1 = spawnClaude([...COMMON, "--session-id", uuidA, "--model", "claude-haiku-4-5"]);
a1.stderr.on("data", d => process.stderr.write(`[a1/err] ${d}`));
await runTurn(a1, "Remember: my secret codeword is BLUEBERRY. Acknowledge with the single word 'ok'.", "a1");
a1.stdin.end();
await new Promise(r => a1.on("exit", r));

const a2 = spawnClaude([...COMMON, "--resume", uuidA, "--model", "claude-opus-4-7"]);
a2.stderr.on("data", d => process.stderr.write(`[a2/err] ${d}`));
const a2r = await runTurn(a2, "What is my secret codeword? One word.", "a2");
a2.stdin.end();
await new Promise(r => a2.on("exit", r));

const recalled = a2r.text.toLowerCase().includes("blueberry");
console.log(`SPIKE A RESULT: recall=${recalled ? "YES" : "NO"} model_on_resume=${a2r.model}`);

// =============================================================
// Spike D — identity persists across multiple stream-JSON turns
// =============================================================
console.log("\n=== SPIKE D: --append-system-prompt identity persists across 3 turns ===");
const uuidD = randomUUID();
const c = spawnClaude([
  ...COMMON,
  "--session-id", uuidD,
  "--model", "claude-haiku-4-5",
  "--append-system-prompt",
  "You are Verity. ALWAYS begin every reply with the literal prefix 'Verity: ' — no exceptions."
]);
c.stderr.on("data", d => process.stderr.write(`[d/err] ${d}`));
const d1 = await runTurn(c, "Hi.", "d1");
const d2 = await runTurn(c, "Tell me your name.", "d2");
const d3 = await runTurn(c, "One more time — what name should I call you?", "d3");
c.stdin.end();
await new Promise(r => c.on("exit", r));

const allPersisted = [d1, d2, d3].every(r => r.text.startsWith("Verity:"));
const t3Persisted = d3.text.startsWith("Verity:");
console.log(`SPIKE D RESULT: turn1=${d1.text.startsWith("Verity:")?"YES":"NO"} turn2=${d2.text.startsWith("Verity:")?"YES":"NO"} turn3=${t3Persisted?"YES":"NO"} all_persisted=${allPersisted?"YES":"NO"}`);

process.exit(0);
