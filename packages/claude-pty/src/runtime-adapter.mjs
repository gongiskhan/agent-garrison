// runtime-adapter.mjs — the RuntimeAdapter contract (BRIEF v4 §2).
//
// The node-pty + xterm-headless driver is abstracted behind a per-runtime
// adapter so the pool, the runtime-bridge, and the orchestrator are built ONCE
// and are runtime-agnostic. Adding a runtime (Codex, Gemini-CLI, OpenCode) =
// implementing this interface. The contract says "implement however you can", so
// a future runtime with a cleaner channel than PTY may use it without breaking
// callers.
//
// Interface (all async unless noted):
//   id                                  -> string runtime id ("claude-code", …)
//   spawn(config) -> session            (binary, args, env: base-URL/keys/cwd)
//   awaitReady(session) -> void         (TUI input box live / API handshake)
//   sendTurn(session, text) -> void     (submit one user turn)
//   awaitResponse(session) -> {text, artifacts?}   ← HARDEST per-adapter primitive
//                                       (turn-boundary detection + TUI/ANSI strip)
//   setModel(session, model) -> void    (slash-command where supported, else respawn)
//   setEffort(session, effort) -> void
//   resume(config) -> session           (re-attach prior conversation)
//   teardown(session) -> void
//
// sendTurn + awaitResponse are split deliberately: knowing a TUI turn FINISHED by
// scraping output is the hard part each adapter must solve (Claude Code has it;
// Codex/Gemini each need their own ready/idle/end-of-turn detection).

import { OperativePtySession } from "./session.mjs";

export const ADAPTER_METHODS = [
  "spawn",
  "awaitReady",
  "sendTurn",
  "awaitResponse",
  "setModel",
  "setEffort",
  "resume",
  "teardown"
];

// Reference adapter — Claude Code (the full reference runtime, both faces).
// Wraps OperativePtySession (claude-pty). sendTurn stores the in-flight turn
// promise; awaitResponse resolves it (claude-pty's runTurn already does
// turn-boundary detection + ANSI strip).
export class ClaudeCodeAdapter {
  constructor(opts = {}) {
    this.id = "claude-code";
    this._spawnFn = opts.spawnFn ?? ((config) => OperativePtySession.spawn(config));
    this._inflight = new WeakMap();
  }

  async spawn(config) {
    return this._spawnFn(config);
  }

  async awaitReady(session) {
    // OperativePtySession.spawn already awaits readiness; assert liveness.
    if (typeof session.isAlive === "function" && !session.isAlive()) {
      throw new Error("ClaudeCodeAdapter: session not alive after spawn");
    }
  }

  async sendTurn(session, text) {
    // Kick off the turn; awaitResponse resolves it (split contract).
    this._inflight.set(session, session.runTurn({ message: text, timeoutMs: 120000 }));
  }

  async awaitResponse(session) {
    const p = this._inflight.get(session);
    if (!p) throw new Error("ClaudeCodeAdapter: awaitResponse without a pending sendTurn");
    this._inflight.delete(session);
    const r = await p;
    return { text: r.reply ?? "", artifacts: r.artifacts ?? [] };
  }

  async setModel(session, model) {
    // slash-inject (MR0e verdict: works)
    session.writeKeys(`/model ${model}\r`);
  }

  async setEffort(session, effort) {
    session.writeKeys(`/effort ${effort}\r`);
  }

  async resume(config) {
    return this._spawnFn({ ...config, continueSession: true });
  }

  async teardown(session) {
    try {
      session.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

// Conformance harness — drives any adapter through the full lifecycle and
// returns a structured report. Used by tests with a stub adapter (no live
// model) and by integration checks with a real one.
export async function runAdapterConformance(adapter, opts = {}) {
  const steps = [];
  const record = (name, ok, detail) => steps.push({ name, ok: !!ok, detail: detail ?? null });
  const config = opts.config ?? { compositionDir: "/tmp/conformance", model: "haiku", permissionMode: "bypassPermissions" };
  const turnText = opts.turnText ?? "ping";

  // contract shape
  for (const m of ADAPTER_METHODS) {
    record(`has:${m}`, typeof adapter[m] === "function", `adapter.${m}`);
  }
  if (typeof adapter.id !== "string") record("has:id", false, "adapter.id must be a string");
  else record("has:id", true, adapter.id);

  let session;
  try {
    session = await adapter.spawn(config);
    record("spawn", !!session);
    await adapter.awaitReady(session);
    record("awaitReady", true);
    await adapter.sendTurn(session, turnText);
    record("sendTurn", true);
    const resp = await adapter.awaitResponse(session);
    record("awaitResponse", resp && typeof resp.text === "string", JSON.stringify(resp).slice(0, 120));
    await adapter.teardown(session);
    record("teardown", true);
  } catch (err) {
    record("lifecycle-error", false, String(err?.message || err));
  }

  const ok = steps.every((s) => s.ok);
  return { ok, runtime: adapter.id, steps };
}
