import { ClaudeCodeAdapter } from "@garrison/claude-pty";

// `/effort auto` is Claude Code's native reset-to-model-default control. The
// remaining values mirror the repository's routing effort vocabulary.
export const CLAUDE_CHAT_EFFORTS = Object.freeze([
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export const CLAUDE_CHAT_CONTROL_SETTLE_MS = 250;

const effortSet = new Set(CLAUDE_CHAT_EFFORTS);
const adapter = new ClaudeCodeAdapter();
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Claude message was cancelled before submission");
  error.name = "AbortError";
  error.code = "claude_message_cancelled";
  throw error;
}

/** Per-PTY admission latch. `begin` runs before request-body parsing so a Stop
 * racing that await still owns the exact pending submission. */
export function createClaudeMessageGate() {
  const pending = new Map();
  return {
    begin(sessionId) {
      if (pending.has(sessionId)) return null;
      const controller = new AbortController();
      pending.set(sessionId, controller);
      return {
        signal: controller.signal,
        release() {
          if (pending.get(sessionId) === controller) pending.delete(sessionId);
        },
      };
    },
    interrupt(sessionId) {
      const controller = pending.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}

export function isClaudeChatEffort(value) {
  return typeof value === "string" && effortSet.has(value);
}

/**
 * Apply an optional native effort control, let the TUI settle, then submit the
 * exact visible message. The strict vocabulary is the injection boundary: no
 * unvalidated request value can become a slash command.
 */
export async function writeClaudeChatMessage(
  pty,
  text,
  { effort, delayMs = 600, wait = defaultWait, signal } = {}
) {
  if (!pty || typeof pty.write !== "function") throw new TypeError("writable PTY required");
  if (effort !== undefined && !isClaudeChatEffort(effort)) {
    throw new RangeError(`unsupported effort: ${String(effort)}`);
  }
  throwIfCancelled(signal);
  if (effort !== undefined) {
    await adapter.setEffort({ writeKeys: (keys) => pty.write(keys) }, effort);
    await wait(CLAUDE_CHAT_CONTROL_SETTLE_MS);
    throwIfCancelled(signal);
  }
  pty.write(text);
  await wait(delayMs);
  throwIfCancelled(signal);
  pty.write("\r");
}
