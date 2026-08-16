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
import { randomUUID } from "node:crypto";
import { buildHarness } from "./harness.mjs";
import { buildSdkEnv, resolveProviderBaseUrl, capabilityRecord, isAnthropicProvider } from "./providers.mjs";
import {
  SESSION_TEXT_BLOCK_CAP,
  clampSessionText,
  createAgentSdkSessionEventNormalizer
} from "./session-events.mjs";

async function defaultCreateClient(args) {
  const mod = await import("./sdk-client.mjs");
  return mod.createSdkClient(args);
}

// S1b summarize-and-rebuild (D3/D6). The focus template + renderer are kept LOCAL:
// the runtime fittings are independent packages and must not import from the
// http-gateway fitting. The canonical copy lives at
// http-gateway/scripts/lib/compact-focus-template.mjs; a short duplicate is
// deliberate.
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

// The pinned SDK emits the structured `error_max_turns` result first, then its
// Query iterator rejects while the Claude subprocess exits non-zero. That second
// signal is not a new runtime failure: the result envelope is the authoritative
// stop reason. Keep this matcher deliberately narrow and only use it after the
// explicit result has already been observed (see _consume).
function isPostResultMaxTurnsError(err) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /(?:Claude Code returned an error result:\s*)?Reached maximum number of turns \(\d+\)/i.test(message);
}

// Session ids become filesystem coordinates when the gateway exposes the SDK's
// Claude journal. Accept the opaque id shape emitted by Claude Code, but reject
// separators, control characters and unbounded input before publishing it to a
// channel. Keeping this local to the adapter means every future channel receives
// the same trusted identity rather than re-validating an SDK frame ad hoc.
function validatedSessionId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : null;
}

function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

const PUBLIC_PERMISSION_SUGGESTION_CAP = 64;
const PUBLIC_PERMISSION_DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Permission approval is a security boundary: the browser may approve only
// values whose complete JSON representation can be shown and durably restored.
// This is intentionally stricter than ordinary tool-event normalization, which
// may use an honest truncation marker for observational output.
function isPlainJsonValue(value, depth = 0, maxDepth = 64, seen = new Set()) {
  if (depth > maxDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) return false;
  } else if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  seen.add(value);
  const entries = Object.entries(value);
  const enumerableKeys = entries.map(([key]) => key);
  const ownNames = Object.getOwnPropertyNames(value);
  const keysSafe = Array.isArray(value)
    ? enumerableKeys.length === value.length &&
      enumerableKeys.every((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return key === String(index) &&
          descriptor?.enumerable === true &&
          Object.hasOwn(descriptor, "value");
      }) &&
      ownNames.length === value.length + 1 && ownNames.includes("length")
    : ownNames.length === enumerableKeys.length && enumerableKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return key.length <= 200 &&
          !PUBLIC_PERMISSION_DANGEROUS_KEYS.has(key) &&
          descriptor?.enumerable === true &&
          Object.hasOwn(descriptor, "value");
      });
  const complete = keysSafe && entries.every(([, entry]) =>
    isPlainJsonValue(entry, depth + 1, maxDepth, seen)
  );
  seen.delete(value);
  return complete;
}

function publicPermissionInput(value) {
  const source = value ?? {};
  let encoded = "";
  try {
    encoded = JSON.stringify(source, null, 2);
  } catch {
    return { input: clampSessionText(source), inputComplete: false };
  }
  if (typeof encoded !== "string") {
    return { input: clampSessionText(source), inputComplete: false };
  }
  return {
    input: clampSessionText(encoded),
    inputComplete: encoded.length <= SESSION_TEXT_BLOCK_CAP && (() => {
      try {
        return isPlainJsonValue(source);
      } catch {
        return false;
      }
    })()
  };
}

