#!/usr/bin/env node
// Mock claude CLI for Phase 9I tests. Honors the subset of flags the
// http-gateway's spawn-soul module passes:
//
//   --session-id <uuid>          required for fresh spawn
//   --resume <uuid>              used for tier-respawn / orchestrator-resume
//   --model <name>               captured to confirm tier flags propagate
//   --input-format stream-json
//   --output-format stream-json
//   --print
//   --verbose
//   --append-system-prompt-file <path>
//   --mcp-config <path> --strict-mcp-config
//   --permission-mode bypassPermissions
//   --allowedTools / --disallowedTools
//   --exclude-dynamic-system-prompt-sections
//
// On each `{type:"user",...}` line from stdin, the mock emits:
//   system/init  → captures the session id and model
//   assistant    → echoes back content `MOCK[<model>]: <content>` plus an
//                   optional second text block "ack:<n>" for chunk streaming tests
//   result       → subtype=success, result=<assistant_text>
//
// Special user content prefixes for test scripting:
//   "@@MULTICHUNK"   → splits the reply into 3 assistant events (chunk streaming)
//   "@@TOOLUSE"      → emits a tool_use block before result
//   "@@FAIL"         → emits result with subtype=error_during_execution
//   "@@SLOW <ms>"    → sleeps before emitting result
//   "@@CRASH"        → process.exit(1) before emitting result
//
// Tests can also inspect stderr for the captured argv (we dump it on boot).

import readline from "node:readline";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const sessionId = args["session-id"] || args["resume"] || "mock-sid-0000-0000-0000-0000";
const model = args.model || "mock-haiku";

// Dump argv to stderr so tests can grep it.
process.stderr.write(`[mock-claude] argv=${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write(`[mock-claude] session=${sessionId} model=${model} resume=${Boolean(args.resume)}\n`);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitTurn(content) {
  // Init event opens the turn.
  emit({ type: "system", subtype: "init", session_id: sessionId, model });

  if (content.startsWith("@@CRASH")) {
    process.exit(1);
  }

  if (content.startsWith("@@MULTICHUNK")) {
    for (const part of ["chunk-1", "chunk-2", "chunk-3"]) {
      emit({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `${part} ` }] }
      });
    }
    emit({ type: "result", subtype: "success", session_id: sessionId, result: "chunk-1 chunk-2 chunk-3 " });
    return;
  }

  if (content.startsWith("@@TOOLUSE")) {
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }] }
    });
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: `MOCK[${model}]: did the thing` }] }
    });
    emit({ type: "result", subtype: "success", session_id: sessionId, result: `MOCK[${model}]: did the thing` });
    return;
  }

  if (content.startsWith("@@FAIL")) {
    emit({ type: "result", subtype: "error_during_execution", session_id: sessionId });
    return;
  }

  const slowMatch = content.match(/^@@SLOW\s+(\d+)/);
  if (slowMatch) {
    setTimeout(() => {
      const text = `MOCK[${model}]: woke up after ${slowMatch[1]}ms`;
      emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
      emit({ type: "result", subtype: "success", session_id: sessionId, result: text });
    }, Number(slowMatch[1]));
    return;
  }

  // Default: echo content with model tag.
  const text = `MOCK[${model}]: ${content}`;
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", session_id: sessionId, result: text });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let parsed;
  try { parsed = JSON.parse(line); } catch {
    process.stderr.write(`[mock-claude] non-json stdin: ${line.slice(0, 100)}\n`);
    return;
  }
  if (parsed?.type !== "user") {
    process.stderr.write(`[mock-claude] non-user message: ${parsed?.type}\n`);
    return;
  }
  const content = typeof parsed.message?.content === "string"
    ? parsed.message.content
    : Array.isArray(parsed.message?.content)
      ? parsed.message.content.map((b) => b.text ?? "").join(" ")
      : "";
  emitTurn(content);
});

// Stay alive until stdin closes.
rl.on("close", () => process.exit(0));
