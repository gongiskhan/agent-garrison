// Per-turn completion detection. Ported from
// ekoa-core/src/backends/claude-code-pty/detection.ts with two Garrison
// additions:
//
//  1. Streaming hook: `onTurnEvent(ev)` fires for every new JSONL event seen
//     during the turn. This is the whole streaming design — the gateway maps
//     events to SSE chunks as they land, no separate tail loop.
//
//  2. Signal-C (command-only fast path): slash commands that don't run a
//     model turn (/context, /help, custom commands that just print) never
//     emit `turn_duration` (Signal-B) and would otherwise wait out the 60s
//     Signal-A window. When `commandMode` is true we complete fast on
//     local-command evidence + JSONL quiet + cursor idle + prompt visible,
//     OR — for commands that write nothing to JSONL — on a screen-diff after
//     a short idle. If an assistant event appears (the command expanded into
//     a real prompt) we cancel C and defer to Signal-B.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonlFrom } from "./jsonl.mjs";
import { getCursorPosition, getLastRows, getScreenRows } from "./pty.mjs";

// The claude TUI input box renders as a line that STARTS with "❯ " (or "> ")
// — often followed by a "Try ..." placeholder, so a trailing-symbol match
// isn't enough. We match the prompt char at the start of any of the last
// rows, plus the classic trailing-prompt and shell-$ forms.
const PROMPT_PATTERNS = [/^\s*[>❯]\s/m, /[>❯?]\s*$/, /\$\s*$/, /claude.*>/i];

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "");
}

export function detectPromptReady(lastRows) {
  const clean = stripAnsi(lastRows);
  return PROMPT_PATTERNS.some((p) => p.test(clean));
}

export function listJsonlFiles(projectDir) {
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(projectDir, f));
}

