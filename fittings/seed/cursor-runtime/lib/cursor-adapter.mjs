// cursor-adapter.mjs — the Cursor RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// Cursor Agent (`cursor-agent`) runs non-interactively under `-p/--print` and reads
// the prompt from STDIN (verified live against cursor-agent 2026.07.23), so this is
// a CLEAN non-PTY adapter — no TUI scraping, no standing server. It implements the
// same RuntimeAdapter contract as ClaudeCodeAdapter; the generic pool + the
// runtime-bridge drive it unchanged.
//
// `--output-format json` emits ONE terminal JSON object per run:
//   {type:"result", subtype:"success", is_error:false, result:"<assistant text>",
//    session_id:"<uuid>", usage:{inputTokens,outputTokens,cacheReadTokens,…}}
// The session id it mints is captured here so a follow-up turn resumes the same
// Cursor chat with `--resume <id>`, giving multi-turn continuity with no long-lived
// process.
//
// Two live-verified failure shapes drive the loud parsing below, and BOTH exit 0:
//   - an untrusted workspace prints a human "Workspace Trust Required" notice
//     (hence --trust on every invocation, in every permission mode);
//   - an unknown --model prints a plain-text dump of the valid model ids.
// Neither is JSON, so "exit 0 with no result object" must fail the turn rather
// than return an empty success.
import { spawn } from "node:child_process";

const FULL_ACCESS_PERMISSION_MODES = new Set(["auto", "bypassPermissions", "full-auto"]);
const WORKSPACE_WRITE_PERMISSION_MODES = new Set(["acceptEdits", "allow-file-edits"]);

// Garrison's gateway passes its permission mode through the runtime config's
// environment. Cursor does not understand Claude's permission-mode names, so map
// them onto Cursor's own flags here, at the runtime boundary. `auto` is a headless
// Garrison mode (there is no permission-prompt surface) and therefore needs the
// same unrestricted execution as `bypassPermissions`.
//
// Every non-auto mode fails closed. Edit-accepting modes run auto-approved but
// inside Cursor's sandbox; plan/default/unknown modes drop to `--mode ask`, which
// is read-only Q&A. `--trust` is on EVERY path on purpose: without it the CLI
// refuses the workspace and exits 0 with a human notice, which would read as a
// silent empty turn. An explicit config value wins over the inherited gateway env.
export function cursorPermissionArgs(config = {}) {
  const mode = config.permissionMode ?? config.env?.GARRISON_PERMISSION_MODE ?? null;
  if (FULL_ACCESS_PERMISSION_MODES.has(mode)) {
    return ["--trust", "--force"];
  }
  if (WORKSPACE_WRITE_PERMISSION_MODES.has(mode)) {
    return ["--trust", "--force", "--sandbox", "enabled"];
  }
  return ["--trust", "--mode", "ask"];
}

// Build the `cursor-agent` invocation. Pure + testable: the prompt travels via
// STDIN (returned separately via stdinFromPrompt, NEVER argv → shell-injection
// safe under bypassPermissions), model via `--model`, cwd via `--workspace`, and
// session continuation via `--resume <chatId>`. argv NEVER contains the prompt.
//
// There is deliberately NO effort flag: Cursor encodes reasoning effort in the
// MODEL ID itself (gpt-5.3-codex-high, claude-opus-5-low, …). The bracket-override
// form the CLI advertises is accepted only by its parameterized models — passing
// `gpt-5.3-codex[effort=low]` is REJECTED live — so an effort argument here would
// be a control with nothing behind it. See setEffort.
export function buildRunArgs(config = {}) {
  const argv = ["-p", "--output-format", "json"];
  if (config.model) argv.push("--model", config.model);
  argv.push(...cursorPermissionArgs(config));
  if (config.compositionDir) argv.push("--workspace", config.compositionDir);
  if (config.sessionId) argv.push("--resume", config.sessionId);
  return { bin: config.bin || "cursor-agent", argv, stdinFromPrompt: true };
}

// Parse `--output-format json` output. The run's terminal event is a single
// `{type:"result"}` object; take the LAST one so a future multi-object stream
// still resolves to the final verdict. Non-JSON lines (the trust notice, the
// unknown-model dump) are ignored here and surface as "no result object" —
// awaitResponse turns that into a loud failure carrying the raw output.
export function parseRunOutput(stdout = "") {
  let result = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === "result") result = ev;
  }
  if (!result) return { text: "", sessionId: null, error: null, usage: null };
  const text = typeof result.result === "string" ? result.result : "";
  const failed = result.is_error === true || (result.subtype != null && result.subtype !== "success");
  return {
    text,
    sessionId: result.session_id ?? null,
    // A failed result carries its explanation in `result`; fall back to the
    // subtype so an error is never reported as an unlabelled empty string.
    error: failed ? text || result.subtype || "cursor-agent error" : null,
    usage: result.usage ?? null
  };
}

