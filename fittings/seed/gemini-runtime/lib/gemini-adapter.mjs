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

function defaultRunExec({ bin, argv, env, cwd, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e?.message || e) }));
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
    return { config, alive: true };
  }
  async awaitReady() {}
  async sendTurn(session, text) {
    const { bin, argv } = buildArgs(session.config);
    this._pending.set(session, this._runExec({ bin, argv, env: session.config.env ?? process.env, cwd: session.config.compositionDir, stdin: text }));
  }
  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("GeminiAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
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
