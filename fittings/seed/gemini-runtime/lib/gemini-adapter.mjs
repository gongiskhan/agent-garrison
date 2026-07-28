// gemini-adapter.mjs — the Gemini-CLI RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// Gemini is a SECONDARY runtime proving CAPABILITY delegation (incl. image — there
// is NO separate image skill; the image role maps to secondary:gemini). `gemini -p`
// runs non-interactively and appends the prompt from STDIN (shell-injection safe).
// Same RuntimeAdapter contract; the generic pool + runtime-bridge drive it unchanged.
import { spawn } from "node:child_process";

// Build the headless `gemini` invocation. Prompt travels via stdin (empty -p
// triggers headless; stdin is appended), model via -m, -y auto-accepts tools.
export function buildArgs(config = {}) {
  const argv = [];
  if (config.model) argv.push("-m", config.model);
  // gemini CLI 0.46+: `--approval-mode yolo` is the modern replacement for `-y`
  // (auto-approve every tool call). `--skip-trust` is STILL required: delegations run
  // in throwaway cwds, and in an untrusted folder gemini silently DOWNGRADES yolo back
  // to "default" and exits 55 on the first tool call. Verified live 2026-06-29: bare
  // `--approval-mode yolo` prints "overridden to default ... not trusted" + exits 55;
  // adding `--skip-trust` keeps yolo active. The prompt arrives on stdin (no -p needed —
  // piped, non-TTY stdin selects headless mode on its own).
  argv.push("--approval-mode", "yolo");
  argv.push("--skip-trust");
  return { bin: config.bin || "gemini", argv, stdinFromPrompt: true };
}

// SIGTERM first so the CLI can unwind and flush; SIGKILL after this grace if it
// is still alive. Mirrors the codex adapter - the runtime fittings are
// independent packages and must not import from one another.
const CANCEL_GRACE_MS = 2000;

// `child.pid` stays set and `child.killed` flips the moment kill() is CALLED, so
// neither is a liveness signal. "No exit observed yet" is the real predicate.
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
    // the adapter, otherwise it stays local to this promise and cancel() has
    // nothing to signal.
    if (typeof onSpawn === "function") onSpawn({ child, partial: () => out, settle });
    child.stdin.end(stdin ?? "");
  });
}

export class GeminiAdapter {
  constructor(opts = {}) {
    this.id = "gemini";
    this._runExec = opts.runExec ?? defaultRunExec;
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // proc/cancelRequested are the cancel bookkeeping: the in-flight child (parked
    // per turn by sendTurn) and the user's Stop intent. Declared for shape honesty.
    return { config, alive: true, proc: null, cancelRequested: false };
  }
  async awaitReady() {}
  async sendTurn(session, text) {
    const { bin, argv } = buildArgs(session.config);
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

  // Real cancel (2026-07-25 web-channel run-context §9): SIGTERM the stored child,
  // escalate to SIGKILL after a grace, and settle the in-flight turn immediately
  // with whatever gemini already printed. teardown() kills nothing, so before this
  // a routed gemini turn ran to completion regardless of the user's Stop.
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
    if (!p) throw new Error("GeminiAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
    session.proc = null;
    // A cancelled turn's child was signalled, so it "fails" with only partial
    // output. Settle it with that partial text plus the explicit stop reason
    // instead of throwing a runtime error the user did not cause.
    if (session.cancelRequested) {
      session.cancelRequested = false;
      const partial = r.stdout ?? "";
      return { text: partial, artifacts: scrapeArtifactPaths(partial), stoppedReason: "cancelled" };
    }
    if (r.code !== 0) throw new Error(`gemini exited ${r.code}: ${r.stderr?.slice(0, 200)}`);
    // Capability artifacts (e.g. generated image paths) are scraped from output.
    const artifacts = scrapeArtifactPaths(r.stdout ?? "");
    return { text: r.stdout ?? "", artifacts };
  }
  async setModel(session, model) {
    session.config = { ...session.config, model };
  }
  async setEffort(session, effort) {
    session.config = { ...session.config, effort };
  }
  async resume(config) {
    return { config: { ...config, resume: true }, alive: true };
  }
  async teardown(session) {
    session.alive = false;
    // Back-compat: teardown still kills nothing (cancel() is the kill primitive),
    // but it releases the handle so a torn-down session never pins a dead child.
    session.proc = null;
  }
}

// Pull artifact file paths (images, etc.) out of the model's output.
export function scrapeArtifactPaths(text) {
  const paths = new Set();
  const re = /(\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|pdf))/gi;
  let m;
  while ((m = re.exec(String(text)))) paths.add(m[1]);
  return [...paths];
}