function publicPermissionSuggestions(value) {
  if (value == null) return { suggestionsComplete: true };
  if (!Array.isArray(value)) return { suggestionsComplete: false };
  if (value.length === 0) return { suggestionsComplete: true };
  if (value.length > PUBLIC_PERMISSION_SUGGESTION_CAP) return { suggestionsComplete: false };
  let jsonSafe = false;
  try {
    jsonSafe = isPlainJsonValue(value, 0, 8);
  } catch {
    jsonSafe = false;
  }
  if (!jsonSafe) {
    return { suggestionsComplete: false };
  }
  let encoded = "";
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { suggestionsComplete: false };
  }
  if (encoded.length > SESSION_TEXT_BLOCK_CAP) return { suggestionsComplete: false };
  const suggestions = jsonClone(value);
  return Array.isArray(suggestions)
    ? { suggestions, suggestionsComplete: true }
    : { suggestionsComplete: false };
}

function privatePermissionInputSnapshot(disclosure) {
  if (disclosure?.inputComplete !== true || typeof disclosure.input !== "string") return undefined;
  try {
    // Parse the exact string shown to the user instead of reading the SDK-owned
    // input again after validation. This makes the executable snapshot identical
    // to the disclosure even if the caller mutates its object while awaiting a
    // decision.
    return JSON.parse(disclosure.input);
  } catch {
    return undefined;
  }
}

function permissionAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Permission request was cancelled."
  );
  error.name = "AbortError";
  return error;
}

