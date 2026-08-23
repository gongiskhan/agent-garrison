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
import {
  Agent,
  Runner,
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  MaxTurnsExceededError,
  tool,
  setTracingDisabled
} from "@openai/agents";
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

// The reasoning efforts @openai/agents ModelSettings accepts. The Codex catalog
// also advertises `ultra`, which the SDK's type does not carry - it is dropped
// here rather than passed through as an unchecked string.
// Provider-level diagnoses raised inside the transport that must survive the
// OpenAI client's blanket error wrapping (see the unwrap in the catch below).
const TRANSPORT_ERROR_CODES = new Set([
  "usage-limit-reached",
  "credential-absent",
  "credential-expired",
  "credential-corrupt",
  "credential-not-subscription",
  "refresh-failed"
]);

const SUPPORTED_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
export async function runOpenAiAgent({
  baseUrl,
  apiKey,
  model,
  instructions,
  toolsEnabled,
  cwd,
  input,
  thread,
  maxTurns,
  signal,
  wireApi,
  fetchImpl,
  effort
}) {
  if (!model) throw new Error("openai-agents: no model specified for the turn");
  // `fetchImpl` is how a provider that is not a plain keyed endpoint injects its
  // own auth and body rules (the ChatGPT subscription resolves + refreshes an
  // OAuth token per request). Passed to the client rather than wrapped around it
  // so retries and streaming inside the SDK go through it too.
  const client = new OpenAI({
    baseURL: baseUrl || undefined,
    apiKey: apiKey || "unused",
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  });
  // Wire API is a PROVIDER property, not a preference: the Codex backend serves
  // only /responses, while every OpenAI-compatible endpoint this fitting targets
  // (Ollama, vLLM, LiteLLM, OpenAI cloud) serves /chat/completions. Picking the
  // wrong class is a 404, so the provider table decides and this just obeys.
  const modelInstance =
    wireApi === "responses"
      ? new OpenAIResponsesModel(client, model)
      : new OpenAIChatCompletionsModel(client, model);
  const tools = toolsEnabled ? buildFileTools(cwd) : [];
  // Reasoning effort is the tier dial on this engine: one model family answers at
  // several depths, so a routing tier that cannot move it is not a tier at all.
  // Only values the SDK's ModelSettings actually accepts are forwarded - an
  // unrecognised string would be sent verbatim and rejected by the endpoint, which
  // reads as a broken route rather than an unsupported knob.
  const modelSettings = SUPPORTED_EFFORTS.has(effort) ? { reasoning: { effort } } : undefined;
  const agent = new Agent({
    name: "garrison-operative",
    instructions,
    model: modelInstance,
    tools,
    ...(modelSettings ? { modelSettings } : {})
  });
  const runner = new Runner({ tracingDisabled: true });

  // Continue a prior conversation by concatenating the new user turn onto the
  // carried history; otherwise the input is the bare user string.
  const runInput = Array.isArray(thread) && thread.length ? thread.concat([{ role: "user", content: input }]) : input;

  try {
    // `signal` is the Stop primitive for this runtime: there is no child process to
    // SIGTERM, so aborting the in-flight run IS the cancel (agents-core run.d.ts
    // accepts it). Without it a routed turn on this engine would be un-stoppable.
    //
    // The Codex backend REFUSES a non-streamed request outright ({"detail":"Stream
    // must be set to true"}), so the responses lane runs the streamed loop and
    // waits for it to complete. Everything else keeps the non-streamed call it has
    // always made - the same result object either way, so the envelope below is
    // shared rather than duplicated per lane.
    const streamed = wireApi === "responses";
    const res = await runner.run(agent, runInput, {
      maxTurns: maxTurns ?? 12,
      ...(streamed ? { stream: true } : {}),
      ...(signal ? { signal } : {})
    });
    if (streamed) {
      await res.completed;
      // A streamed run reports a mid-run failure on the result rather than by
      // rejecting, so an unchecked `completed` would return an empty turn as if it
      // had succeeded.
      if (res.error) throw res.error;
    }
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
    // A cancelled run settles as a partial turn, not a thrown error - the same
    // contract the exec adapters' cancel() gives (stop yields what was produced).
    if (err?.name === "AbortError" || signal?.aborted) {
      return { finalOutput: "", newItems: [], history: Array.isArray(thread) ? thread : null, stoppedReason: "cancelled", usedTokens: 0 };
    }
    // The OpenAI client wraps ANYTHING thrown out of its fetch as a bare
    // "APIConnectionError: Connection error." A provider-level diagnosis raised in
    // the transport (a plan usage limit, an unusable credential) is exactly the
    // message the operator needs, and reporting it as a connection failure sends
    // them to look at the network instead. The client preserves `cause`, so
    // surface ours when it is there.
    if (err?.cause?.code && TRANSPORT_ERROR_CODES.has(err.cause.code)) throw err.cause;
    throw err;
  }
}
