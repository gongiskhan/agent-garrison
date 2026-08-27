#!/usr/bin/env node
// Capture exactly one short, authentic Claude Agent SDK turn for the Web Channel
// parity fixture. The output is deliberately scrubbed: stable aliases replace
// opaque ids and the scratch path, while credential/account/config payloads from
// system init frames are never serialized.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkClient } from "../lib/sdk-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(HERE, "../../../../tests/fixtures/agent-sdk-web-parity-events.json");
const MODEL = "claude-opus-5";
const PROMPT =
  "In the current scratch directory, use Write to create fixture-note.txt containing exactly " +
  "WEB_PARITY_FIXTURE, then use Read to read it. Use exactly those two tool calls in that order. " +
  "Finally reply with only the text you read.";

const idAliases = new Map();
let nextAlias = 1;

function alias(value, prefix = "id") {
  if (typeof value !== "string" || !value) return value ?? null;
  const key = `${prefix}:${value}`;
  if (!idAliases.has(key)) idAliases.set(key, `${prefix}-${nextAlias++}`);
  return idAliases.get(key);
}

function cleanString(value, scratch) {
  return String(value).split(scratch).join("<scratch>");
}

function cleanContent(value, scratch) {
  if (typeof value === "string") return cleanString(value, scratch);
  if (Array.isArray(value)) return value.map((item) => cleanContent(item, scratch));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:token|api_?key|authorization|email|organization|accountInfo|env|config)$/i.test(key)) continue;
    if (key === "session_id") out[key] = alias(item, "session");
    else if (key === "uuid") out[key] = alias(item, "uuid");
    else if (key === "tool_use_id" || key === "toolUseID") out[key] = alias(item, "tool");
    else if (key === "id" && typeof item === "string") {
      const prefix = item.startsWith("toolu_") ? "tool" : item.startsWith("msg_") ? "message" : "id";
      out[key] = alias(item, prefix);
    } else if (key === "timestamp") out[key] = "<timestamp>";
    else out[key] = cleanContent(item, scratch);
  }
  return out;
}

function fixtureMessage(message, scratch) {
  const base = {
    type: message?.type ?? "unknown",
    ...(typeof message?.subtype === "string" ? { subtype: message.subtype } : {}),
    ...(message?.uuid ? { uuid: alias(message.uuid, "uuid") } : {}),
    ...(message?.session_id ? { session_id: alias(message.session_id, "session") } : {}),
  };

  if (message?.type === "stream_event") {
    return {
      ...base,
      parent_tool_use_id: message.parent_tool_use_id ? alias(message.parent_tool_use_id, "tool") : null,
      event: cleanContent(message.event, scratch),
    };
  }
  if (message?.type === "assistant") {
    return {
      ...base,
      parent_tool_use_id: message.parent_tool_use_id ? alias(message.parent_tool_use_id, "tool") : null,
      ...(message.error ? { error: message.error } : {}),
      message: cleanContent(message.message, scratch),
    };
  }
  if (message?.type === "user") {
    return {
      ...base,
      parent_tool_use_id: message.parent_tool_use_id ? alias(message.parent_tool_use_id, "tool") : null,
      ...(message.isSynthetic === true ? { isSynthetic: true } : {}),
      ...(message.priority ? { priority: message.priority } : {}),
      message: cleanContent(message.message, scratch),
    };
  }
  if (message?.type === "result") {
    return cleanContent({
      ...base,
      is_error: message.is_error,
      result: message.result,
      stop_reason: message.stop_reason,
      errors: message.errors,
      permission_denials: message.permission_denials,
    }, scratch);
  }
  if (message?.type === "tool_progress" || message?.type === "rate_limit_event") {
    return cleanContent(message, scratch);
  }
  if (message?.type === "system") {
    // Keep event-bearing system fields only. In particular, SDK init carries
    // account/config material that has no place in a committed fixture.
    const safe = { ...base };
    for (const key of [
      "state", "attempt", "max_retries", "retry_delay_ms", "error_status", "error",
      "estimated_tokens", "estimated_tokens_delta", "permission_mode", "model"
    ]) {
      if (message[key] !== undefined) safe[key] = cleanContent(message[key], scratch);
    }
    if (message.subtype === "init") {
      safe.tools = Array.isArray(message.tools) ? [...message.tools] : [];
      safe.mcp_servers = Array.isArray(message.mcp_servers)
        ? message.mcp_servers.map((server) => ({ name: String(server?.name ?? ""), status: String(server?.status ?? "") }))
        : [];
    }
    return safe;
  }
  return base;
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-web-parity-"));
  const messages = [];
  let sdkSessionId = null;
  try {
    const client = createSdkClient({
      prompt: PROMPT,
      options: {
        cwd: scratch,
        model: MODEL,
        effort: "low",
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project"],
        allowedTools: ["Write", "Read"],
        disallowedTools: [
          "Bash", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch",
          "Task", "TodoWrite", "NotebookEdit", "BashOutput", "KillBash", "Skill"
        ],
        maxTurns: 6,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        persistSession: true,
      },
    });

    for await (const message of client) {
      if (typeof message?.session_id === "string" && message.session_id) sdkSessionId = message.session_id;
      messages.push(fixtureMessage(message, scratch));
    }

    const toolStarts = messages
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.message?.content ?? [])
      .filter((block) => block?.type === "tool_use");
    const toolResults = messages
      .filter((message) => message.type === "user")
      .flatMap((message) => message.message?.content ?? [])
      .filter((block) => block?.type === "tool_result");
    if (toolStarts.length < 2 || toolResults.length < 2) {
      throw new Error(`fixture capture expected at least two tool calls/results; got ${toolStarts.length}/${toolResults.length}`);
    }
    if (!messages.some((message) => message.type === "stream_event")) {
      throw new Error("fixture capture did not receive partial stream_event messages");
    }
    if (!messages.some((message) => message.type === "result")) {
      throw new Error("fixture capture did not receive a terminal result");
    }

    const fixture = {
      schemaVersion: 1,
      source: "Claude Agent SDK 0.3.179",
      model: MODEL,
      prompt: PROMPT,
      expected: {
        minimumToolCalls: 2,
        toolNames: toolStarts.map((block) => block.name),
        hasPartialMessages: true,
        hasTerminalResult: true,
      },
      messages,
    };
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `captured ${messages.length} SDK messages, ${toolStarts.length} tools, ${toolResults.length} results; session=${sdkSessionId ? "yes" : "no"}\n`
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
