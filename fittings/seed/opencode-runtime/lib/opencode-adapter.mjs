// opencode-adapter.mjs — the OpenCode RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// OpenCode is a SECONDARY runtime that proves multi-provider coding delegation. Like
// Codex, `opencode run` runs non-interactively and reads the prompt from STDIN (no
// positional argument → verified live against opencode 1.17.15), so this is a CLEAN
// non-PTY adapter — no TUI scraping, no standing server. It implements the same
// RuntimeAdapter contract as ClaudeCodeAdapter; the generic pool + runtime-bridge drive
// it unchanged.
//
// `--format json` emits a machine-readable NDJSON event stream (one JSON object per
// line). The assistant text arrives as `{type:"text", part:{type:"text", text}}` events
// and every event carries the top-level `sessionID` OpenCode minted on the first run —
// captured here so follow-up turns resume the same session with `-s`, giving multi-turn
// continuity without any long-lived process.
import { spawn } from "node:child_process";

// Build the `opencode run` invocation. Pure + testable: the prompt travels via STDIN
// (returned separately via stdinFromPrompt, NEVER argv → shell-injection safe under
// bypassPermissions), model via `-m provider/model`, reasoning effort via `--variant`,
// cwd via `--dir`, and session continuation via `-s <sessionId>`. argv NEVER contains
// the prompt.
export function buildRunArgs(config = {}) {
  const argv = ["run", "--format", "json", "--auto"];
  if (config.model) argv.push("-m", config.model);
  if (config.variant) argv.push("--variant", config.variant);
  if (config.compositionDir) argv.push("--dir", config.compositionDir);
  if (config.sessionId) argv.push("-s", config.sessionId);
  // No positional message → opencode reads the prompt from stdin (verified live): the
  // clean, injection-safe channel, identical in spirit to `codex exec -`.
  return { bin: config.bin || "opencode", argv, stdinFromPrompt: true };
}

// Parse opencode's `--format json` output (NDJSON — one event per line). Pulls out the
// assistant text (concatenation of every `type:"text"` event's `part.text`, the shape
// verified live), the session id (top-level `sessionID`, present on every event), and
// any terminal `type:"error"` message (so a code-0 run that only errored doesn't
// silently return empty text). Non-JSON lines are ignored.
export function parseRunOutput(stdout = "") {
  let text = "";
  let sessionId = null;
  let error = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.sessionID && !sessionId) sessionId = ev.sessionID;
    if (ev.type === "text" && typeof ev.part?.text === "string") text += ev.part.text;
    else if (ev.type === "error" && !error) error = ev.error?.data?.message || ev.error?.name || "opencode error";
  }
  return { text, sessionId, error };
}

function defaultRunExec({ bin, argv, env, cwd, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e?.message || e) }));
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export class OpenCodeAdapter {
  constructor(opts = {}) {
    this.id = "opencode";
    this._runExec = opts.runExec ?? defaultRunExec; // injectable for tests
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // opencode run is per-turn one-shot; the "session" carries config + the opencode
    // session id (minted on the first run, captured in awaitResponse for `-s` resume).
    return { config: { ...config }, sessionId: config.sessionId ?? null, alive: true };
  }

  async awaitReady() {
    /* no persistent process to await — each turn is a fresh `opencode run` */
  }

  async sendTurn(session, text) {
    const cfg = { ...session.config, sessionId: session.sessionId ?? session.config.sessionId ?? null };
    const { bin, argv } = buildRunArgs(cfg);
    this._pending.set(
      session,
      this._runExec({ bin, argv, env: session.config.env ?? process.env, cwd: session.config.compositionDir, stdin: text })
    );
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("OpenCodeAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
    if (r.code !== 0) throw new Error(`opencode run exited ${r.code}: ${String(r.stderr).slice(0, 200)}`);
    const raw = r.stdout ?? "";
    const { text, sessionId, error } = parseRunOutput(raw);
    // Capture the minted session id even on the failure paths below, so a retry
    // resumes the same opencode session rather than starting a fresh one.
    if (sessionId) session.sessionId = sessionId;
    // Fail loudly (I3): a terminal error event fails the turn REGARDLESS of any
    // partial text. Preserve the partial text on the thrown error so a caller can
    // still persist it for debugging.
    if (error) {
      const err = new Error(`opencode run error: ${error}`);
      err.partialText = text;
      throw err;
    }
    // Fail loudly (I3): exit 0 with no parseable assistant text and no error event
    // is empty / non-JSON / truncated output — never fabricate an ok "(no output)"
    // result. Surface the raw stdout so the failure is diagnosable.
    if (!text) {
      throw new Error(`opencode run produced no assistant text (exit 0); raw output: ${raw.trim().slice(0, 200) || "(empty)"}`);
    }
    return { text, artifacts: [] };
  }

  async setModel(session, model) {
    // opencode model is provider/model, applied per run via -m — set on the session.
    session.config = { ...session.config, model };
  }

  async setEffort(session, effort) {
    // effort maps to opencode's provider-specific reasoning `--variant`.
    session.config = { ...session.config, variant: effort };
  }

  async resume(config = {}) {
    // resume = same config keyed to a prior opencode session id (passed as -s).
    return { config: { ...config }, sessionId: config.sessionId ?? null, alive: true };
  }

  async teardown(session) {
    // stateless: no server/process to tear down.
    session.alive = false;
  }
}
