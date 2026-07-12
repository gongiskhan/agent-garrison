#!/usr/bin/env node
// opencode-runtime bridge — the uniform runtime-bridge entrypoint (BRIEF v4).
// Exposes delegate(task_spec) -> {summary, artifacts} for OpenCode-as-secondary.
//
// Usage:
//   bridge.mjs --probe                # health check, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//
// OpenCode's natural fit is a STANDING HTTP server (`opencode serve` on 127.0.0.1),
// so per delegate this bridge boots (or reuses) a scoped server, opens a session, posts
// the prompt over HTTP, and returns a schema-validated {summary, artifacts}. If the
// server can't boot, the adapter degrades to a stateless `opencode run --format json
// --auto` subprocess. Unlike Codex there is NO shared-token revocation, so NO
// machine-wide serialization lock is needed — concurrent opencode processes are safe.
//
// Autonomous + bill-free by default: this box has no opencode credentials, so the
// bridge materializes a SCOPED opencode config (never touching the user's
// ~/.config/opencode) pointing at a LOCAL OpenAI-compatible provider (ollama) with
// permission auto-allow. Provider/model/base-url are overridable via env (injected from
// the fitting config_schema).
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { OpenCodeAdapter, parseModel } from "../lib/opencode-adapter.mjs";

const DATA_DIR =
  process.env.OPENCODE_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "opencode-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const SCOPED_CONFIG = path.join(DATA_DIR, "opencode.json");

// Runtime config (env-injected from the fitting config_schema; defaults = local ollama).
const SERVER_HOST = process.env.OPENCODE_SERVER_HOST || "127.0.0.1";
const SERVER_PORT = Number(process.env.OPENCODE_SERVER_PORT || 7094);
const DEFAULT_MODEL = process.env.OPENCODE_MODEL || "ollama/qwen2.5:3b";
const PROVIDER_NPM = process.env.OPENCODE_PROVIDER_NPM || "@ai-sdk/openai-compatible";
const PROVIDER_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:11434/v1";
const SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || null;

// `provider/model` — provider slug + a model id (which may carry colons, e.g.
// "ollama/qwen2.5:3b"). The delegate model comes from the task spec, else the default.
const MODEL_ALLOWLIST = /^[a-z0-9][a-z0-9._-]*\/.+/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Write full output to the Artifact Store — prefers the documents fitting's write CLI
// (ARTIFACTS_CLI) when present; falls back to a local file. (Shared shape with
// codex/gemini bridges.)
async function writeArtifact(ns, name, content) {
  const cli = process.env.ARTIFACTS_CLI;
  if (cli && existsSync(cli)) {
    const r = spawnSync("python3", [cli, "write", "--namespace", ns, "--name", name], { input: content, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      try {
        return JSON.parse(r.stdout).path || `${ns}/${name}`;
      } catch {
        /* local fallback */
      }
    }
  }
  mkdirSync(path.join(ARTIFACTS_DIR, ns), { recursive: true });
  const p = path.join(ARTIFACTS_DIR, ns, name);
  writeFileSync(p, content, "utf8");
  return p;
}

async function logDecision(rec) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(DECISIONS, JSON.stringify(rec) + "\n", "utf8");
}

// Materialize a SCOPED opencode config so delegate runs are autonomous + bill-free
// WITHOUT mutating the user's ~/.config/opencode: a local OpenAI-compatible provider
// derived from the chosen model + `permission:{"*":"allow"}` for headless auto-approve.
// Returns the config path (consumed by the server + the `run` fallback via OPENCODE_CONFIG).
export function materializeScopedConfig(model = DEFAULT_MODEL) {
  const parsed = parseModel(model);
  const cfg = { $schema: "https://opencode.ai/config.json", permission: { "*": "allow" }, model };
  if (parsed) {
    cfg.provider = {
      [parsed.providerID]: {
        npm: PROVIDER_NPM,
        name: `${parsed.providerID} (local)`,
        options: { baseURL: PROVIDER_BASE_URL },
        models: { [parsed.modelID]: { name: parsed.modelID } }
      }
    };
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SCOPED_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  return SCOPED_CONFIG;
}

// A bootServer for the adapter — spawns `opencode serve` under the scoped config, on a
// fixed local port, secured only if OPENCODE_SERVER_PASSWORD is set.
function makeBootServer(configPath) {
  return async () => {
    const env = { ...process.env, OPENCODE_CONFIG: configPath };
    if (SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = SERVER_PASSWORD;
    const proc = spawn("opencode", ["serve", "--port", String(SERVER_PORT), "--hostname", SERVER_HOST], {
      env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    proc.unref?.();
    return { baseUrl: `http://${SERVER_HOST}:${SERVER_PORT}`, password: SERVER_PASSWORD, proc, owns: true };
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    // Health probe: the CLI answers (offline-safe). A running server is a bonus, not required.
    const v = spawnSync("opencode", ["--version"], { encoding: "utf8" });
    if (v.status !== 0) {
      console.error("opencode CLI not found on PATH");
      process.exit(1);
    }
    console.log("ok");
    return;
  }

  const specFileIdx = argv.indexOf("--spec-file");
  const raw = specFileIdx >= 0 ? readFileSync(argv[specFileIdx + 1], "utf8") : readStdin();
  if (!raw.trim()) {
    console.error("no task spec on stdin (or --spec-file)");
    process.exit(2);
  }
  const spec = parseTaskSpec(raw);
  const model = spec.model || DEFAULT_MODEL;
  const configPath = materializeScopedConfig(model);
  const adapter = new OpenCodeAdapter({ bootServer: makeBootServer(configPath), mode: "auto" });

  try {
    const result = await delegate(
      { ...spec, model },
      {
        adapter,
        spawnConfig: {
          compositionDir: spec.cwd || process.cwd(),
          model,
          serverPassword: SERVER_PASSWORD,
          // OPENCODE_CONFIG scopes BOTH the server boot and the `run` fallback to the
          // local provider + auto-allow.
          env: { ...process.env, OPENCODE_CONFIG: configPath }
        },
        writeArtifact,
        logDecision,
        secrets: SERVER_PASSWORD ? { OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD } : {},
        now: () => new Date().toISOString()
      },
      { modelAllowlist: MODEL_ALLOWLIST }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
