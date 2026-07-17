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
    };
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
  }
}
