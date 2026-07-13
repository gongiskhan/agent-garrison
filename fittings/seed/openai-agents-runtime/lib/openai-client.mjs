// openai-client.mjs - the SOLE module that imports @openai/agents / openai / zod.
//
// Isolated on purpose so the adapter stays injectable/testable: the adapter
// lazy-imports this module only inside its default runner factory, so the unit
// path (which injects `runAgent`) never loads the SDK. This module builds a
// PER-CALL OpenAI client with the target's base URL (never a process-global, so
// concurrent delegations may target different endpoints), wraps it in an
// OpenAIChatCompletionsModel, runs one turn through the agentic loop, and returns
// a NORMALIZED envelope the adapter reads directly.
//
// SDK CHOICE (RUN_SPEC assumption 9): @openai/agents (MIT). Its custom-base-URL
// story was verified clean in practice - a per-call `OpenAIChatCompletionsModel(
// new OpenAI({ baseURL }), model)` reaches OpenAI cloud, local Ollama, and any
// OpenAI-compatible endpoint without touching the setDefaultOpenAIClient global.
import OpenAI from "openai";
import { Agent, Runner, OpenAIChatCompletionsModel, MaxTurnsExceededError, tool, setTracingDisabled } from "@openai/agents";
import { z } from "zod";
import path from "node:path";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";

// No OpenAI tracing exporter is configured (and none should phone home from a
// local-first app) - disable it so the SDK does not emit "No API key provided for
// OpenAI tracing exporter" noise on every turn.
setTracingDisabled(true);

// Confine a caller-supplied path to the session working directory: a tool must
// never read/write outside the cwd it was granted (bypassPermissions hardening).
function confine(root, p) {
  const resolved = path.resolve(root, p ?? ".");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path "${p}" escapes the session working directory`);
  }
  return resolved;
}

// The cwd-confined file toolset the `full` harness enables. Errors are returned as
// strings (the model reads them and recovers) rather than thrown out of the loop.
export function buildFileTools(cwd) {
  const root = path.resolve(cwd || process.cwd());
  return [
    tool({
      name: "read_file",
      description: "Read a UTF-8 text file, path relative to the working directory.",
      parameters: z.object({ path: z.string().describe("file path relative to the working directory") }),
      execute: async ({ path: p }) => {
        try {
          return readFileSync(confine(root, p), "utf8");
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      }
    }),
    tool({
      name: "write_file",
      description: "Write (create/overwrite) a UTF-8 text file, path relative to the working directory.",
      parameters: z.object({
        path: z.string().describe("file path relative to the working directory"),
        content: z.string().describe("full file contents to write")
      }),
      execute: async ({ path: p, content }) => {
        try {
          const abs = confine(root, p);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content ?? "", "utf8");
          return `wrote ${abs} (${Buffer.byteLength(content ?? "", "utf8")} bytes)`;
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      }
    }),
    tool({
      name: "list_dir",
      description: "List the entries of a directory, path relative to the working directory.",
      parameters: z.object({ path: z.string().default(".").describe("directory path relative to the working directory") }),
      execute: async ({ path: p }) => {
        try {
          return readdirSync(confine(root, p || "."), { withFileTypes: true })
            .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
            .join("\n");
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      }
    })
  ];
}

function sumUsage(res) {
  let total = 0;
  for (const r of res?.rawResponses ?? []) {
    const u = r?.usage ?? {};
    total += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  }
  return total;
}

// Run ONE turn through the OpenAI agentic loop and normalize the result. Returns
// { finalOutput, newItems, history, stoppedReason, usedTokens }. A maxTurns
// overrun is caught and reported as stoppedReason:"max_turns" (never thrown out).
export async function runOpenAiAgent({ baseUrl, apiKey, model, instructions, toolsEnabled, cwd, input, thread, maxTurns }) {
  if (!model) throw new Error("openai-agents: no model specified for the turn");
  const client = new OpenAI({ baseURL: baseUrl || undefined, apiKey: apiKey || "unused" });
  const modelInstance = new OpenAIChatCompletionsModel(client, model);
  const tools = toolsEnabled ? buildFileTools(cwd) : [];
  const agent = new Agent({ name: "garrison-operative", instructions, model: modelInstance, tools });
  const runner = new Runner({ tracingDisabled: true });

  // Continue a prior conversation by concatenating the new user turn onto the
  // carried history; otherwise the input is the bare user string.
  const runInput = Array.isArray(thread) && thread.length ? thread.concat([{ role: "user", content: input }]) : input;

  try {
    const res = await runner.run(agent, runInput, { maxTurns: maxTurns ?? 12 });
    return {
      finalOutput: res.finalOutput ?? "",
      newItems: res.newItems ?? [],
      history: res.history ?? null,
      stoppedReason: null,
      usedTokens: sumUsage(res)
    };
  } catch (err) {
    if (err instanceof MaxTurnsExceededError || err?.name === "MaxTurnsExceededError") {
      return { finalOutput: "", newItems: [], history: Array.isArray(thread) ? thread : null, stoppedReason: "max_turns", usedTokens: 0 };
    }
    throw err;
  }
}
