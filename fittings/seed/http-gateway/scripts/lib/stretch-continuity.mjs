// Runtime-neutral presence for durable stretches. Native SDK settings/hooks are
// not assumed. Only local cached context is awaited; the Python bridge owns its
// private metadata queue and detached Basic Memory delivery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_CONTEXT = 6500;
const MAX_OUTPUT = 32768;
const INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", "PRD.md", "PLANING.md", "TASKS.md"];
const NOOP = Object.freeze({ context: "", instructions: "", admit() {}, checkpoint() {}, finish() {} });
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const under = (cwd, root) => {
  const relative = path.relative(path.resolve(root), cwd);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

// Working SDK sessions use an explicit server map instead of native CLI
// settings. Project memory remains the same configured authority; credentials
// stay in its existing local/SSH authentication, never in this projection.
export function continuityMemoryServer({ env = process.env, userHome = os.homedir() } = {}) {
  const file = env.GARRISON_AGENT_CONTINUITY_CONFIG || path.join(userHome, ".config/garrison/agent-continuity.json");
  try {
    if (fs.statSync(file).size > 262144) return null;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg.version !== 1 || !Array.isArray(cfg.basic_memory_command) || !cfg.basic_memory_command.length
      || !cfg.basic_memory_command.every((value) => typeof value === "string" && value)) return null;
    const configuredDir = cfg.basic_memory_config_dir;
    if (configuredDir != null && (typeof configuredDir !== "string" || !path.isAbsolute(configuredDir))) return null;
    const command = [...cfg.basic_memory_command, "mcp"];
    // The gateway deliberately isolates BASIC_MEMORY_CONFIG_DIR and XDG for
    // composition fittings. Working agents must select the enrolled authority
    // explicitly; sharing only an executable name does not share its store.
    const remoteCommand = cfg.ssh_host && configuredDir
      ? ["env", `BASIC_MEMORY_CONFIG_DIR=${configuredDir}`, ...command] : command;
    return cfg.ssh_host
      ? { command: "/usr/bin/ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", String(cfg.ssh_host), remoteCommand.map(shellQuote).join(" ")] }
      : { command: command[0], args: command.slice(1), env: { BASIC_MEMORY_CONFIG_DIR: configuredDir ?? path.join(userHome, ".basic-memory") } };
  } catch { return null; }
}

function configuration(env, cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const file = env.GARRISON_AGENT_CONTINUITY_CONFIG || path.join(os.homedir(), ".config/garrison/agent-continuity.json");
  try {
    if (fs.statSync(file).size > 262144) return null;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg.version !== 1) return null;
    // Match the bridge's canonical enrollment check before discovering a repo.
    // A symlink under an enrolled parent must not admit an external checkout.
    const realRoot = (root) => {
      try { return typeof root === "string" && path.isAbsolute(root) ? fs.realpathSync(root) : null; }
      catch { return null; }
    };
    cwd = fs.realpathSync(cwd);
    const projects = (cfg.projects ?? []).map((project) => ({ ...project, root: realRoot(project.root) })).filter((project) => project.root);
    const parents = (cfg.project_parents ?? []).map(realRoot).filter(Boolean);
    const roots = [...projects.map((project) => project.root), ...parents];
    if (!roots.some((root) => under(cwd, root))) return null;
    let projectRoot = projects.filter((project) => under(cwd, project.root))
      .sort((a, b) => b.root.length - a.root.length)[0]?.root;
    if (!projectRoot) {
      for (const parent of parents) {
        if (!under(cwd, parent)) continue;
        for (let directory = cwd; directory !== parent && under(directory, parent); directory = path.dirname(directory)) {
          if (fs.existsSync(path.join(directory, ".git"))) { projectRoot = directory; break; }
        }
        if (projectRoot) break;
      }
    }
    if (!projectRoot) return null;
    let command = cfg.bridge_command;
    // Pre-upgrade configs can locate only their explicitly enrolled Garrison
    // checkout. Installed fittings never assume a relative path back to a repo.
    if (!command) {
      const project = projects.find((entry) => /^garrison$/i.test(entry.key ?? entry.name ?? ""));
      const script = project && path.join(project.root, "scripts/agent-continuity.py");
      if (script && fs.existsSync(script)) command = ["python3", script];
    }
    if (!Array.isArray(command) || !command.length || !command.every((value) => typeof value === "string" && value)) return null;
    return { file, command, projectRoot };
  } catch { return null; }
}

