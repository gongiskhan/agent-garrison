// codex-adapter.mjs — the Codex RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// Codex is a SECONDARY runtime that proves coding delegation. `codex exec` runs
// non-interactively and reads the prompt from STDIN (never argv → shell-injection
// safe under bypassPermissions), so this is a CLEAN non-PTY adapter — no TUI
// scraping. It implements the same RuntimeAdapter contract as ClaudeCodeAdapter;
// the generic pool + runtime-bridge drive it unchanged.
import { spawn } from "node:child_process";

const FULL_ACCESS_PERMISSION_MODES = new Set(["auto", "bypassPermissions", "full-auto"]);
const WORKSPACE_WRITE_PERMISSION_MODES = new Set(["acceptEdits", "allow-file-edits"]);

// Garrison's gateway passes its permission mode through the runtime config's
// environment. Codex does not understand Claude's permission-mode names, so map
// them onto Codex's sandbox flags here, at the runtime boundary. `auto` is a
// headless Garrison mode (there is no permission-prompt surface), and therefore
// needs the same unrestricted execution as `bypassPermissions`: routed turns can
// be asked to write an absolute task workspace and an absolute run/evidence dir,
// neither of which is necessarily beneath Codex's scratch cwd.
//
// Every non-auto mode fails closed. Edit-accepting modes can write only the
// selected Codex workspace; plan/default/unknown modes stay read-only. An
// explicit config value wins over the inherited gateway environment.
export function codexPermissionArgs(config = {}) {
  const mode = config.permissionMode ?? config.env?.GARRISON_PERMISSION_MODE ?? null;
  if (FULL_ACCESS_PERMISSION_MODES.has(mode)) {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (WORKSPACE_WRITE_PERMISSION_MODES.has(mode)) {
    return ["--sandbox", "workspace-write"];
  }
  return ["--sandbox", "read-only"];
}

// Build the `codex exec` invocation. Pure + testable: the prompt travels via
// stdin (returned separately), model + reasoning effort via documented `-c`
// config overrides, cwd via `--cd`. argv NEVER contains the prompt.
export function buildExecArgs(config = {}) {
  const argv = ["exec"];
  if (config.model) argv.push("-c", `model=${config.model}`);
  if (config.effort) argv.push("-c", `model_reasoning_effort=${config.effort}`);
  argv.push(...codexPermissionArgs(config));
  if (config.compositionDir) argv.push("--cd", config.compositionDir);
  // `codex exec` refuses to run outside a trusted git dir unless told to skip the
  // check; delegations run in throwaway/non-repo cwds, so always skip it (verified
  // live U4 — the bare invocation errors "Not inside a trusted directory").
  argv.push("--skip-git-repo-check");
  // JSONL events on stdout instead of the human transcript. This is the ONLY way
  // `codex exec` reports token usage (verified live against codex-cli 0.149.0:
  // `--json` is documented as "Print events to stdout as JSONL", and the closing
  // `turn.completed` event carries {input_tokens, cached_input_tokens,
  // cache_write_input_tokens, output_tokens, reasoning_output_tokens}). The reply
  // text then comes from the `agent_message` items rather than raw stdout —
  // parseCodexJsonl does both, and falls back to raw stdout if a build ever stops
  // emitting JSONL, so an unparseable stream degrades to the old behaviour rather
  // than to an empty turn.
  argv.push("--json");
  // read the prompt from stdin
  argv.push("-");
  return { bin: config.bin || "codex", argv, stdinFromPrompt: true };
}

// Sum a `turn.completed` usage object into ONE cumulative token count. Codex
// follows the OpenAI convention where `cached_input_tokens` is a subset of
// `input_tokens` and `reasoning_output_tokens` a subset of `output_tokens`, so
// the total is input + output — adding the subsets would double-count.
function totalTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens ?? usage.inputTokens);
  const output = Number(usage.output_tokens ?? usage.outputTokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

/**
 * Parse a `codex exec --json` stdout stream.
 *
 * Returns `{sawJson, text, usedTokens, usage, errorText}`. `sawJson` is false
 * when nothing on stdout parsed as a JSON event — the caller then treats stdout
 * as plain text (older codex builds, a stubbed exec in tests, `--json` dropped
 * from a future CLI). `usedTokens` is null when the stream reported no usage:
 * unknown usage is NEVER a fabricated zero.
 */
export function parseCodexJsonl(stdout) {
  const messages = [];
  const errors = [];
  let usage = null;
  let sawJson = false;
  for (const line of String(stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue; // a partial line (cancelled turn) is not a parse failure worth reporting
    }
    sawJson = true;
    // codex 0.149 shape: {type, item?, usage?}. Older builds nest the same
    // payloads under {id, msg:{type,...}} — read both so an adapter upgrade is
    // not a silent text loss.
    const type = evt.type ?? evt.msg?.type ?? null;
    const item = evt.item ?? evt.msg ?? evt;
    // ONLY the completed item (never `item.updated`, which repeats the same
    // item id mid-stream and would duplicate the reply text).
    if (type === "item.completed" || type === "agent_message") {
      if ((item?.type ?? type) === "agent_message") {
        const text = item?.text ?? item?.message ?? "";
        if (String(text).trim()) messages.push(String(text));
      }
    }
    if (type === "turn.completed" || type === "token_count") {
      const u = evt.usage ?? evt.msg?.info?.total_token_usage ?? evt.msg ?? null;
      const total = totalTokens(u);
      if (total != null) {
        usage = u;
      }
    }
    if (type === "turn.failed" || type === "error") {
      const msg = evt.error?.message ?? evt.msg?.message ?? item?.message ?? null;
      if (msg) errors.push(String(msg));
    }
  }
  return {
    sawJson,
    // A turn can emit more than one agent message; keep them all, in order.
    text: messages.join("\n\n"),
    usedTokens: totalTokens(usage),
    usage,
    errorText: errors.join("\n")
  };
}

// A cancelled turn's child gets SIGTERM first so codex can unwind and flush; a
// process that ignores it (or is wedged in a syscall) is SIGKILLed after this
// grace. Short on purpose: the HTTP interrupt caller is waiting on the turn.
const CANCEL_GRACE_MS = 2000;

// node keeps `child.pid` set and flips `child.killed` the moment kill() is
// CALLED, so neither is a liveness signal (same trap pty.mjs documents). The real
// predicate is "no exit observed yet": exitCode stays null until a normal exit,
// signalCode until a signalled one.
function childAlive(child) {
  return !!child && child.exitCode == null && child.signalCode == null;
}

function defaultRunExec({ bin, argv, env, cwd, stdin, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    // Settle once: a cancel resolves the turn early with the partial buffer, and
    // the dying child's later close must not overwrite that result.
    const settle = (result) => {
      if (settled) return false;
      settled = true;
      resolve(result);
      return true;
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => settle({ code, stdout: out, stderr: err }));
    child.on("error", (e) => settle({ code: -1, stdout: out, stderr: String(e?.message || e) }));
    // Hand the live child (plus its buffered output and an early-settle) back to
    // the adapter. Without this the child stays local to this promise and
    // cancel() has nothing to signal - the bug the run-context decision calls out.
    if (typeof onSpawn === "function") onSpawn({ child, partial: () => out, settle });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Last ~600 chars of a stream, trimmed — where a CLI puts its failure. */
function tailOf(text) {
  const s = String(text ?? "").trim();
  return s.length > 600 ? `…${s.slice(-600)}` : s;
}

export class CodexAdapter {
  constructor(opts = {}) {
    this.id = "codex";
    this._runExec = opts.runExec ?? defaultRunExec; // injectable for tests
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // codex exec is per-turn one-shot; the "session" carries config.
    const effort = config.effort ?? null;
    return {
      config: { ...config },
      alive: true,
      model: config.model ?? null,
      effort,
      // A configured effort is applied by buildExecArgs on every `codex exec`.
      // Keep the explicit boolean so route evidence can distinguish "requested
      // and applied" from runtimes that merely retain an unsupported request.
      effortApplied: effort != null,
      // Cancel bookkeeping - the in-flight child (parked per turn by sendTurn) and
      // the user's Stop intent. Declared here so the session shape is honest.
      proc: null,
      cancelRequested: false,
      // Token usage of the LAST turn, filled by awaitResponse from the
      // turn.completed event. null until a turn reports it - never 0, which
      // would read as "this turn was free".
      usedTokens: null,
      usage: null,
    };
  }

  async awaitReady() {
    /* no persistent process to await */
  }

  async sendTurn(session, text) {
    const { bin, argv } = buildExecArgs(session.config);
    // A prior turn's cancel must never leak into this one.
    session.cancelRequested = false;
    session.proc = null;
    this._pending.set(
      session,
      this._runExec({
        bin,
        argv,
        env: session.config.env ?? process.env,
        cwd: session.config.compositionDir,
        stdin: text,
        // Park the live child on the session so cancel() can signal it. An
        // injected runExec that ignores onSpawn leaves session.proc null and
        // cancel() degrades to a documented no-op.
        onSpawn: (proc) => {
          session.proc = proc;
        }
      })
    );
  }

  // Real cancel (2026-07-25 web-channel run-context §9). teardown() never killed
  // anything, so a routed codex turn ran to completion no matter what the user
  // pressed. SIGTERM the stored child, escalate to SIGKILL after a grace, and
  // settle the in-flight turn immediately with whatever codex already printed -
  // a dying process may never flush a close event worth waiting on.
  async cancel(session) {
    const proc = session?.proc ?? null;
    // Nothing running: a no-op that deliberately does NOT set cancelRequested,
    // which would otherwise poison the NEXT turn's awaitResponse.
    if (!proc?.child) return false;
    // Idempotent: a second Stop must not arm a second escalation timer.
    if (session.cancelRequested) return true;
    session.cancelRequested = true;
    const { child } = proc;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (childAlive(child)) {
      const timer = setTimeout(() => {
        if (!childAlive(child)) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, CANCEL_GRACE_MS);
      // Never hold the gateway's event loop open on a grace timer.
      timer.unref?.();
    }
    proc.settle?.({ code: -1, stdout: proc.partial?.() ?? "", stderr: "cancelled by user" });
    return true;
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("CodexAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
    session.proc = null;
    // stdout is a JSONL event stream (`--json`): the reply is the agent_message
    // items, the usage is the closing turn.completed. A stream that yielded no
    // JSON at all (older CLI, stubbed exec) falls back to raw stdout, and usage
    // stays UNKNOWN — reported as an absent field, never as zero.
    const parsed = parseCodexJsonl(r.stdout);
    const text = parsed.sawJson ? parsed.text : (r.stdout ?? "");
    session.usedTokens = parsed.usedTokens;
    session.usage = parsed.usage ?? null;
    const usage = parsed.usedTokens == null ? {} : { usedTokens: parsed.usedTokens };
    // A cancelled turn's child was signalled, so it "fails" with only partial
    // output. That is not a runtime error to throw on: settle the turn with the
    // partial text and the explicit stop reason so the caller can badge it.
    if (session.cancelRequested) {
      session.cancelRequested = false;
      return { text, artifacts: [], stoppedReason: "cancelled", ...usage };
    }
    // Report the TAIL of stderr, not the head. `codex exec` opens with a ~200-char
    // banner (workdir / model / provider / sandbox / effort) and puts the actual
    // failure on the LAST line, so a leading slice reliably truncates away the one
    // thing the reader needs — a real "You've hit your usage limit" turned into a
    // bare "codex exec exited 1" with the banner attached.
    if (r.code !== 0) throw new Error(`codex exec exited ${r.code}: ${tailOf(r.stderr) || tailOf(parsed.errorText) || tailOf(parsed.sawJson ? text : r.stdout) || "(no output)"}`);
    return { text, artifacts: [], ...usage };
  }

  async setModel(session, model) {
    // codex model is launch-fixed per exec (config carries it) — set on the session.
    session.config = { ...session.config, model };
    session.model = model ?? null;
  }

  async setEffort(session, effort) {
    session.config = { ...session.config, effort };
    session.effort = effort ?? null;
    session.effortApplied = effort != null;
  }

  async resume(config) {
    return this.spawn({ ...config, resume: true });
  }

  async teardown(session) {
    session.alive = false;
    // Back-compat: teardown has never killed the child (runSecondaryTurn calls it
    // in a `finally` on the happy path, where the exec has already exited) and
    // still doesn't - cancel() is the kill primitive. It does release the handle
    // so a torn-down session never pins a dead child.
    session.proc = null;
  }
}
