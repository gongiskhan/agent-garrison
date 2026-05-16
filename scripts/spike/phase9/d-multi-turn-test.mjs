#!/usr/bin/env node
// Test: does claude --print --input-format stream-json stay alive for multiple turns
// when we feed multiple user messages on stdin without closing stdin?

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
const c = spawn("claude", [...COMMON, "--session-id", uuid, "--model", "claude-haiku-4-5"], {
  stdio: ["pipe", "pipe", "pipe"]
});

let buf = "";
let resultCount = 0;
let exited = false;

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
        resultCount += 1;
        console.log(`[result #${resultCount}] subtype=${ev.subtype} text=${JSON.stringify(ev.result ?? "<n/a>")}`);
      } else if (ev.type === "system" && ev.subtype === "init") {
        console.log(`[init] session=${ev.session_id} model=${ev.model}`);
      } else if (ev.type === "assistant") {
        for (const block of (ev.message?.content ?? [])) {
          if (block.type === "text") console.log(`[assistant text] ${JSON.stringify(block.text)}`);
        }
      } else {
        console.log(`[other] type=${ev.type} subtype=${ev.subtype ?? "-"}`);
      }
    } catch {
      console.log(`[non-json] ${line}`);
    }
  }
});

c.stderr.on("data", d => process.stderr.write(`[err] ${d}`));
c.on("exit", (code, signal) => {
  exited = true;
  console.log(`\nEXIT code=${code} signal=${signal} after ${resultCount} result(s)`);
  process.exit(0);
});

function send(content) {
  c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

// Send turn 1 immediately
send("Hi.");

// Send turn 2 after 5 seconds (gives turn 1 plenty of time to complete)
setTimeout(() => {
  if (exited) return;
  console.log("\n--- sending turn 2 ---");
  send("Tell me your name.");
}, 5000);

// Send turn 3 after 10 seconds
setTimeout(() => {
  if (exited) return;
  console.log("\n--- sending turn 3 ---");
  send("Counting to three: one, two, three. Now reply with the number after two.");
}, 10000);

// Force exit after 25s if process still alive
setTimeout(() => {
  if (!exited) {
    console.log("\n--- forcing exit after 25s ---");
    c.kill();
  }
}, 25000);
