// Idle-based JSONL session log watcher (interactive mode only).
// Polls the file's mtime + size; after IDLE_MS of no growth, extracts the
// most recent assistant text content as the session's "turn summary".
//
// Path layout (Spike F finding):
//   ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
// Function:
//   cwd.replaceAll("/", "-") — leading dash IS retained.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const POLL_MS = 1000;
const DEFAULT_IDLE_MS = 30_000;

export function projectDirForCwd(cwd) {
  return cwd.replaceAll("/", "-");
}

export function jsonlPath(cwd, sessionId) {
  return path.join(os.homedir(), ".claude", "projects", projectDirForCwd(cwd), `${sessionId}.jsonl`);
}

export class JsonlWatcher {
  constructor({ idleMs } = {}) {
    const envIdle = Number(process.env.GARRISON_JSONL_IDLE_MS);
    this.idleMs = idleMs ?? (Number.isFinite(envIdle) && envIdle > 0 ? envIdle : DEFAULT_IDLE_MS);
    /** @type {Map<string, WatcherState>} */
    this.active = new Map();
  }

  install({ sessionId, cwd, onIdleSummary }) {
    if (this.active.has(sessionId)) return;
    const filePath = jsonlPath(cwd, sessionId);
    /** @type {WatcherState} */
    const state = {
      sessionId,
      filePath,
      lastSize: 0,
      lastMtime: 0,
      lastWriteAt: Date.now(),
      onIdleSummary,
      stopped: false,
      timer: null
    };
    state.timer = setInterval(() => this._tick(state), POLL_MS);
    state.timer.unref?.();
    this.active.set(sessionId, state);
  }

  uninstall(sessionId) {
    const state = this.active.get(sessionId);
    if (!state) return;
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    this.active.delete(sessionId);
  }

  async _tick(state) {
    if (state.stopped) return;
    let stat;
    try { stat = fs.statSync(state.filePath); } catch { return; /* file doesn't exist yet */ }
    const grew = stat.size > state.lastSize || stat.mtimeMs > state.lastMtime;
    if (grew) {
      state.lastSize = stat.size;
      state.lastMtime = stat.mtimeMs;
      state.lastWriteAt = Date.now();
      return;
    }
    const idleFor = Date.now() - state.lastWriteAt;
    if (idleFor < this.idleMs) return;
    // Idle threshold reached. Read JSONL, extract last assistant text.
    state.lastWriteAt = Date.now(); // reset, fire once per idle window
    try {
      const summary = await extractLastAssistantText(state.filePath);
      if (summary) {
        try { state.onIdleSummary(summary); } catch { /* ignore */ }
      }
    } catch { /* ignore read errors */ }
  }
}

export async function extractLastAssistantText(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const isAssistant =
      ev.type === "assistant" ||
      ev?.message?.role === "assistant";
    if (!isAssistant) continue;
    const content = ev?.message?.content ?? ev.content ?? [];
    if (Array.isArray(content)) {
      const texts = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text);
      if (texts.length > 0) return texts.join("\n").trim();
    } else if (typeof content === "string") {
      return content.trim();
    }
  }
  return null;
}