function projectInstructions(root) {
  const limit = 65536;
  const truncated = "\n[Project instruction context truncated at 65536 bytes; read the named files before relying on omitted instructions.]\n";
  try {
    const canonicalRoot = fs.realpathSync(root);
    const seen = new Set();
    let output = "";
    let remaining = limit - Buffer.byteLength(truncated);
    for (const name of INSTRUCTION_NAMES) {
      let file;
      try { file = fs.realpathSync(path.join(canonicalRoot, name)); } catch { continue; }
      // A same-project override may point at its private CLAUDE.md. Never follow
      // an instruction symlink into another project, home or credential path.
      if (!under(file, canonicalRoot) || !INSTRUCTION_NAMES.includes(path.basename(file)) || seen.has(file)) continue;
      seen.add(file);
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const header = `\n### ${name}${path.basename(file) !== name ? ` (canonical ${path.basename(file)})` : ""}\n`;
      if (Buffer.byteLength(header) >= remaining) return output + truncated;
      remaining -= Buffer.byteLength(header);
      const buffer = Buffer.alloc(Math.min(stat.size, remaining));
      const fd = fs.openSync(file, "r");
      let bytes;
      try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); }
      finally { fs.closeSync(fd); }
      const text = new TextDecoder().decode(buffer.subarray(0, bytes), { stream: stat.size > bytes });
      output += header + text;
      remaining -= Buffer.byteLength(text);
      if (stat.size > bytes) return output + truncated;
    }
    return output;
  } catch { return ""; }
}

function invoke(cfg, args, payload, { env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    let output = "";
    let timer;
    let settled = false;
    const done = (text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(text);
    };
    const abort = () => { child?.kill("SIGKILL"); done(); };
    if (signal?.aborted) return done();
    try {
      child = spawn(cfg.command[0], [...cfg.command.slice(1), "--config", cfg.file, ...args], {
        env, stdio: ["pipe", "pipe", "ignore"],
      });
      child.on("error", () => done());
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > MAX_OUTPUT) abort();
      });
      child.on("close", (code) => done(code === 0 ? output : ""));
      child.stdin.on("error", () => {});
      child.stdin.end(payload ? JSON.stringify(payload) : "");
      timer = setTimeout(abort, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
    } catch { done(); }
  });
}

export function prepareStretchContinuity({ cwd, conversationId, stretchId, model, runtime, duty, env = process.env,
  signal, timeoutMs = 500, heartbeatMs = 60000 } = {}) {
  const cfg = configuration(env, cwd);
  if (!cfg || !stretchId || signal?.aborted) return NOOP;
  const instructions = projectInstructions(cfg.projectRoot);
  const metadata = {
    cwd, session_id: `conversation:${conversationId ?? "none"}:stretch:${stretchId}`.slice(0, 512),
    model: String(model ?? "unknown").slice(0, 100),
    runtime: String(runtime ?? "unknown").slice(0, 80), duty: String(duty ?? "unknown").slice(0, 80),
  };
  // status reads only the same bounded local cache native SessionStart uses.
  // It never fetches Basic Memory, runs git or creates a session observation.
  return invoke(cfg, ["status", "--cwd", cwd], null, { env, timeoutMs, signal }).then((context) => {
    let admitted = false;
    let finished = false;
    let timer;
    let pending = Promise.resolve();
    const emit = (event) => {
      pending = pending.then(() => invoke(cfg, ["hook", "--source", "Garrison"],
        { ...metadata, hook_event_name: event }, { env, timeoutMs }));
      return pending;
    };
    return {
      context: context.trim().slice(0, MAX_CONTEXT),
      instructions,
      admit() {
        if (admitted || finished || signal?.aborted) return;
        admitted = true;
        void emit("SessionStart");
        void emit("Checkpoint");
        timer = setInterval(() => { if (!finished) void emit("Heartbeat"); }, heartbeatMs);
        timer.unref?.();
      },
      checkpoint() { if (admitted && !finished) return emit("Checkpoint"); },
      finish() {
        if (finished) return pending;
        finished = true;
        clearInterval(timer);
        // No admission means no imaginary started/ended session (e.g. Stop
        // while a Codex turn waits for its machine-wide lock).
        return admitted ? emit("SessionEnd") : pending;
      },
    };
  });
}
