// The shared bridge is deliberately separate from credentials and per-account
// settings. Enroll new Codex homes at provision AND launch (account homes can be
// materialized after setup). Only the bridge's owned entries are projected.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "Stop", "SessionEnd"];
const START = "<!-- GARRISON_AGENT_CONTINUITY_START -->";
const END = "<!-- GARRISON_AGENT_CONTINUITY_END -->";
const MCP_START = "# GARRISON_AGENT_CONTINUITY_MCP_START";
const MCP_END = "# GARRISON_AGENT_CONTINUITY_MCP_END";
const owned = (hook) => typeof hook?.command === "string" && hook.command.includes("agent-continuity.py");

function read(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
function write(file, text) {
  if (read(file) === text) return false;
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Continuity refuses to replace symlinked runtime settings: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.continuity-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return true;
}
function json(file) {
  const text = read(file);
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid continuity object: ${file}`);
  return value;
}
function block(text, start, end) {
  const a = text.indexOf(start);
  if (a < 0) return null;
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error("Incomplete managed continuity section");
  return text.slice(a, b + end.length);
}
function replaceBlock(text, value, start, end) {
  const old = block(text, start, end);
  return old ? text.replace(old, value) : `${value}\n\n${text}`;
}
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

export function ensureCodexContinuityHome({ env = process.env, userHome = os.homedir(), targetHome } = {}) {
  const nativeHome = path.resolve(env.GARRISON_CODEX_HOME?.trim() || path.join(userHome, ".codex"));
  const target = path.resolve(targetHome || env.CODEX_HOME?.trim() || nativeHome);
  if (target === nativeHome) return { enrolled: false, reason: "native-home" };
  const source = json(path.join(nativeHome, "hooks.json"));
  const selected = {};
  for (const event of EVENTS) {
    selected[event] = (source.hooks?.[event] ?? []).map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter(owned) }))
      .filter((entry) => entry.hooks.length);
  }
  if (!Object.values(selected).some((entries) => entries.length)) return { enrolled: false, reason: "not-installed" };
  if (Object.values(selected).some((entries) => !entries.length)) throw new Error("Native shared continuity hooks are incomplete; rerun install-agent-continuity.py");
  const instructions = block(read(path.join(nativeHome, "AGENTS.md")), START, END);
  if (!instructions) throw new Error("Native shared continuity instructions are missing; rerun install-agent-continuity.py");
  for (const name of ["hooks.json", "AGENTS.md", "config.toml"]) {
    if (fs.lstatSync(path.join(target, name), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Continuity refuses symlinked runtime settings: ${name}`);
    }
  }
  const cfg = json(path.join(userHome, ".config", "garrison", "agent-continuity.json"));
  const configuredMemoryDir = cfg.basic_memory_config_dir;
  if (configuredMemoryDir != null && (typeof configuredMemoryDir !== "string" || !path.isAbsolute(configuredMemoryDir))) {
    throw new Error("Continuity basic_memory_config_dir must be an absolute authority path");
  }
  const nextInstructions = replaceBlock(read(path.join(target, "AGENTS.md")), instructions, START, END);
  const current = json(path.join(target, "hooks.json"));
  const hooks = current.hooks ?? {};
  if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("Runtime hooks must be an object");
  for (const event of EVENTS) {
    const kept = (hooks[event] ?? []).map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !owned(h)) }))
      .filter((entry) => entry.hooks.length);
    hooks[event] = [...kept, ...selected[event]];
  }
  const hookChanged = write(path.join(target, "hooks.json"), `${JSON.stringify({ ...current, hooks }, null, 2)}\n`);
  const contextChanged = write(path.join(target, "AGENTS.md"), nextInstructions);

  // The operator's bridge config contains transport argv, no credentials. Never
  // copy native config.toml or auth here. Existing unowned per-home MCP entries
  // remain authoritative; the installer handles an explicitly requested change.
  const configFile = path.join(target, "config.toml");
  let config = read(configFile);
  // Codex accepts dotted tables, quoted keys and inline tables. Preserve an
  // occupied memory namespace conservatively instead of defining it twice.
  const hasMemory = (/\bmcp_servers\b/.test(config) && /\bbasic-memory\b/.test(config))
    || /^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*=/m.test(config);
  let memoryMcp = "preserved";
  if (cfg.version === 1 && Array.isArray(cfg.basic_memory_command) && cfg.basic_memory_command.length && (!hasMemory || config.includes(MCP_START))) {
    const command = [...cfg.basic_memory_command.map(String), "mcp"];
    // A gateway runs under its own BASIC_MEMORY_CONFIG_DIR. Generated account
    // MCPs must select the enrolled authority explicitly rather than inheriting
    // that unrelated per-composition vault. Existing unowned MCPs stay intact.
    const memoryDir = configuredMemoryDir ?? path.join(userHome, ".basic-memory");
    const remoteCommand = cfg.ssh_host && configuredMemoryDir
      ? ["env", `BASIC_MEMORY_CONFIG_DIR=${memoryDir}`, ...command] : command;
    const argv = cfg.ssh_host
      ? ["/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", String(cfg.ssh_host), remoteCommand.map(shellQuote).join(" ")]
      : command;
    const serverEnv = cfg.ssh_host ? "" : `env = { BASIC_MEMORY_CONFIG_DIR = ${JSON.stringify(memoryDir)} }\n`;
    const section = `${MCP_START}\n[mcp_servers.basic-memory]\ncommand = ${JSON.stringify(argv[0])}\nargs = ${JSON.stringify(argv.slice(1))}\n${serverEnv}${MCP_END}`;
    const previous = block(config, MCP_START, MCP_END);
    config = previous ? config.replace(previous, section) : `${config.trimEnd()}\n\n${section}\n`;
    memoryMcp = previous ? "owned-updated" : "added";
  }
  // This is the only non-MCP setting we own: loading the complete shared rules.
  const firstTable = config.search(/^[ \t]*\[/m);
  let root = firstTable < 0 ? config : config.slice(0, firstTable);
  const rest = firstTable < 0 ? "" : config.slice(firstTable);
  const cap = root.match(/^([ \t]*(?:project_doc_max_bytes|"project_doc_max_bytes"|'project_doc_max_bytes')[ \t]*=[ \t]*)([^\r\n#]+)/m);
  // Unusual existing values remain user-owned; never duplicate an unfamiliar
  // valid TOML key spelling. Avoid guessing root boundaries in multiline text.
  if (!cap && !config.includes('"""') && !config.includes("'''")) root = `project_doc_max_bytes = 65536\n${root}`;
  else if (cap && /^[+-]?[0-9][0-9_]*$/.test(cap[2].trim()) && Number(cap[2].trim().replaceAll("_", "")) < 65536) {
    root = root.replace(cap[0], `${cap[1]}65536`);
  }
  const configChanged = write(configFile, root + rest);
  return { enrolled: true, hookChanged, contextChanged, configChanged, memoryMcp };
}
