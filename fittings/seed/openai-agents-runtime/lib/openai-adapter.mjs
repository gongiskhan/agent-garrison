// openai-adapter.mjs - the OpenAI Agents RuntimeAdapter (BRIEF §"The adapter").
//
// Implements the RuntimeAdapter contract (packages/claude-pty/src/runtime-adapter
// .mjs) over `@openai/agents`. NO PTY, NO xterm - the SDK returns a structured
// RunResult, so `awaitResponse` reads it directly (finalOutput → text, tool-call
// items → toolUses, history → the conversation thread for the next turn). The
// generic pool + runtime-bridge drive it unchanged, exactly like the agent-sdk /
// codex / gemini adapters.
//
// The real SDK is reached ONLY via the default runner factory, which lazy-imports
// the sole SDK-importing module (lib/openai-client.mjs). Tests inject `runAgent`,
// so the unit path never loads `@openai/agents` / `openai` / `zod`.
import { buildHarness } from "./harness.mjs";
import { resolveEndpoint, capabilityRecord } from "./providers.mjs";

async function defaultRunAgent(params) {
  const mod = await import("./openai-client.mjs");
  return mod.runOpenAiAgent(params);
}

export class OpenAiAgentsAdapter {
  constructor(opts = {}) {
    this.id = "openai-agents";
    this._runAgent = opts.runAgent ?? defaultRunAgent;
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    const harness = buildHarness(config.promptMode ?? "full", {
      leanPrompt: config.leanPrompt,
      append: config.appendSystemPrompt
    });

    // Resolve the endpoint (base URL + the by-name Vault key). The key stays
    // server-side; it is carried on the session, never logged, never in argv.
    const { baseUrl, apiKey, apiKeyEnv } = resolveEndpoint(config, {
      secrets: config.secrets ?? null,
      env: config.env ?? {}
    });
    const capabilities = capabilityRecord(config);

    return {
      config,
      alive: true,
      harness,
      baseUrl,
      apiKey,
      apiKeyEnv,
      capabilities,
      model: config.model ?? null,
      effort: config.effort ?? null,
      effortApplied: false,
      // The agentic loop has no natural bound: cap turns + an optional token budget
      // so a runaway loop stops and reports instead of burning paid credits.
      maxTurns: config.maxTurns ?? 12,
      budgetTokens: config.budgetTokens ?? null,
      usedTokens: 0,
      turns: 0,
      // The @openai/agents conversation history - carried across turns for
      // multi-turn continuity (the SDK's run() accepts a prior history array).
      thread: config.thread ?? null
    };
  }

  async awaitReady(session) {
    // Trivial - the client is ready on construction; no boot-scrape.
    if (!session || !session.alive) throw new Error("OpenAiAgentsAdapter: session not alive after spawn");
  }

  // Pure builder for the run parameters - asserted by tests without running.
  buildRunParams(session, input) {
    return {
      baseUrl: session.baseUrl,
      apiKey: session.apiKey,
      model: session.model,
      instructions: session.harness.instructions,
      toolsEnabled: session.harness.toolsEnabled,
      cwd: session.config.compositionDir,
      input,
      thread: session.thread,
      maxTurns: session.maxTurns
    };
  }

  async sendTurn(session, text) {
    if (!session || !session.alive) throw new Error("OpenAiAgentsAdapter: sendTurn on a dead session");
    this._pending.set(session, this._consume(session, text));
  }

  async _consume(session, text) {
    const params = this.buildRunParams(session, text);
    const envelope = await this._runAgent(params);
    return this._extract(session, envelope);
  }

  // Turn the SDK's structured envelope into {text, artifacts, toolUses,
  // stoppedReason}. Reads finalOutput / newItems / history directly - no scraping.
  _extract(session, envelope = {}) {
    const out = envelope.finalOutput;
    const text = typeof out === "string" ? out : out != null ? String(out) : "";

    const toolUses = [];
    for (const item of envelope.newItems ?? []) {
      if (item && item.type === "tool_call_item") {
        toolUses.push({ name: item.rawItem?.name ?? item.name ?? "?", id: item.rawItem?.id ?? item.id ?? null });
      }
    }

    let stoppedReason = envelope.stoppedReason ?? null;
    session.usedTokens += envelope.usedTokens ?? 0;
    if (session.budgetTokens != null && session.usedTokens >= session.budgetTokens) {
      stoppedReason = stoppedReason ?? "budget_exceeded";
    }

    session.turns += 1;
    if (envelope.history != null) session.thread = envelope.history;
    // Cumulative token usage across this session's turns (additive telemetry, S1a).
    // Preserved through the runtime-bridge delegate result envelope.
    return { text, artifacts: [], toolUses, stoppedReason, usedTokens: session.usedTokens };
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("OpenAiAgentsAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    // Structured {text, artifacts, toolUses, stoppedReason} - read directly.
    return p;
  }

  async setModel(session, model) {
    // Model selection within ONE endpoint's family. Switching to a model on a
    // DIFFERENT base URL is a new spawn, not a setModel.
    session.model = model;
  }

  async setEffort(session, effort) {
    // Effort maps where the provider supports it, else recorded effort: unsupported.
    session.effort = effort;
    session.effortApplied = session.capabilities?.effort === "supported";
  }

  async resume(config) {
    // Re-attach a prior conversation by carrying its history thread forward.
    return this.spawn({ ...config, thread: config.thread ?? config.resume ?? null });
  }

  async teardown(session) {
    if (session) session.alive = false;
  }
}
