// codex-adapter.mjs — the Codex RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// Codex is a SECONDARY runtime that proves coding delegation. `codex exec` runs
// non-interactively and reads the prompt from STDIN (never argv → shell-injection
// safe under bypassPermissions), so this is a CLEAN non-PTY adapter — no TUI
// scraping. It implements the same RuntimeAdapter contract as ClaudeCodeAdapter;
// the generic pool + runtime-bridge drive it unchanged.
import { spawn } from "node:child_process";

// Build the `codex exec` invocation. Pure + testable: the prompt travels via
// stdin (returned separately), model via the documented `-c model=<id>` config
// override, cwd via `--cd`. argv NEVER contains the prompt.
export function buildExecArgs(config = {}) {
  const argv = ["exec"];
  if (config.model) argv.push("-c", `model=${config.model}`);
  if (config.compositionDir) argv.push("--cd", config.compositionDir);
  // `codex exec` refuses to run outside a trusted git dir unless told to skip the
  // check; delegations run in throwaway/non-repo cwds, so always skip it (verified
  // live U4 — the bare invocation errors "Not inside a trusted directory").
  argv.push("--skip-git-repo-check");
  // read the prompt from stdin
  argv.push("-");
  return { bin: config.bin || "codex", argv, stdinFromPrompt: true };
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

export class CodexAdapter {
  constructor(opts = {}) {
    this.id = "codex";
    this._runExec = opts.runExec ?? defaultRunExec; // injectable for tests
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // codex exec is per-turn one-shot; the "session" carries config.
    return { config, alive: true };
  }

  async awaitReady() {
    /* no persistent process to await */
  }

  async sendTurn(session, text) {
    const { bin, argv } = buildExecArgs(session.config);
    this._pending.set(
      session,
      this._runExec({ bin, argv, env: session.config.env ?? process.env, cwd: session.config.compositionDir, stdin: text })
    );
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("CodexAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
    if (r.code !== 0) throw new Error(`codex exec exited ${r.code}: ${r.stderr?.slice(0, 200)}`);
    return { text: r.stdout ?? "", artifacts: [] };
  }

  async setModel(session, model) {
    // codex model is launch-fixed per exec (config carries it) — set on the session.
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
  }
}
