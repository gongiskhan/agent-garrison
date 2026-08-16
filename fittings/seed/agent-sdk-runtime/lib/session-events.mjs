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

export function clampSessionText(value) {
  const text = String(value ?? "");
  return text.length > SESSION_TEXT_BLOCK_CAP
    ? `${text.slice(0, SESSION_TEXT_BLOCK_CAP)}\n… [truncated ${text.length - SESSION_TEXT_BLOCK_CAP} chars]`
    : text;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampFor(message, now) {
  const parsed = Date.parse(message?.timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : now();
}

function sessionIdFor(message, fallback = null) {
  const value = typeof message?.session_id === "string" ? message.session_id.trim() : "";
  return value || fallback || null;
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
  constructor({ turnId = null, sessionId = null, now = () => Date.now() } = {}) {
    this.turnId = turnId == null ? null : String(turnId);
    this.sessionId = sessionId == null ? null : String(sessionId);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.nextOrder = 1;
    this.fallbackId = 1;
    this.meta = new Map();
    this.assistant = new Map();
    this.currentAssistantId = null;
    this.terminalEmitted = false;
  }

  _event(id, role, ts, blocks, extra = {}) {
    const stableId = String(id || `session:${this.turnId ?? "turn"}:${this.fallbackId++}`);
    let meta = this.meta.get(stableId);
    if (!meta) {
      meta = { order: this.nextOrder++, revision: 0 };
      this.meta.set(stableId, meta);
    }
    meta.revision += 1;
    return {
      id: stableId,
      role,
      ts,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(extra.sessionId || this.sessionId ? { sessionId: extra.sessionId || this.sessionId } : {}),
      order: meta.order,
      revision: meta.revision,
      ...(extra.toolResultsOnly ? { toolResultsOnly: true } : {}),
      blocks
    };
  }

  _assistantState(id, ts, sessionId) {
    let state = this.assistant.get(id);
    if (!state) {
      state = { id, ts, sessionId, blocks: [], rawByIndex: new Map(), lastSignature: null };
      this.assistant.set(id, state);
    } else {
      state.ts = ts;
      state.sessionId = sessionId ?? state.sessionId;
    }
    return state;
  }

  _assistantEvent(state) {
    const blocks = state.blocks.filter(Boolean);
    const signature = JSON.stringify(blocks);
    if (signature === state.lastSignature) return null;
    state.lastSignature = signature;
    return this._event(state.id, "assistant", state.ts, blocks, {
      sessionId: state.sessionId
    });
  }

  _partial(message) {
    const raw = message?.event ?? {};
    const ts = timestampFor(message, this.now);
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;

    if (raw.type === "message_start") {
      const id = raw.message?.id ?? message.uuid ?? `assistant:${this.fallbackId++}`;
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
    const id = message?.message?.id ?? this.currentAssistantId ?? message?.uuid ?? `assistant:${this.fallbackId++}`;
    const state = this._assistantState(String(id), ts, sessionId);
    const blocks = contentArray(message?.message?.content).map(settledBlock).filter(Boolean);
    if (message?.error) {
      blocks.push({
        type: "error",
        kind: String(message.error),
        text: `Assistant request failed: ${String(message.error)}.`
      });
    }
    if (blocks.length === 0) {
      blocks.push({
        type: "status",
        status: "assistant",
        subtype: "empty",
        text: "Assistant emitted an empty message."
      });
    }
    if (blocksEqual(state.blocks.filter(Boolean), blocks)) return [];
    state.blocks = blocks;
    state.rawByIndex.clear();
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
    const id = message?.message?.id ?? message?.uuid ?? `user:${this.fallbackId++}`;
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
      ...(typeof info.isUsingOverage === "boolean" ? { isUsingOverage: info.isUsingOverage } : {})
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

  _result(message) {
    const subtype = String(message?.subtype ?? "result");
    const isError = message?.is_error === true || subtype.startsWith("error");
    const errors = Array.isArray(message?.errors)
      ? message.errors.map((value) => clampSessionText(value)).filter(Boolean)
      : [];
    const blocks = [];
    if (isError) {
      blocks.push({
        type: "error",
        kind: subtype,
        text: clampSessionText(errors.join("\n") || `Session ended with ${subtype}.`)
      });
    }
    blocks.push({
      type: "turn_end",
      status: isError ? "error" : "completed",
      subtype,
      stopReason: message?.stop_reason == null ? null : String(message.stop_reason),
      ...(typeof message?.result === "string" && message.result ? { result: clampSessionText(message.result) } : {}),
      ...(errors.length ? { errors } : {})
    });
    this.terminalEmitted = true;
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;
    return [this._event(message?.uuid ?? `turn:${this.turnId ?? "turn"}:end`, "assistant", timestampFor(message, this.now), blocks, { sessionId })];
  }

  _system(message) {
    const subtype = String(message?.subtype ?? message?.type ?? "system");
    const sessionId = sessionIdFor(message, this.sessionId);
    if (sessionId) this.sessionId = sessionId;
    if (subtype === "permission_denied") {
      return [
        this._event(message?.uuid, "assistant", timestampFor(message, this.now), [
          {
            type: "error",
            kind: "permission_denied",
            text: clampSessionText(message?.message || `${message?.tool_name ?? "Tool"} permission was denied.`)
          }
        ], { sessionId })
      ];
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
    if (message.type === "stream_event") return this._partial(message);
    if (message.type === "assistant") return this._settledAssistant(message);
    if (message.type === "user") return this._user(message);
    if (message.type === "rate_limit_event") return this._rateLimit(message);
    if (message.type === "tool_progress") return this._toolProgress(message);
    if (message.type === "result") return this._result(message);
    return this._system(message);
  }

  runtimeError(error) {
    const text = clampSessionText(error instanceof Error ? error.message : error);
    const alreadyTerminal = this.terminalEmitted;
    this.terminalEmitted = true;
    const blocks = [
      { type: "error", kind: "runtime_error", text: text || "Unknown runtime error." }
    ];
    // A result can be followed by an unrelated subprocess/iterator failure. The
    // result remains the turn boundary, but the later crash must still be visible;
    // only add a second boundary when no result was seen at all.
    if (!alreadyTerminal) {
      blocks.push({ type: "turn_end", status: "error", subtype: "runtime_error", stopReason: "runtime_error" });
    }
    return [
      this._event(`turn:${this.turnId ?? "turn"}:error`, "assistant", this.now(), blocks)
    ];
  }

  finish(stoppedReason = null) {
    if (this.terminalEmitted) return [];
    this.terminalEmitted = true;
    const cancelled = stoppedReason === "cancelled";
    const errored = stoppedReason != null && !cancelled;
    return [
      this._event(`turn:${this.turnId ?? "turn"}:end`, "assistant", this.now(), [
        {
          type: "turn_end",
          status: cancelled ? "cancelled" : errored ? "error" : "completed",
          subtype: stoppedReason ?? "stream_complete",
          stopReason: stoppedReason
        }
      ])
    ];
  }
}

export function createAgentSdkSessionEventNormalizer(options = {}) {
  return new AgentSdkSessionEventNormalizer(options);
}

export function normalizeAgentSdkMessages(messages, options = {}) {
  const normalizer = createAgentSdkSessionEventNormalizer(options);
  const events = [];
  for (const message of messages ?? []) events.push(...normalizer.push(message));
  return events;
}
