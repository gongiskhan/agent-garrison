// Runtime-neutral session-event normalization for Agent SDK channels.
//
// The SDK emits a mixture of partial Anthropic stream frames, settled assistant
// messages, user-shaped tool results, and top-level runtime/control messages.
// Channels should not need to understand any of those provider shapes. This
// normalizer turns them into the same block vocabulary used by Claude's on-disk
// transcript parser. Logical events are revisioned snapshots: partial and final
// assistant messages reuse the model message id, so consumers can replace an
// earlier revision without duplicating content.

export const SESSION_TEXT_BLOCK_CAP = 20_000;

// Refusal fallback references SDK wire UUIDs, while channel state is keyed by
// canonical event ids (for example, the model message id shared by every
// partial revision). Keep only a bounded turn-local alias table: a fallback can
// retract recent content without letting a hostile/buggy stream grow durable
// state without limit.
const WIRE_ALIAS_CAP = 512;
const RETRACTION_CAP = 64;

export function clampSessionText(value) {
  const text = String(value ?? "");
  return text.length > SESSION_TEXT_BLOCK_CAP
    ? `${text.slice(0, SESSION_TEXT_BLOCK_CAP)}\n… [truncated ${text.length - SESSION_TEXT_BLOCK_CAP} chars]`
    : text;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? clampSessionText(value.trim()) : null;
}

function optionalLabel(value, max = 200) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function optionalId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= 256 ? id : null;
}

function optionalHttpStatus(value) {
  const status = finiteNumber(value);
  return status !== null && status >= 100 && status <= 599 ? status : null;
}

const ASSISTANT_ERROR_KIND = Object.freeze({
  authentication_failed: "authentication",
  oauth_org_not_allowed: "authorization",
  billing_error: "billing",
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  invalid_request: "invalid_request",
  model_not_found: "not_found",
  server_error: "transport",
  unknown: "unknown",
  max_output_tokens: "limit"
});

const RETRYABLE_ASSISTANT_ERRORS = new Set(["rate_limit", "overloaded", "server_error"]);

function assistantFailure(message) {
  const code = optionalLabel(message?.error) ?? "unknown";
  const requestId = optionalId(message?.request_id);
  return {
    source: "assistant",
    kind: ASSISTANT_ERROR_KIND[code] ?? "unknown",
    code,
    text: `Assistant request failed: ${code}.`,
    retryable: RETRYABLE_ASSISTANT_ERRORS.has(code),
    ...(requestId ? { requestId } : {})
  };
}

function resultFailure(message, stoppedReason, errors) {
  if (stoppedReason === "cancelled") return null;
  const subtype = String(message?.subtype ?? "result");
  const providerError = message?.is_error === true || subtype.startsWith("error");
  if (!providerError && stoppedReason == null) return null;

  if (!providerError) {
    const code = String(stoppedReason ?? "runtime_error");
    return {
      source: "system",
      kind: code === "budget_exceeded" ? "limit" : "execution",
      code,
      text: `Session ended with ${code}.`,
      retryable: false
    };
  }

  const kinds = {
    error_during_execution: "execution",
    error_max_turns: "limit",
    error_max_budget_usd: "limit",
    error_max_structured_output_retries: "limit"
  };
  const httpStatus = optionalHttpStatus(message?.api_error_status);
  return {
    source: "result",
    kind: kinds[subtype] ?? "execution",
    code: subtype,
    text: clampSessionText(errors.join("\n") || `Session ended with ${subtype}.`),
    retryable: httpStatus === 429 || (httpStatus !== null && httpStatus >= 500),
    ...(httpStatus !== null ? { httpStatus } : {})
  };
}

function runtimeFailure(error, overrides = {}) {
  const value = error instanceof Error ? error : new Error(String(error ?? "Unknown runtime error."));
  const code = optionalLabel(overrides.code) ?? optionalLabel(value.code) ?? "runtime_error";
  const requestId = optionalId(overrides.requestId ?? value.request_id ?? value.requestId);
  const httpStatus = optionalHttpStatus(overrides.httpStatus ?? value.status ?? value.statusCode);
  const retryAt = finiteNumber(overrides.retryAt ?? value.retryAt);
  return {
    source: optionalLabel(overrides.source) ?? "runtime",
    kind: optionalLabel(overrides.kind) ?? "runtime",
    code,
    text: clampSessionText(value.message || "Unknown runtime error."),
    retryable: overrides.retryable === true || httpStatus === 429 || (httpStatus !== null && httpStatus >= 500),
    ...(requestId ? { requestId } : {}),
    ...(httpStatus !== null ? { httpStatus } : {}),
    ...(retryAt !== null ? { retryAt } : {})
  };
}