// A cancelled turn's child gets SIGTERM first so cursor-agent can unwind and
// flush; a process that ignores it is SIGKILLed after this grace. Short on
// purpose: the HTTP interrupt caller is waiting on the turn. (Same contract as
// the Codex adapter.)
const CANCEL_GRACE_MS = 2000;

// node keeps `child.pid` set and flips `child.killed` the moment kill() is CALLED,
// so neither is a liveness signal. The real predicate is "no exit observed yet".
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
    // the adapter, so cancel() has something to signal.
    if (typeof onSpawn === "function") onSpawn({ child, partial: () => out, settle });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export class CursorAdapter {
  constructor(opts = {}) {
    this.id = "cursor";
    this._runExec = opts.runExec ?? defaultRunExec; // injectable for tests
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // cursor-agent -p is per-turn one-shot; the "session" carries config + the
    // Cursor chat id (minted on the first run, captured in awaitResponse).
    return {
      config: { ...config },
      sessionId: config.sessionId ?? null,
      alive: true,
      model: config.model ?? null,
      // Effort is baked into Cursor's model ids, so a requested effort is
      // RETAINED but never applied — reported honestly, never claimed.
      effort: config.effort ?? null,
      effortApplied: false,
      proc: null,
      cancelRequested: false,
      // Last turn's token counters from the result event's `usage` block.
      usage: null
    };
  }

  async awaitReady() {
    /* no persistent process to await — each turn is a fresh `cursor-agent -p` */
  }

  async sendTurn(session, text) {
    const cfg = { ...session.config, sessionId: session.sessionId ?? session.config.sessionId ?? null };
    const { bin, argv } = buildRunArgs(cfg);
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
        onSpawn: (proc) => {
          session.proc = proc;
        }
      })
    );
  }

  // Real cancel: SIGTERM the stored child, escalate to SIGKILL after a grace, and
  // settle the in-flight turn immediately with whatever cursor-agent already
  // printed — a dying process may never flush a close event worth waiting on.
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
    if (!p) throw new Error("CursorAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
    session.proc = null;
    const raw = r.stdout ?? "";
    const { text, sessionId, error, usage } = parseRunOutput(raw);
    // Capture the minted chat id even on the failure paths below, so a retry
    // resumes the same Cursor chat rather than starting a fresh one.
    if (sessionId) session.sessionId = sessionId;
    if (usage) session.usage = usage;
    // A cancelled turn's child was signalled, so it "fails" with only partial
    // output. That is not a runtime error to throw on: settle the turn with
    // whatever parsed and the explicit stop reason so the caller can badge it.
    if (session.cancelRequested) {
      session.cancelRequested = false;
      return { text, artifacts: [], stoppedReason: "cancelled" };
    }
    if (r.code !== 0) {
      throw new Error(`cursor-agent exited ${r.code}: ${String(r.stderr).slice(0, 200)}`);
    }
    // Fail loudly: a result event that reports an error fails the turn REGARDLESS
    // of any text it carried. Preserve that text on the thrown error so a caller
    // can still persist it for debugging.
    if (error) {
      const err = new Error(`cursor-agent error: ${error}`);
      err.partialText = text;
      throw err;
    }
    // Fail loudly: exit 0 with no parseable result event is the trust notice, the
    // unknown-model dump, or truncated output — never fabricate an ok result.
    // Surface the raw stdout so the failure is diagnosable.
    if (!text) {
      throw new Error(
        `cursor-agent produced no assistant text (exit 0); raw output: ${raw.trim().slice(0, 300) || "(empty)"}`
      );
    }
    return { text, artifacts: [] };
  }

  async setModel(session, model) {
    // The model is a per-run `--model` argument — set it on the session and the
    // next turn carries it.
    session.config = { ...session.config, model };
    session.model = model ?? null;
  }

  async setEffort(session, effort) {
    // Cursor has NO independent effort control: effort is part of the model id
    // (gpt-5.3-codex-high vs gpt-5.3-codex-low). Retain the request so route
    // evidence can report "requested but not applied", and never claim it landed.
    // To actually change effort, route to a different Cursor model id.
    session.config = { ...session.config, effort };
    session.effort = effort ?? null;
    session.effortApplied = false;
  }

  async resume(config = {}) {
    // resume = same config keyed to a prior Cursor chat id (passed as --resume).
    return this.spawn({ ...config, sessionId: config.sessionId ?? null });
  }

  async teardown(session) {
    // stateless: no server/process to tear down. Release the child handle so a
    // torn-down session never pins a dead child (cancel() is the kill primitive).
    session.alive = false;
    session.proc = null;
  }
}
