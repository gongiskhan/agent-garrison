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

// The pinned SDK emits the structured `error_max_turns` result first, then its
// Query iterator rejects while the Claude subprocess exits non-zero. That second
// signal is not a new runtime failure: the result envelope is the authoritative
// stop reason. Keep this matcher deliberately narrow and only use it after the
// explicit result has already been observed (see _consume).
function isPostResultMaxTurnsError(err) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /(?:Claude Code returned an error result:\s*)?Reached maximum number of turns \(\d+\)/i.test(message);
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
      // buildQueryOptions forwards effort only for a provider whose capability
      // record says the installed Agent SDK can apply it. Unsupported providers
      // retain the request for evidence but must report false.
      effortApplied: config.effort != null && capabilities.effort === "supported",
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
    if (session.effort != null && session.capabilities?.effort === "supported") {
      opts.effort = session.effort;
    }
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

    try {
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
    } catch (err) {
      // SDK 0.3.179 reports max-turn twice: a structured result followed by this
      // iterator rejection. Normalize only that exact pair into the adapter's
      // documented stoppedReason response. A matching-looking throw without the
      // envelope, or any unrelated post-result error, still rejects.
      if (stoppedReason !== "max_turns" || !isPostResultMaxTurnsError(err)) throw err;
    }

    session.turns += 1;
    session.sessionId = sessionId;
    return { text: textOut, artifacts: [], toolUses, stoppedReason };
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
    // The installed Agent SDK exposes query option `effort`. buildQueryOptions
    // forwards it only where the provider supports it; elsewhere retain the
    // requested value while reporting the explicit not-applied state.
    session.effort = effort ?? null;
    session.effortApplied = effort != null && session.capabilities?.effort === "supported";
  }

  async resume(config) {
    return this.spawn({ ...config, sessionId: config.sessionId ?? config.resume ?? null });
  }

  async teardown(session) {
    if (session) session.alive = false;
  }
}