export function findNewestJsonl(projectDir, knownFiles) {
  const files = listJsonlFiles(projectDir);
  const newFiles = files.filter((f) => !knownFiles.has(f));
  if (newFiles.length === 0) return null;
  return newFiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** True when `text` is a single-line slash command (e.g. "/context"). */
export function isCommandMessage(text) {
  const t = (text ?? "").trim();
  return t.startsWith("/") && !t.includes("\n");
}

const LOCAL_CMD_MARKERS = /<local-command-stdout>|<command-name>|<command-message>|local[_-]command/i;

function eventLooksLikeCommandOutput(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (ev.type === "system" && typeof ev.subtype === "string" && /command/i.test(ev.subtype)) return true;
  const blob =
    typeof ev.content === "string"
      ? ev.content
      : typeof ev.message?.content === "string"
        ? ev.message.content
        : "";
  return LOCAL_CMD_MARKERS.test(blob);
}

/**
 * Wait for the current turn to end.
 *
 *  Signal B (primary): `turn_duration` / `stop_hook_summary` in JSONL.
 *  Signal A (fallback): visual idle + prompt visible, only after
 *    `signalAFallbackAfterMs` with assistant text seen this turn.
 *  Signal C (command fast path, commandMode only): local-command evidence +
 *    JSONL quiet + cursor idle + prompt, OR screen-diff after idle for
 *    no-JSONL commands. Cancelled if an assistant event appears.
 *
 * @returns {Promise<CompletionResult>}
 */
export async function waitForCompletion(handle, opts) {
  const fallbackAfter = opts.signalAFallbackAfterMs ?? 60_000;
  const { startTs, timeout, projectDir, knownFiles, commandMode = false, onTurnEvent } = opts;
  let currentJsonlPath = opts.jsonlPath;
  let jsonlOffset = opts.jsonlStartOffset;
  let parseFromOffset = currentJsonlPath ? opts.jsonlStartOffset : 0;
  let signalAMs = null;
  let signalBMs = null;
  let turnStartedAt = null;
  let assistantSeenInTurn = false;
  let lastCursorPos = getCursorPosition(handle);
  let cursorIdleStart = null;

  // Signal-C state
  const screenBefore = commandMode ? stripAnsi(getScreenRows(handle).join("\n")) : "";
  let commandEvidence = false;
  let lastJsonlEventAt = null;

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (signal) => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer250);
      clearInterval(timer500);
      const elapsed = Date.now() - startTs;
      resolve({
        signal,
        elapsedMs: elapsed,
        signalAMs,
        signalBMs,
        jsonlPath: currentJsonlPath,
        parseFromOffset,
        turnStartSeen: turnStartedAt !== null,
        assistantSeenInTurn,
        commandEvidence,
        screenBefore,
      });
    };

    const timer250 = setInterval(() => {
      if (resolved) return;
      const now = Date.now();
      const elapsed = now - startTs;
      if (elapsed > timeout) {
        finish("timeout");
        return;
      }

      const pos = getCursorPosition(handle);
      const moved = pos.x !== lastCursorPos.x || pos.y !== lastCursorPos.y;
      if (moved) {
        cursorIdleStart = null;
        lastCursorPos = pos;
      } else if (cursorIdleStart === null) {
        cursorIdleStart = now;
      }

      // Signal A fallback.
      if (
        signalBMs === null &&
        elapsed >= fallbackAfter &&
        turnStartedAt !== null &&
        assistantSeenInTurn &&
        cursorIdleStart !== null &&
        now - cursorIdleStart >= 8000
      ) {
        const lastRows = getLastRows(handle, 5);
        if (detectPromptReady(lastRows)) {
          signalAMs = elapsed;
          finish("A");
          return;
        }
      }

      // Signal C — command fast path. Never fires once an assistant event was
      // seen (that means the command ran a real model turn → wait for B).
      if (commandMode && !assistantSeenInTurn) {
        const cursorIdleMs = cursorIdleStart !== null ? now - cursorIdleStart : 0;
        const jsonlQuietMs = lastJsonlEventAt !== null ? now - lastJsonlEventAt : Infinity;
        const promptVisible = detectPromptReady(getLastRows(handle, 5));

        // C1: command wrote to JSONL, then went quiet, screen idle, prompt back.
        if (
          elapsed >= 2000 &&
          commandEvidence &&
          jsonlQuietMs >= 1500 &&
          cursorIdleMs >= 1500 &&
          promptVisible
        ) {
          finish("C");
          return;
        }

        // C2: command wrote nothing to JSONL (e.g. /help overlay). After a
        // longer idle with the screen changed and the cursor settled, take a
        // screen-diff as the reply.
        if (
          elapsed >= 12_000 &&
          !commandEvidence &&
          cursorIdleMs >= 5000 &&
          promptVisible
        ) {
          finish("C");
          return;
        }
      }
    }, 250);

    const timer500 = setInterval(() => {
      if (resolved) return;
      const elapsed = Date.now() - startTs;

      if (currentJsonlPath === null && projectDir !== undefined && knownFiles !== undefined) {
        const newFile = findNewestJsonl(projectDir, knownFiles);
        if (newFile !== null) {
          currentJsonlPath = newFile;
          knownFiles.add(newFile);
          jsonlOffset = 0;
          parseFromOffset = 0;
        }
      }

      if (currentJsonlPath === null) return;

      const { events, newOffset } = readJsonlFrom(currentJsonlPath, jsonlOffset);
      jsonlOffset = newOffset;

      for (const ev of events) {
        if (onTurnEvent) {
          try {
            onTurnEvent(ev);
          } catch {
            /* streaming consumer error must not kill detection */
          }
        }
        if (commandMode) {
          lastJsonlEventAt = Date.now();
          if (eventLooksLikeCommandOutput(ev)) commandEvidence = true;
        }
        const t = ev?.type;
        if (t === "user") {
          const c = ev.message?.content;
          if (typeof c === "string" && turnStartedAt === null) {
            turnStartedAt = Date.now();
          }
        } else if (t === "assistant") {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
                assistantSeenInTurn = true;
              }
            }
          }
        } else if (t === "system") {
          const sub = ev.subtype;
          if (sub === "turn_duration" || sub === "stop_hook_summary") {
            if (signalBMs === null) {
              signalBMs = elapsed;
              finish("B");
              return;
            }
          }
        }
      }
    }, 500);
  });
}