function errorBlock(failure) {
  return { type: "error", ...failure };
}

function timestampFor(message, now) {
  const parsed = Date.parse(message?.timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : now();
}

function sessionIdFor(message, fallback = null) {
  const value = typeof message?.session_id === "string" ? message.session_id.trim() : "";
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return value;
  const fallbackValue = typeof fallback === "string" ? fallback.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fallbackValue) ? fallbackValue : null;
}

function stringifyInput(value) {
  try {
    return clampSessionText(JSON.stringify(value ?? {}, null, 2));
  } catch {
    return clampSessionText(value);
  }
}

function statusText(message) {
  const subtype = String(message?.subtype ?? message?.type ?? "message");
  if (subtype === "init") {
    const model = typeof message?.model === "string" && message.model ? ` (${message.model})` : "";
    return `Session initialized${model}.`;
  }
  if (subtype === "status") {
    return message?.status ? `Session status: ${message.status}.` : "Session status: idle.";
  }
  if (subtype === "hook_started") return "Hook started.";
  if (subtype === "hook_response") return "Hook completed.";
  if (subtype === "api_retry") {
    const attempt = finiteNumber(message?.attempt);
    const max = finiteNumber(message?.max_retries);
    const suffix = attempt !== null && max !== null ? ` (${attempt}/${max})` : "";
    return `API request retrying${suffix}.`;
  }
  if (typeof message?.message === "string" && message.message.trim()) return clampSessionText(message.message);
  if (typeof message?.text === "string" && message.text.trim()) return clampSessionText(message.text);
  if (typeof message?.summary === "string" && message.summary.trim()) return clampSessionText(message.summary);
  return `Session event: ${subtype}.`;
}

function imageFromContent(item) {
  if (item?.type !== "image" || item.source?.type !== "base64" || !item.source.data) return null;
  return {
    mediaType: item.source.media_type ?? "image/jpeg",
    data: String(item.source.data)
  };
}

function toolResultBlock(block) {
  const texts = [];
  const images = [];
  const content = Array.isArray(block?.content)
    ? block.content
    : typeof block?.content === "string"
      ? [{ type: "text", text: block.content }]
      : [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
    const image = imageFromContent(item);
    if (image) images.push(image);
  }
  return {
    type: "tool_result",
    toolUseId: block?.tool_use_id ?? null,
    isError: block?.is_error === true,
    text: clampSessionText(texts.join("\n")),
    images
  };
}

function settledBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: clampSessionText(block.text) };
  }
  if (block.type === "thinking") {
    return { type: "thinking", text: clampSessionText(block.thinking ?? block.text ?? "") };
  }
  if (block.type === "redacted_thinking") {
    return { type: "thinking", text: "[redacted thinking]" };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      toolUseId: block.id ?? null,
      name: String(block.name ?? "tool"),
      input: stringifyInput(block.input)
    };
  }
  if (block.type === "tool_result") return toolResultBlock(block);
  return {
    type: "status",
    status: "message",
    subtype: String(block.type ?? "unknown_block"),
    text: `Unhandled message block: ${String(block.type ?? "unknown")}.`
  };
}

