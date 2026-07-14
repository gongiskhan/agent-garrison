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

// S1b summarize-and-rebuild (D3/D6). The focus template + renderer are kept LOCAL
// (the runtime fittings are independent packages and must not import from the
// http-gateway fitting; the canonical copy lives at
// http-gateway/scripts/lib/compact-focus-template.mjs - a short duplicate is
// deliberate).
const DEFAULT_FOCUS_TEMPLATE = `Compaction focus - preserve the following context exactly; summarize everything else freely.

Active card: {{card_id}} - {{card_title}}
Current duty: {{duty}} (level {{level}})
Decisions made so far: {{decisions}}
Open items still to do: {{open_items}}
Files touched this run: {{files_touched}}
Pending steering from the user: {{steering}}

Do NOT drop the card id/title, the current duty and level, the decisions already made, the open items, the list of files touched, or any pending steering. Keep enough of the working context to continue the current duty without re-reading everything.`;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

function renderFocusTemplate(template, ctx = {}) {
  const tpl = typeof template === "string" && template.trim() ? template : DEFAULT_FOCUS_TEMPLATE;
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const valueFor = (k) => {
    const v = c[k];
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v.trim() : String(v).trim();
  };
  const out = [];
  for (const line of tpl.split("\n")) {
    const keys = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]);
    if (keys.length === 0) {
      out.push(line);
      continue;
    }
    if (keys.some((k) => valueFor(k) === "")) continue;
    out.push(line.replace(PLACEHOLDER, (_m, k) => valueFor(k)));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Rough context-window defaults by model family (tokens); unknown -> 200k.
function contextWindowForModel(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("sonnet") || m.includes("opus")) return 1_000_000;
  return 200_000;
}

export class OpenAiAgentsAdapter {
  constructor(opts = {}) {
    this.id = "openai-agents";
    this._runAgent = opts.runAgent ?? defaultRunAgent;
    // S1b: injectable one-shot summary call (tests override); null -> default reuses _runAgent.
    this._summarizeImpl = opts.summarize ?? null;
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
      thread: config.thread ?? null,
      // S1b summarize-and-rebuild - OFF unless config enables it.
      compactEnabled: config.compactEnabled === true,
      compactThresholdPct:
        Number.isFinite(config.compactThresholdPct) && config.compactThresholdPct > 0 ? config.compactThresholdPct : 60,
      compactContextWindow:
        Number.isFinite(config.compactContextWindow) && config.compactContextWindow > 0
          ? config.compactContextWindow
          : contextWindowForModel(config.model),
      contextSeed: null,
      rebuilds: 0
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
    // S1b: a rebuilt session seeds the next turn with the focus summary (its
    // history thread was cleared, so this restores the working context).
    const seeded = session.contextSeed ? `${session.contextSeed}\n\n---\n\n${text}` : text;
    session.contextSeed = null;
    const params = this.buildRunParams(session, seeded);
    const envelope = await this._runAgent(params);
    const result = this._extract(session, envelope);
    // Summarize-and-rebuild at the loop boundary (may reset usedTokens + thread).
    await this._maybeRebuild(session);
    // usedTokens read AFTER any rebuild - a freshly rebuilt session reports 0.
    return { ...result, usedTokens: session.usedTokens };
  }

  // S1b summarize-and-rebuild: when cumulative usage crosses the configured
  // fraction of the context window, ask the model for a focus summary, drop the
  // history thread (fresh context next turn), and seed the next turn with the
  // summary. OFF unless compactEnabled. A failed summary falls back to the focus
  // text as the seed and never throws.
  async _maybeRebuild(session) {
    if (!session.compactEnabled || !(session.compactContextWindow > 0)) return;
    const trigger = Math.floor((session.compactContextWindow * session.compactThresholdPct) / 100);
    if (session.usedTokens < trigger) return;
    const template =
      typeof session.config.focusTemplate === "string" && session.config.focusTemplate.trim()
        ? session.config.focusTemplate
        : DEFAULT_FOCUS_TEMPLATE;
    const focusText = renderFocusTemplate(template, session.config.focusContext ?? {});
    let summary = "";
    try {
      summary = await this._summarize(session, focusText);
    } catch {
      summary = "";
    }
    session.thread = null;
    session.contextSeed = summary && summary.trim() ? summary.trim() : focusText;
    session.usedTokens = 0;
    session.rebuilds += 1;
  }

  // One-shot summary call. Injectable (tests pass opts.summarize); the default
  // reuses the runner against the CURRENT (pre-reset) thread so it summarizes the
  // conversation so far.
  async _summarize(session, focusText) {
    if (this._summarizeImpl) return this._summarizeImpl(session, focusText);
    const prompt = `${focusText}\n\nSummarize the conversation so far into a compact briefing that preserves the above. Output only the briefing.`;
    const envelope = await this._runAgent(this.buildRunParams(session, prompt));
    return String(envelope.finalOutput ?? "");
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