function awaitPermissionDecision(promise, signal) {
  if (!signal || typeof signal.addEventListener !== "function") return promise;
  if (signal.aborted) return Promise.reject(permissionAbortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(permissionAbortError(signal));
    };
    const cleanup = () => signal.removeEventListener?.("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (decision) => {
        cleanup();
        resolve(decision);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function sdkPermissionResult(decision, inputSnapshot, suggestions, disclosure) {
  if (decision === "allow_once") {
    if (disclosure?.inputComplete !== true || inputSnapshot === undefined) {
      throw new Error("Allow once requires the complete proposed tool input.");
    }
    return { behavior: "allow", updatedInput: inputSnapshot, decisionClassification: "user_temporary" };
  }
  if (decision === "allow_always") {
    if (
      disclosure?.inputComplete !== true ||
      inputSnapshot === undefined ||
      disclosure?.suggestionsComplete !== true ||
      !Array.isArray(suggestions) ||
      suggestions.length === 0
    ) {
      throw new Error("Always allow requires complete SDK permission suggestions and tool input.");
    }
    return {
      behavior: "allow",
      updatedInput: inputSnapshot,
      updatedPermissions: suggestions,
      decisionClassification: "user_permanent"
    };
  }
  if (decision === "deny") {
    return {
      behavior: "deny",
      message: "User denied this tool request.",
      decisionClassification: "user_reject"
    };
  }
  throw new Error(`Invalid permission decision: ${String(decision)}`);
}

export class AgentSdkAdapter {
  constructor(opts = {}) {
    this.id = "agent-sdk";
    this._createClient = opts.createClient ?? defaultCreateClient;
    // S1b: an injectable one-shot summary call (tests override it); null -> the
    // default implementation reuses _createClient.
    this._summarizeImpl = opts.summarize ?? null;
    this._permissionRequestId = typeof opts.permissionRequestId === "function" ? opts.permissionRequestId : randomUUID;
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // `coding` (claude_code preset + the user's ~/.claude profile) is only
    // honored on the Anthropic subscription path — a third-party base-URL
    // provider downgrades to `full` so the user settings env block can never
    // redirect its endpoint (the #217 trap).
    const requestedMode = config.promptMode ?? "full";
    const promptMode =
      requestedMode === "coding" && !isAnthropicProvider(config.provider) ? "full" : requestedMode;
    const harness = buildHarness(promptMode, {
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
      sessionId: config.sessionId ?? null,
      // Cancel bookkeeping - the in-flight SDK query (stashed per turn by _consume)
      // and the user's Stop intent. Declared here so the session shape is honest.
      client: null,
      cancelRequested: false,
      // S1b summarize-and-rebuild — OFF unless config enables it.
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
      permissionMode: session.config.permissionMode ?? "bypassPermissions",
      // Channels need the same live text/thinking/tool input that Claude's TUI
      // paints while a message is being generated. Settled assistant envelopes
      // alone arrive too late and omit the incremental input JSON.
      includePartialMessages: true
    };
    if (session.model) opts.model = session.model;
    // Dispatch inference is deliberately a fast, non-reasoning classification
    // turn. Keep the accepted surface narrow: callers may explicitly disable
    // extended thinking, but cannot smuggle arbitrary thinking budgets through
    // the generic runtime config.
    if (session.config.thinking?.type === "disabled") {
      opts.thinking = { type: "disabled" };
    }
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

  // `hooks` is OPTIONAL liveness plumbing (2026-07-25 web-channel run-context §12):
  //   onText(accumulatedText)  - per assistant envelope that contains text
  //   onTool({name, id})       - per tool_use block
  //   onThinking(text)         - per extended-thinking block (the DELTA, not the
  //                              accumulation: thinking is long and a channel
  //                              shows only the latest line as a liveness hint)
  //   onSession(sessionId)     - when the SDK's system frame first announces a
  //                              validated session id, before the turn completes
  //   onEvent(sessionEvent)    - provider-neutral, revisioned text/thinking/tool/
  //                              result/status/limit/terminal snapshot
  //   turnId                   - optional caller identity copied onto onEvent
  //   generationId             - durable caller generation copied onto a
  //                              permission request (never inferred from turnId)
  //   onPermissionRequest(request, {signal}) - resolve an SDK tool prompt with
  //                              allow_once, allow_always, or deny
  // Callers that pass nothing get byte-identical behaviour: the reply is still
  // accumulated and returned whole by awaitResponse. Without these the routed
  // lanes are silent for minutes and then dump a blob.
  async sendTurn(session, text, hooks = {}) {
    if (!session || !session.alive) throw new Error("AgentSdkAdapter: sendTurn on a dead session");
    const options = this.buildQueryOptions(session);
    // A prior turn's cancel must never leak into this one, and the stale client
    // handle must not be cancellable once its turn is over.
    session.cancelRequested = false;
    session.client = null;
    this._pending.set(session, this._consume(session, text, options, hooks));
  }

  // Real cancel (2026-07-25 web-channel run-context §9). A flag alone is not
  // enough: it is only observed at the next SDK message boundary, so during a long
  // thinking phase nothing would stop. The stashed query object is an async
  // generator - return() aborts it - and teardown() (`alive = false`) frees
  // nothing. Safe with no in-flight client: the flag still short-circuits the
  // consume loop, and sendTurn clears it for the next turn.
  async cancel(session) {
    if (!session) return false;
    session.cancelRequested = true;
    const client = session.client ?? null;
    if (!client || typeof client.return !== "function") return false;
    // Idempotent: releasing the handle first means a second Stop cannot return()
    // an already-finished generator.
    session.client = null;
    try {
      await client.return();
    } catch {
      /* an already-finished or already-aborted query is a successful cancel */
    }
    return true;
  }

  // Consume the SDK's structured message stream directly (NO scraping). Stops and
  // reports on maxTurns / budget ceiling rather than looping on paid credits.
  async _consume(session, text, options, hooks = {}) {
    const onText = typeof hooks.onText === "function" ? hooks.onText : null;
    const onTool = typeof hooks.onTool === "function" ? hooks.onTool : null;
    const onThinking = typeof hooks.onThinking === "function" ? hooks.onThinking : null;
    const onSession = typeof hooks.onSession === "function" ? hooks.onSession : null;
    const onEvent = typeof hooks.onEvent === "function" ? hooks.onEvent : null;
    const onPermissionRequest = typeof hooks.onPermissionRequest === "function" ? hooks.onPermissionRequest : null;
    const permissionGenerationId = typeof hooks.generationId === "string" ? hooks.generationId.trim() : "";
    if (onPermissionRequest && !permissionGenerationId) {
      throw new Error("AgentSdkAdapter: a permission resolver requires a generation id");
    }
    const eventNormalizer = createAgentSdkSessionEventNormalizer({
      turnId: hooks.turnId ?? null,
      sessionId: session.sessionId
    });
    let eventTail = Promise.resolve();
    const emitEvents = (events) => {
      if (!onEvent || !Array.isArray(events) || events.length === 0) return eventTail;
      eventTail = eventTail.then(async () => {
        for (const event of events) {
          try {
            // Await promise-returning sinks so a durable channel can preserve
            // event order. A broken observability sink must never kill the turn.
            await onEvent(event);
          } catch {
            /* streaming consumer error must not kill the turn */
          }
        }
      });
      return eventTail;
    };
    const normalizeAndEmit = async (message) => {
      if (!onEvent) return;
      try {
        await emitEvents(eventNormalizer.push(message));
      } catch {
        /* event normalization is observability and must not kill the turn */
      }
    };
    if (onPermissionRequest) {
      options.canUseTool = async (toolName, input, sdkOptions = {}) => {
        const generated = this._permissionRequestId();
        const requestId = typeof generated === "string" && generated.trim() ? generated.trim() : randomUUID();
        const originalSuggestions = sdkOptions.suggestions;
        const inputDisclosure = publicPermissionInput(input);
        const permissionInputSnapshot = privatePermissionInputSnapshot(inputDisclosure);
        const suggestionDisclosure = publicPermissionSuggestions(originalSuggestions);
        // Keep the value authorized by the user isolated from both mutable sides of
        // this boundary. The SDK retains `originalSuggestions` while the resolver
        // receives the public disclosure below; either may be mutated during the
        // potentially long wait for a decision. Only this private, validated JSON
        // snapshot may become updatedPermissions.
        const permissionSuggestionsSnapshot = Array.isArray(suggestionDisclosure.suggestions)
          ? jsonClone(suggestionDisclosure.suggestions)
          : null;
        const publicRequest = {
          type: "permission_request",
          requestId,
          generationId: permissionGenerationId,
          toolUseId: sdkOptions.toolUseID ?? null,
          name: String(toolName ?? "tool"),
          ...inputDisclosure,
          ...suggestionDisclosure,
          ...(typeof sdkOptions.title === "string" && sdkOptions.title ? { title: sdkOptions.title } : {}),
          ...(typeof sdkOptions.displayName === "string" && sdkOptions.displayName ? { displayName: sdkOptions.displayName } : {}),
          ...(typeof sdkOptions.description === "string" && sdkOptions.description ? { description: sdkOptions.description } : {}),
          ...(typeof sdkOptions.blockedPath === "string" && sdkOptions.blockedPath ? { blockedPath: sdkOptions.blockedPath } : {}),
          ...(typeof sdkOptions.decisionReason === "string" && sdkOptions.decisionReason ? { reason: sdkOptions.decisionReason } : {}),
          ...(typeof sdkOptions.agentID === "string" && sdkOptions.agentID ? { agentId: sdkOptions.agentID } : {}),
          status: "pending"
        };
        const eventRequest = jsonClone(publicRequest) ?? { ...publicRequest };

        // Register the resolver synchronously before publishing the pending
        // event. A browser cannot click a prompt whose control handle is not yet
        // live, even when the durable event sink and SSE delivery are immediate.
        let decisionPromise;
        try {
          decisionPromise = Promise.resolve(onPermissionRequest(publicRequest, { signal: sdkOptions.signal }));
        } catch (error) {
          decisionPromise = Promise.reject(error);
        }
        // The pending event sink may be asynchronous. Attach a handler now so a
        // synchronous callback rejection cannot become an unhandled promise.
        decisionPromise.catch(() => {});

        const pendingEvents = eventNormalizer.permissionRequest(eventRequest);
        await emitEvents(pendingEvents);
        try {
          const decision = await awaitPermissionDecision(decisionPromise, sdkOptions.signal);
          const result = sdkPermissionResult(decision, permissionInputSnapshot, permissionSuggestionsSnapshot, {
            inputComplete: inputDisclosure.inputComplete,
            suggestionsComplete: suggestionDisclosure.suggestionsComplete
          });
          await emitEvents(eventNormalizer.resolvePermissionRequest(requestId, decision));
          return result;
        } catch (error) {
          await emitEvents(eventNormalizer.cancelPermissionRequest(requestId));
          throw error;
        }
      };
    }
    // S1b: a rebuilt session seeds the next turn with the focus summary (the SDK
    // session/resume was cleared, so this restores the working context).
    const seeded = session.contextSeed ? `${session.contextSeed}\n\n---\n\n${text}` : text;
    session.contextSeed = null;
    const client = await this._createClient({ prompt: seeded, options });
    // Stash the query so cancel() has something to abort. Local-only (the bug the
    // run-context decision calls out) meant Stop had nothing to act on.
    session.client = client;
    let textOut = "";
    let lastTextEnvelope = "";
    let resultText = "";
    const toolUses = [];
    let stoppedReason = null;
    let sessionId = session.sessionId;
    let announcedSessionId = null;

    try {
      for await (const msg of client) {
        // A cancel that landed mid-stream stops here rather than folding another
        // message in. cancel() also return()s the iterator, so this is the belt to
        // that braces: it covers a cancel observed before the abort propagates.
        if (session.cancelRequested) {
          stoppedReason = stoppedReason ?? "cancelled";
          break;
        }
        await normalizeAndEmit(msg);
        const type = msg?.type;
        if (type === "system" && msg.session_id) {
          const announced = validatedSessionId(msg.session_id);
          if (announced) {
            sessionId = announced;
            // Persist immediately: callers must be able to derive and expose the
            // journal while thinking and tools are still streaming, not only
            // after awaitResponse settles at the bottom of this method.
            session.sessionId = announced;
            if (onSession && announced !== announcedSessionId) {
              announcedSessionId = announced;
              try {
                onSession(announced);
              } catch {
                /* streaming consumer error must not kill the turn */
              }
            }
          }
        } else if (type === "assistant") {
          const content = msg.message?.content ?? [];
          // One SDK `assistant` envelope is one presentable interim message. Text
          // blocks INSIDE that envelope are fragments of the same message and stay
          // adjacent; a later assistant envelope arrives after a reasoning/tool
          // beat and needs a paragraph boundary. Without this distinction the
          // final reply became `I'll inspect…Now I'll test…Done` while the web
          // channel correctly kept repainting one growing bubble.
          const envelopeText = content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("");
          if (envelopeText) {
            lastTextEnvelope = envelopeText;
            if (textOut && !textOut.endsWith("\n") && !envelopeText.startsWith("\n")) {
              textOut = `${textOut.replace(/[ \t]+$/, "")}\n\n${envelopeText.replace(/^[ \t]+/, "")}`;
            } else {
              textOut += envelopeText;
            }
            // Liveness: hand the caller the reply accumulated SO FAR (not the
            // delta) so a channel can repaint one growing bubble. A throwing
            // consumer must never kill the turn.
            if (onText) {
              try {
                onText(textOut);
              } catch {
                /* streaming consumer error must not kill the turn */
              }
            }
          }
          for (const block of content) {
            if (block.type === "text") {
              continue;
            } else if (block.type === "thinking" || block.type === "redacted_thinking") {
              // Extended thinking. Redacted blocks carry no readable text, so
              // they surface as a bare "thinking" beat rather than nothing - the
              // point is liveness, not content.
              if (onThinking) {
                try {
                  onThinking(typeof block.thinking === "string" ? block.thinking : "");
                } catch {
                  /* streaming consumer error must not kill the turn */
                }
              }
            } else if (block.type === "tool_use") {
              toolUses.push({ name: block.name, id: block.id });
              if (onTool) {
                try {
                  onTool({ name: block.name, id: block.id });
                } catch {
                  /* streaming consumer error must not kill the turn */
                }
              }
            }
          }
        } else if (type === "result") {
          const usage = msg.usage ?? {};
          const turnTokens = (usage.output_tokens ?? 0) + (usage.input_tokens ?? 0) || (usage.total_tokens ?? 0);
          session.usedTokens += turnTokens;
          if (msg.subtype === "error_max_turns") stoppedReason = "max_turns";
          else if (typeof msg.subtype === "string" && msg.subtype.startsWith("error")) {
            stoppedReason = stoppedReason ?? msg.subtype;
          }
          // `result.result` is the SDK's canonical final answer. Keep it separate
          // from textOut: that accumulator intentionally contains every interim
          // assistant envelope for the live growing bubble, while persistence and
          // the settled chat must show only the final response. Older SDK/error
          // shapes can omit result, in which case the last textual assistant
          // envelope is the best final answer (or partial answer after Stop).
          if (typeof msg.result === "string" && msg.result.trim()) resultText = msg.result;
          const resultSessionId = validatedSessionId(msg.session_id);
          if (resultSessionId) sessionId = resultSessionId;
        }
        // Hard budget ceiling.
        if (session.budgetTokens != null && session.usedTokens >= session.budgetTokens) {
          stoppedReason = stoppedReason ?? "budget_exceeded";
          break;
        }
      }
    } catch (err) {
      // Aborting the query surfaces here as a throw. That is the outcome the user
      // asked for, not a runtime failure: settle with the partial text.
      if (session.cancelRequested) {
        stoppedReason = "cancelled";
      } else if (stoppedReason !== "max_turns" || !isPostResultMaxTurnsError(err)) {
        // SDK 0.3.179 reports max-turn twice: a structured result followed by this
        // iterator rejection. Normalize only that exact pair into the adapter's
        // documented stoppedReason response. A matching-looking throw without the
        // envelope, or any unrelated post-result error, still rejects.
        await emitEvents(eventNormalizer.runtimeError(err));
        throw err;
      }
    } finally {
      // The turn is over either way - the handle must not stay cancellable.
      session.client = null;
    }

    // A query the user cancelled can also end by simply running out (the aborted
    // generator completes without throwing), so the reason is asserted here too.
    if (session.cancelRequested) stoppedReason = stoppedReason ?? "cancelled";
    await emitEvents(eventNormalizer.finish(stoppedReason));
    session.turns += 1;
    session.sessionId = sessionId;
    // S1b: at the loop boundary, summarize-and-rebuild if usage crossed the
    // threshold. This may reset session.usedTokens to 0 and clear the resume id.
    // Skipped after a cancel: rebuilding fires ANOTHER model call, which is the
    // opposite of what the user just pressed Stop for.
    if (!session.cancelRequested) await this._maybeRebuild(session);
    // Cumulative token usage across this session's turns (additive telemetry, S1a),
    // read AFTER any rebuild - a freshly rebuilt session reports 0.
    return {
      text: resultText || lastTextEnvelope || textOut,
      artifacts: [],
      toolUses,
      stoppedReason,
      usedTokens: session.usedTokens
    };
  }

  // S1b summarize-and-rebuild: when cumulative usage crosses the configured
  // fraction of the context window, ask the model for a focus summary, drop the
  // resume id (fresh SDK context next turn), and seed the next turn with the
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
    session.sessionId = null;
    session.contextSeed = summary && summary.trim() ? summary.trim() : focusText;
    session.usedTokens = 0;
    session.rebuilds += 1;
  }

  // One-shot summary call. Injectable (tests pass opts.summarize); the default
  // reuses the SDK client against the CURRENT (pre-reset) session so it summarizes
  // the conversation so far.
  async _summarize(session, focusText) {
    if (this._summarizeImpl) return this._summarizeImpl(session, focusText);
    const prompt = `${focusText}\n\nSummarize the conversation so far into a compact briefing that preserves the above. Output only the briefing.`;
    const client = await this._createClient({ prompt, options: this.buildQueryOptions(session) });
    let out = "";
    for await (const msg of client) {
      const type = msg?.type;
      if (type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text") out += block.text;
        }
      } else if (type === "result") {
        if (!out && typeof msg.result === "string") out = msg.result;
      }
    }
    return out;
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
    // Back-compat: teardown still aborts nothing (cancel() is the abort primitive),
    // but it releases the query handle so a torn-down session never pins one.
    if (session) session.client = null;
  }
}
