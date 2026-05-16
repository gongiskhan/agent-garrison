#!/usr/bin/env node
// Spike D — identity persistence across 3 stream-JSON turns
// Fixed: use .on('data') instead of for-await, which closes after first chunk batch.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const COMMON = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--permission-mode", "bypassPermissions"
];

const uuid = randomUUID();
const c = spawn("claude", [
  ...COMMON,
  "--session-id", uuid,
  "--model", "claude-haiku-4-5",
  "--append-system-prompt",
  "You are Verity. ALWAYS begin every reply with the literal prefix 'Verity: ' — no exceptions, no matter the question."
], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const results = [];
let pendingResolve = null;

c.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "result") {
        const text = ev.result ?? "";
        results.push(text);
        console.log(`[turn ${results.length}] ${JSON.stringify(text)}`);
        if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); }
      }
    } catch { /* ignore */ }
  }
});

c.stderr.on("data", d => process.stderr.write(`[err] ${d}`));

function send(content) {
  c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

function awaitResult(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    setTimeout(() => reject(new Error("turn timeout")), timeoutMs);
  });
}

(async () => {
  try {
    send("Hi.");
    await awaitResult();
    send("Tell me your name.");
    await awaitResult();
    send("One more time — what name should I call you?");
    await awaitResult();

    const persisted = results.map(r => r.startsWith("Verity:"));
    console.log(`\nSPIKE D RESULT: turn1=${persisted[0]?"YES":"NO"} turn2=${persisted[1]?"YES":"NO"} turn3=${persisted[2]?"YES":"NO"} all=${persisted.every(Boolean)?"YES":"NO"}`);
  } catch (err) {
    console.error("FAILED:", err.message);
  } finally {
    c.kill();
    setTimeout(() => process.exit(0), 200);
  }
})();