function contentArray(content) {
  if (Array.isArray(content)) return content;
  return typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function blocksEqual(left, right) {
  // Normalized blocks contain JSON primitives only. Comparing their serialized
  // forms lets a settled envelope that adds no information avoid a redundant
  // revision while still replacing partial input/text whenever it differs.
  return JSON.stringify(left) === JSON.stringify(right);
}

export class AgentSdkSessionEventNormalizer {
  constructor({ turnId = null, generationId = null, sessionId = null, model = null, eventScope = null, now = () => Date.now() } = {}) {
    this.turnId = turnId == null ? null : String(turnId);
    // The adapter creates one normalizer per gateway generation in both one-shot
    // and standing modes, so every generated terminal snapshot has one durable
    // owner even when browser-local turn counters restart.
    this.generationId = generationId == null ? null : String(generationId);
    this.sessionId = sessionIdFor({ session_id: sessionId }, null);
    this.model = optionalLabel(model);
    // Browser-local turn counters restart after a remount, so they cannot
    // namespace fallback event ids. Provider message ids remain authoritative;
    // only locally synthesized ids use this per-normalizer scope.
    this.eventScope = eventScope == null || String(eventScope).trim() === ""
      ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      : String(eventScope);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.nextOrder = 1;
    this.fallbackId = 1;
    this.meta = new Map();
    this.assistant = new Map();
    this.permissions = new Map();
    this.wireAliases = new Map();
    this.currentAssistantId = null;
    this.terminalEmitted = false;
    this.terminalStatus = null;
    this.failure = null;
    const terminalOwner = this.generationId
      ? [this.generationId]
      : [this.eventScope, this.turnId ?? "turn"];
    this.terminalId = `terminal:${JSON.stringify(terminalOwner)}`;
  }

  _fallbackStableId(kind) {
    return `${kind}:${this.eventScope}:${this.turnId ?? "turn"}:${this.fallbackId++}`;
  }

  _event(id, role, ts, blocks, extra = {}) {
    const stableId = String(id || this._fallbackStableId("session"));
    let meta = this.meta.get(stableId);
    if (!meta) {
      meta = { order: this.nextOrder++, revision: 0, ts };
      this.meta.set(stableId, meta);
    }
    meta.revision += 1;
    return {
      id: stableId,
      role,
      // Revisions are snapshots of one logical event. Its placement and creation
      // time must not jump every time a partial message is repainted.
      ts: meta.ts,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(this.generationId ? { generationId: this.generationId } : {}),
      ...(extra.sessionId || this.sessionId ? { sessionId: extra.sessionId || this.sessionId } : {}),
      order: meta.order,
      revision: meta.revision,
      ...(extra.toolResultsOnly ? { toolResultsOnly: true } : {}),
      ...(Array.isArray(extra.retracts) && extra.retracts.length ? { retracts: extra.retracts } : {}),
      blocks
    };
  }

  _rememberWireAlias(wireUuid, canonicalIds) {
    const wire = optionalId(wireUuid);
    const ids = [...new Set((canonicalIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 4);
    if (!wire || ids.length === 0) return;
    // Refresh insertion order for a repeated UUID without growing the map.
    if (this.wireAliases.has(wire)) this.wireAliases.delete(wire);
    this.wireAliases.set(wire, ids);
    while (this.wireAliases.size > WIRE_ALIAS_CAP) {
      this.wireAliases.delete(this.wireAliases.keys().next().value);
    }
  }

  _resolveRetractions(wireUuids, excludeId = null) {
    if (!Array.isArray(wireUuids)) return [];
    const resolved = [];
    const seen = new Set();
    for (const wireUuid of wireUuids.slice(0, RETRACTION_CAP)) {
      const wire = optionalId(wireUuid);
      if (!wire) continue;
      for (const id of this.wireAliases.get(wire) ?? []) {
        if (id === excludeId || seen.has(id)) continue;
        seen.add(id);
        resolved.push(id);
        if (resolved.length >= RETRACTION_CAP) return resolved;
      }
    }
    return resolved;
  }

  _observeAttribution(message) {
    const sessionId = sessionIdFor(message, null);
    if (sessionId) this.sessionId = sessionId;
    const model = message?.subtype === "model_refusal_fallback"
      ? optionalLabel(message?.fallback_model)
      : message?.type === "assistant"
        ? optionalLabel(message?.message?.model)
        : message?.type === "stream_event" && message?.event?.type === "message_start"
          ? optionalLabel(message?.event?.message?.model)
          : message?.subtype === "init"
            ? optionalLabel(message?.model)
            : null;
    if (model) this.model = model;
  }

  _assistantState(id, ts, sessionId) {
    let state = this.assistant.get(id);
    if (!state) {
      state = { id, ts, sessionId, blocks: [], retracts: [], rawByIndex: new Map(), lastSignature: null };
      this.assistant.set(id, state);
    } else {
      state.sessionId = sessionId ?? state.sessionId;
    }
    return state;
  }

  _assistantEvent(state) {
    const blocks = state.blocks.filter(Boolean);
    const signature = JSON.stringify([blocks, state.retracts]);
    if (signature === state.lastSignature) return null;
    state.lastSignature = signature;
    return this._event(state.id, "assistant", state.ts, blocks, {
      sessionId: state.sessionId,
      retracts: state.retracts
    });
  }

  _partial(message) {
    const raw = message?.event ?? {};
    const ts = timestampFor(message, this.now);
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;

    if (raw.type === "message_start") {
      const id = raw.message?.id ?? message.uuid ?? this._fallbackStableId("assistant");
      this.currentAssistantId = String(id);
      const state = this._assistantState(this.currentAssistantId, ts, sessionId);
      const initial = contentArray(raw.message?.content).map(settledBlock).filter(Boolean);
      if (initial.length > 0) {
        state.blocks = initial;
        return [this._assistantEvent(state)].filter(Boolean);
      }
      return [];
    }

    const id = this.currentAssistantId;
    if (!id) {
      return [
        this._event(message.uuid, "assistant", ts, [
          {
            type: "status",
            status: "stream",
            subtype: String(raw.type ?? "unknown"),
            text: `Unmatched stream event: ${String(raw.type ?? "unknown")}.`
          }
        ], { sessionId })
      ];
    }
    const state = this._assistantState(id, ts, sessionId);
    const index = Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : 0;

    if (raw.type === "content_block_start") {
      const block = raw.content_block ?? {};
      if (block.type === "text") {
        const text = String(block.text ?? "");
        state.rawByIndex.set(index, { type: "text", text });
        state.blocks[index] = { type: "text", text: clampSessionText(text) };
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        const text = block.type === "redacted_thinking" ? "[redacted thinking]" : String(block.thinking ?? "");
        state.rawByIndex.set(index, { type: "thinking", text });
        state.blocks[index] = { type: "thinking", text: clampSessionText(text) };
      } else if (block.type === "tool_use") {
        const hasInput = block.input && typeof block.input === "object" && Object.keys(block.input).length > 0;
        const input = hasInput ? JSON.stringify(block.input) : "";
        state.rawByIndex.set(index, {
          type: "tool_use",
          toolUseId: block.id ?? null,
          name: String(block.name ?? "tool"),
          input
        });
        state.blocks[index] = {
          type: "tool_use",
          toolUseId: block.id ?? null,
          name: String(block.name ?? "tool"),
          input: clampSessionText(input)
        };
      } else {
        state.rawByIndex.set(index, { type: "status" });
        state.blocks[index] = {
          type: "status",
          status: "message",
          subtype: String(block.type ?? "unknown_block"),
          text: `Unhandled message block: ${String(block.type ?? "unknown")}.`
        };
      }
      return [this._assistantEvent(state)].filter(Boolean);
    }

    if (raw.type === "content_block_delta") {
      const delta = raw.delta ?? {};
      let current = state.rawByIndex.get(index);
      if (delta.type === "text_delta") {
        if (!current || current.type !== "text") current = { type: "text", text: "" };
        current.text += String(delta.text ?? "");
        state.rawByIndex.set(index, current);
        state.blocks[index] = { type: "text", text: clampSessionText(current.text) };
        return [this._assistantEvent(state)].filter(Boolean);
      }
      if (delta.type === "thinking_delta") {
        if (!current || current.type !== "thinking") current = { type: "thinking", text: "" };
        current.text += String(delta.thinking ?? delta.text ?? "");
        state.rawByIndex.set(index, current);
        state.blocks[index] = { type: "thinking", text: clampSessionText(current.text) };
        return [this._assistantEvent(state)].filter(Boolean);
      }
      if (delta.type === "input_json_delta") {
        if (!current || current.type !== "tool_use") {
          current = { type: "tool_use", toolUseId: null, name: "tool", input: "" };
        }
        current.input += String(delta.partial_json ?? "");
        state.rawByIndex.set(index, current);
        state.blocks[index] = {
          type: "tool_use",
          toolUseId: current.toolUseId,
          name: current.name,
          input: clampSessionText(current.input)
        };
        return [this._assistantEvent(state)].filter(Boolean);
      }
      // Signature/ping deltas carry no user-visible session content.
      return [];
    }

    // content_block_stop/message_delta/message_stop are protocol boundaries;
    // the snapshot already contains their visible payload.
    return [];
  }

  _settledAssistant(message) {
    const ts = timestampFor(message, this.now);
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;
    const id = message?.message?.id ?? this.currentAssistantId ?? message?.uuid ?? this._fallbackStableId("assistant");
    const state = this._assistantState(String(id), ts, sessionId);
    this.currentAssistantId = String(id);
    const retracts = this._resolveRetractions(message?.supersedes, state.id);
    if (retracts.length > 0) {
      state.retracts = [...new Set([...state.retracts, ...retracts])].slice(0, RETRACTION_CAP);
    }
    let blocks = contentArray(message?.message?.content).map(settledBlock).filter(Boolean);
    // The CLI settles ONE API message as several assistant envelopes sharing the
    // message id, each carrying a subset of its content - and the thinking block
    // only ever rides the first. A plain replace therefore ERASES the reasoning
    // from the event's final revision (the one every reload renders). Thinking,
    // once seen for a message id, survives every later settle.
    const priorThinking = state.blocks.filter((block) => block?.type === "thinking");
    if (priorThinking.length > 0 && !blocks.some((block) => block?.type === "thinking")) {
      blocks = [...priorThinking, ...blocks];
    }
    if (message?.error) {
      blocks.push(errorBlock(assistantFailure(message)));
    }
    if (blocks.length === 0) {
      blocks.push({
        type: "status",
        status: "assistant",
        subtype: "empty",
        text: "Assistant emitted an empty message."
      });
    }
    if (!blocksEqual(state.blocks.filter(Boolean), blocks)) {
      state.blocks = blocks;
      state.rawByIndex.clear();
    }
    return [this._assistantEvent(state)].filter(Boolean);
  }

  _user(message) {
    const ts = timestampFor(message, this.now);
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;
    const blocks = contentArray(message?.message?.content).map(settledBlock).filter(Boolean);
    if (blocks.length === 0) {
      blocks.push({
        type: "status",
        status: "user",
        subtype: "empty",
        text: "User-shaped SDK message carried no visible content."
      });
    }
    const toolResultsOnly = blocks.every((block) => block.type === "tool_result");
    const id = message?.message?.id ?? message?.uuid ?? this._fallbackStableId("user");
    return [this._event(id, "user", ts, blocks, { sessionId, toolResultsOnly })];
  }

  _rateLimit(message) {
    const info = message?.rate_limit_info ?? {};
    const block = {
      type: "rate_limit",
      status: String(info.status ?? "unknown"),
      ...(typeof info.rateLimitType === "string" ? { rateLimitType: info.rateLimitType } : {}),
      ...(finiteNumber(info.resetsAt) !== null ? { resetsAt: info.resetsAt } : {}),
      ...(finiteNumber(info.utilization) !== null ? { utilization: info.utilization } : {}),
      ...(typeof info.overageStatus === "string" ? { overageStatus: info.overageStatus } : {}),
      ...(finiteNumber(info.overageResetsAt) !== null ? { overageResetsAt: info.overageResetsAt } : {}),
      ...(typeof info.overageDisabledReason === "string" ? { overageDisabledReason: info.overageDisabledReason } : {}),
      ...(typeof info.isUsingOverage === "boolean" ? { isUsingOverage: info.isUsingOverage } : {}),
      ...(typeof info.overageInUse === "boolean" ? { overageInUse: info.overageInUse } : {}),
      ...(finiteNumber(info.surpassedThreshold) !== null ? { surpassedThreshold: info.surpassedThreshold } : {})
    };
    return [
      this._event(message?.uuid, "assistant", timestampFor(message, this.now), [block], {
        sessionId: sessionIdFor(message, this.sessionId)
      })
    ];
  }

  _toolProgress(message) {
    const elapsed = finiteNumber(message?.elapsed_time_seconds);
    const name = String(message?.tool_name ?? "tool");
    const block = {
      type: "tool_progress",
      toolUseId: message?.tool_use_id ?? null,
      name,
      text: `${name} is running.`,
      ...(elapsed !== null && elapsed >= 0 ? { elapsedMs: Math.round(elapsed * 1000) } : {}),
      status: "running",
      ...(typeof message?.task_id === "string" && message.task_id ? { taskId: message.task_id } : {})
    };
    return [
      this._event(message?.uuid, "assistant", timestampFor(message, this.now), [block], {
        sessionId: sessionIdFor(message, this.sessionId)
      })
    ];
  }

  // Tool permission prompts are control-plane events rather than SDK stream
  // messages, but they share the same durable event vocabulary. Keep the first
  // timestamp/order and revise one stable event as the prompt settles so a
  // channel can latest-wins merge live, persisted, and replayed snapshots.
  permissionRequest(request) {
    const requestId = typeof request?.requestId === "string" ? request.requestId.trim() : "";
    const generationId = typeof request?.generationId === "string" ? request.generationId.trim() : "";
    if (!requestId) throw new Error("permission request id is required");
    if (!generationId) throw new Error("permission generation id is required");
    if (this.permissions.has(requestId)) throw new Error(`duplicate permission request id: ${requestId}`);
    const ts = this.now();
    const block = {
      ...request,
      type: "permission_request",
      requestId,
      generationId,
      status: "pending"
    };
    delete block.decision;
    const state = {
      // The SDK request id is not process-global. Include the gateway-owned
      // generation so a later process/turn that reuses an id cannot revise an
      // older durable prompt. JSON tuple encoding is unambiguous even if a
      // provider-supplied id itself contains punctuation.
      id: `permission:${JSON.stringify([generationId, requestId])}`,
      ts,
      sessionId: this.sessionId,
      block
    };
    this.permissions.set(requestId, state);
    return [this._event(state.id, "assistant", state.ts, [{ ...state.block }], { sessionId: state.sessionId })];
  }

  resolvePermissionRequest(requestId, decision) {
    const state = this.permissions.get(String(requestId ?? ""));
    if (!state || state.block.status !== "pending") return [];
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") {
      throw new Error(`invalid permission decision: ${String(decision)}`);
    }
    state.block = { ...state.block, status: "resolved", decision };
    return [this._event(state.id, "assistant", state.ts, [{ ...state.block }], { sessionId: state.sessionId })];
  }

  cancelPermissionRequest(requestId) {
    const state = this.permissions.get(String(requestId ?? ""));
    if (!state || state.block.status !== "pending") return [];
    state.block = { ...state.block, status: "cancelled" };
    delete state.block.decision;
    return [this._event(state.id, "assistant", state.ts, [{ ...state.block }], { sessionId: state.sessionId })];
  }

  _result(message, stoppedReason = null) {
    const providerSubtype = String(message?.subtype ?? "result");
    const cancelled = stoppedReason === "cancelled";
    const forcedError = stoppedReason != null && !cancelled;
    const isError = message?.is_error === true || providerSubtype.startsWith("error") || forcedError;
    const errors = Array.isArray(message?.errors)
      ? message.errors.map((value) => clampSessionText(value)).filter(Boolean)
      : [];
    const failure = resultFailure(message, stoppedReason, errors);
    const blocks = [];
    if (failure) blocks.push(errorBlock(failure));
    blocks.push({
      type: "turn_end",
      status: cancelled ? "cancelled" : isError ? "error" : "completed",
      // Provider facts and host policy are separate. A host budget/cancel reason
      // must never overwrite the SDK's canonical subtype or stop reason.
      subtype: providerSubtype,
      reason: stoppedReason == null ? null : String(stoppedReason),
      stopReason: message?.stop_reason == null ? null : String(message.stop_reason),
      terminalReason: message?.terminal_reason == null ? null : String(message.terminal_reason),
      ...(typeof message?.result === "string" && message.result ? { result: clampSessionText(message.result) } : {}),
      ...(errors.length ? { errors } : {})
    });
    this.terminalEmitted = true;
    this.terminalStatus = cancelled ? "cancelled" : isError ? "error" : "completed";
    this.failure = failure;
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;
    return [this._event(this.terminalId, "assistant", timestampFor(message, this.now), blocks, { sessionId })];
  }

  // SDK queries can keep yielding after `result` (for example, prompt_suggestion
  // can follow it). Adapters buffer that candidate result and call this only at
  // EOF, explicit idle, or the standing-query quiet fallback.
  finishResult(message, stoppedReason = null) {
    if (this.terminalEmitted) return [];
    if (!message || typeof message !== "object") return this.finish(stoppedReason);
    return this._result(message, stoppedReason);
  }

  _apiRetry(message) {
    const attempt = finiteNumber(message?.attempt);
    const maxAttempts = finiteNumber(message?.max_retries);
    const delayMs = finiteNumber(message?.retry_delay_ms);
    const errorStatus = message?.error_status === null ? null : optionalHttpStatus(message?.error_status);
    const errorKind = optionalLabel(message?.error);
    const suffix = attempt !== null && maxAttempts !== null ? ` (${attempt}/${maxAttempts})` : "";
    const delay = delayMs !== null ? ` in ${delayMs} ms` : "";
    const block = {
      type: "retry",
      kind: "api",
      text: `API request retrying${suffix}${delay}.`,
      ...(attempt !== null ? { attempt } : {}),
      ...(maxAttempts !== null ? { maxAttempts } : {}),
      ...(delayMs !== null ? { delayMs } : {}),
      // Preserve the SDK's meaningful null: connection errors have no HTTP
      // response and therefore no status.
      ...(message && Object.hasOwn(message, "error_status") ? { httpStatus: errorStatus } : {}),
      ...(errorKind ? { errorKind } : {})
    };
    return [
      this._event(message?.uuid, "assistant", timestampFor(message, this.now), [block], {
        sessionId: sessionIdFor(message, this.sessionId)
      })
    ];
  }

  _modelFallback(message) {
    const fromModel = optionalLabel(message?.original_model);
    const toModel = optionalLabel(message?.fallback_model);
    const direction = optionalLabel(message?.direction);
    const requestId = optionalId(message?.request_id);
    const text = optionalString(message?.content) ??
      (fromModel && toModel
        ? `${fromModel} refused the request; retrying with ${toModel}.`
        : "The request was refused; retrying with a fallback model.");
    const block = {
      type: "retry",
      kind: "model_fallback",
      text,
      ...(fromModel ? { fromModel } : {}),
      ...(toModel ? { toModel } : {}),
      ...(direction ? { direction } : {}),
      ...(requestId ? { requestId } : {})
    };
    return [
      this._event(message?.uuid, "assistant", timestampFor(message, this.now), [block], {
        sessionId: sessionIdFor(message, this.sessionId),
        retracts: this._resolveRetractions(message?.retracted_message_uuids)
      })
    ];
  }

  _system(message) {
    const subtype = String(message?.subtype ?? message?.type ?? "system");
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;
    if (subtype === "api_retry") return this._apiRetry(message);
    if (subtype === "model_refusal_fallback") return this._modelFallback(message);
    if (subtype === "permission_denied") {
      const failure = {
        source: "system",
        kind: "permission",
        code: "permission_denied",
        text: clampSessionText(message?.message || `${message?.tool_name ?? "Tool"} permission was denied.`),
        retryable: false
      };
      return [
        this._event(message?.uuid, "assistant", timestampFor(message, this.now), [
          errorBlock(failure)
        ], { sessionId })
      ];
    }
    if ((message?.type === "auth_status" && optionalString(message?.error)) || subtype === "mirror_error") {
      const kind = message?.type === "auth_status" ? "authentication" : "transport";
      const failure = {
        source: "system",
        kind,
        code: subtype,
        text: optionalString(message?.error) ?? statusText(message),
        retryable: false
      };
      return [this._event(message?.uuid, "assistant", timestampFor(message, this.now), [errorBlock(failure)], { sessionId })];
    }
    return [
      this._event(message?.uuid, "assistant", timestampFor(message, this.now), [
        {
          type: "status",
          status: subtype === "status" ? String(message?.status ?? "idle") : "runtime",
          subtype,
          text: statusText(message)
        }
      ], { sessionId })
    ];
  }

  push(message) {
    if (!message || typeof message !== "object") {
      return [
        this._event(null, "assistant", this.now(), [
          { type: "status", status: "runtime", subtype: "invalid", text: "SDK emitted an invalid message." }
        ])
      ];
    }
    this._observeAttribution(message);
    let events;
    if (message.type === "stream_event") events = this._partial(message);
    else if (message.type === "assistant") events = this._settledAssistant(message);
    else if (message.type === "user") events = this._user(message);
    else if (message.type === "rate_limit_event") events = this._rateLimit(message);
    else if (message.type === "tool_progress") events = this._toolProgress(message);
    else if (message.type === "result") events = this._result(message);
    else events = this._system(message);

    let canonicalIds = events.map((event) => event.id);
    if (message.type === "assistant") {
      canonicalIds = [String(message?.message?.id ?? this.currentAssistantId ?? message?.uuid ?? "")].filter(Boolean);
    } else if (message.type === "stream_event" && this.currentAssistantId) {
      canonicalIds = [this.currentAssistantId];
    } else if (message.type === "user") {
      canonicalIds = [String(message?.message?.id ?? message?.uuid ?? "")].filter(Boolean);
    }
    this._rememberWireAlias(message?.uuid, canonicalIds);
    return events;
  }

  runtimeError(error, options = {}) {
    const failure = runtimeFailure(error, options);
    const result = options?.resultMessage && typeof options.resultMessage === "object"
      ? options.resultMessage
      : null;
    const errors = Array.isArray(result?.errors)
      ? result.errors.map((value) => clampSessionText(value)).filter(Boolean)
      : [];
    this.terminalEmitted = true;
    this.terminalStatus = "error";
    this.failure = failure;
    const blocks = [
      errorBlock(failure),
      {
        type: "turn_end",
        status: "error",
        subtype: String(result?.subtype ?? "runtime_error"),
        reason: optionalLabel(options?.reason) ?? "runtime_error",
        stopReason: result?.stop_reason == null ? null : String(result.stop_reason),
        terminalReason: result?.terminal_reason == null ? null : String(result.terminal_reason),
        ...(typeof result?.result === "string" && result.result ? { result: clampSessionText(result.result) } : {}),
        ...(errors.length ? { errors } : {})
      }
    ];
    return [
      this._event(this.terminalId, "assistant", this.now(), blocks, {
        sessionId: sessionIdFor(result, this.sessionId)
      })
    ];
  }

  finish(stoppedReason = null) {
    if (this.terminalEmitted) return [];
    this.terminalEmitted = true;
    const cancelled = stoppedReason === "cancelled";
    const errored = stoppedReason != null && !cancelled;
    const failure = errored
      ? resultFailure({ subtype: "stream_complete", is_error: false }, stoppedReason, [])
      : null;
    this.terminalStatus = cancelled ? "cancelled" : errored ? "error" : "completed";
    this.failure = failure;
    const blocks = [];
    if (failure) blocks.push(errorBlock(failure));
    blocks.push(
      {
        type: "turn_end",
        status: this.terminalStatus,
        subtype: "stream_complete",
        reason: stoppedReason == null ? null : String(stoppedReason),
        stopReason: null,
        terminalReason: null
      }
    );
    return [
      this._event(this.terminalId, "assistant", this.now(), blocks)
    ];
  }
}

export function createAgentSdkSessionEventNormalizer(options = {}) {
  return new AgentSdkSessionEventNormalizer(options);
}

export function normalizeAgentSdkMessages(messages, options = {}) {
  const normalizer = createAgentSdkSessionEventNormalizer(options);
  const events = [];
  let resultMessage = null;
  for (const message of messages ?? []) {
    if (message?.type === "result") {
      if (resultMessage) {
        events.push(...normalizer.runtimeError(new Error("SDK message batch contained multiple results"), {
          resultMessage
        }));
        resultMessage = null;
        continue;
      }
      resultMessage = message;
      continue;
    }
    events.push(...normalizer.push(message));
  }
  if (resultMessage) events.push(...normalizer.finishResult(resultMessage));
  return events;
}
