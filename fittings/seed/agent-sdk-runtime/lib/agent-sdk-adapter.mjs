// agent-sdk-adapter.mjs — the Agent SDK RuntimeAdapter (BRIEF §"The adapter").
//
// Implements the RuntimeAdapter contract (packages/claude-pty/src/runtime-adapter
// .mjs) against the Claude Agent SDK — NO PTY, NO xterm. The generic pool +
// runtime-bridge drive it unchanged, exactly like the Codex/Gemini secondaries.
// It is cleaner than driving a TUI: structured request/response, native tool-call
// handling, and `awaitResponse` reads the SDK's structured messages directly —
// NO terminal-scraping heuristics.
//
// The runtime is first-class routable to any provider in the SDK provider table,
// including the Anthropic endpoint on the Max subscription (D29). THE HARNESS
// (lib/harness.mjs) is the one load-bearing property at spawn: per-target
// promptMode wires the full claude_code preset (+ settingSources + skills) or a
// lean string.
//
// The real SDK is reached ONLY via the default client factory, which lazy-imports
// the sole SDK-importing module (lib/sdk-client.mjs). Tests inject `createClient`,
// so the unit-test path never loads the SDK.
import { buildHarness } from "./harness.mjs";
import { buildSdkEnv, resolveProviderBaseUrl, capabilityRecord } from "./providers.mjs";

async function defaultCreateClient(args) {
  const mod = await import("./sdk-client.mjs");
  return mod.createSdkClient(args);
}

export class AgentSdkAdapter {
  constructor(opts = {}) {
    this.id = "agent-sdk";
    this._createClient = opts.createClient ?? defaultCreateClient;
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    const harness = buildHarness(config.promptMode ?? "full", {
      leanPrompt: config.leanPrompt,
      append: config.appendSystemPrompt
    });

    // Resolve the endpoint base URL (null for the Anthropic subscription path) and
    // the launch env (resolves the vault key; clears inherited Anthropic vars).
    const baseUrl = resolveProviderBaseUrl(config);
    const { env, vaultKey } = buildSdkEnv(config, { secrets: config.secrets ?? null, baseEnv: config.env ?? {} });
    const capabilities = capabilityRecord(config);

    return {
      config,
      alive: true,
      harness,
      env,
      baseUrl,
      capabilities,
      vaultKey,
      model: config.model ?? null,
      effort: config.effort ?? null,
      effortApplied: false,
      // SDK sessions have NO default turn limit and do not time out: a loop would
      // burn paid credits until stopped. Cap turns + an optional token budget.
      maxTurns: config.maxTurns ?? 12,
      budgetTokens: config.budgetTokens ?? null,
      usedTokens: 0,
      turns: 0,
      sessionId: config.sessionId ?? null
    };
  }

  async awaitReady(session) {
    // Trivial — the SDK client is ready on construction; no boot-scrape.
    if (!session || !session.alive) throw new Error("AgentSdkAdapter: session not alive after spawn");
  }

  // Pure builder for the SDK query options — asserted by tests without spawning.
  buildQueryOptions(session) {
    const opts = {
      systemPrompt: session.harness.systemPrompt,
      settingSources: session.harness.settingSources,
      cwd: session.config.compositionDir,
      maxTurns: session.maxTurns,
      env: session.env,
      permissionMode: session.config.permissionMode ?? "bypassPermissions"
    };
    if (session.model) opts.model = session.model;
    if (session.config.allowedTools) opts.allowedTools = session.config.allowedTools;
    // Tool policy: an explicit config.disallowedTools wins; else the harness's
    // (lean = all built-ins disabled → pure chat; full = none).
    const disallowed = session.config.disallowedTools ?? session.harness.disallowedTools;
    if (disallowed && disallowed.length) opts.disallowedTools = disallowed;
    if (session.config.mcpServers) opts.mcpServers = session.config.mcpServers;
    if (session.sessionId) opts.resume = session.sessionId;
    return opts;
  }

  async sendTurn(session, text) {
    if (!session || !session.alive) throw new Error("AgentSdkAdapter: sendTurn on a dead session");
    const options = this.buildQueryOptions(session);
    this._pending.set(session, this._consume(session, text, options));
  }

  // Consume the SDK's structured message stream directly (NO scraping). Stops and
  // reports on maxTurns / budget ceiling rather than looping on paid credits.
  async _consume(session, text, options) {
    const client = await this._createClient({ prompt: text, options });
    let textOut = "";
    const toolUses = [];
    let stoppedReason = null;
    let sessionId = session.sessionId;

    for await (const msg of client) {
      const type = msg?.type;
      if (type === "system" && msg.session_id) {
        sessionId = msg.session_id;
      } else if (type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text") textOut += block.text;
          else if (block.type === "tool_use") toolUses.push({ name: block.name, id: block.id });
        }
      } else if (type === "result") {
        const usage = msg.usage ?? {};
        const turnTokens = (usage.output_tokens ?? 0) + (usage.input_tokens ?? 0) || (usage.total_tokens ?? 0);
        session.usedTokens += turnTokens;
        if (msg.subtype === "error_max_turns") stoppedReason = "max_turns";
        else if (typeof msg.subtype === "string" && msg.subtype.startsWith("error")) {
          stoppedReason = stoppedReason ?? msg.subtype;
        }
        if (!textOut && typeof msg.result === "string") textOut = msg.result;
        if (msg.session_id) sessionId = msg.session_id;
      }
      // Hard budget ceiling.
      if (session.budgetTokens != null && session.usedTokens >= session.budgetTokens) {
        stoppedReason = stoppedReason ?? "budget_exceeded";
        break;
      }
    }

    session.turns += 1;
    session.sessionId = sessionId;
    // Cumulative token usage across this session's turns (additive telemetry, S1a).
    // Preserved through the runtime-bridge delegate result envelope.
    return { text: textOut, artifacts: [], toolUses, stoppedReason, usedTokens: session.usedTokens };
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("AgentSdkAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    // Structured {text, artifacts, toolUses, stoppedReason} — read directly, no scraping.
    return p;
  }

  async setModel(session, model) {
    // Model selection at runtime within ONE endpoint's family. Switching to a
    // model on a DIFFERENT base URL is a new spawn, not a setModel.
    session.model = model;
  }

  async setEffort(session, effort) {
    // Effort maps where the provider supports it, else recorded effort: unsupported.
    session.effort = effort;
    session.effortApplied = session.capabilities?.effort === "supported";
  }

  async resume(config) {
    return this.spawn({ ...config, sessionId: config.sessionId ?? config.resume ?? null });
  }

  async teardown(session) {
    if (session) session.alive = false;
  }
}
