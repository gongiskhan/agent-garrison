#!/usr/bin/env node
// opencode-runtime bridge — the uniform runtime-bridge entrypoint (BRIEF v4).
// Exposes delegate(task_spec) -> {summary, artifacts} for OpenCode-as-secondary.
//
// Usage:
//   bridge.mjs --probe                # health check, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//
// Per turn the bridge runs a stateless `opencode run --format json --auto` subprocess
// with the prompt on STDIN (never argv → shell-injection safe under bypassPermissions),
// captures the minted opencode session id for `-s` resume, and returns a
// schema-validated {summary, artifacts}. Unlike Codex there is NO shared-token
// revocation, so NO machine-wide serialization lock is needed — concurrent opencode
// processes are safe. See codex-runtime/scripts/bridge.mjs for the shared shape.
//
// Provider/model come from opencode's native config (~/.config/opencode/opencode.json):
// `model` is provider/model (default a LOCAL ollama model, so delegation is bill-free
// once the provider is configured there — see the fitting's for_consumers).
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { OpenCodeAdapter } from "../lib/opencode-adapter.mjs";

const DATA_DIR =
  process.env.OPENCODE_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "opencode-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const DEFAULT_MODEL = process.env.OPENCODE_MODEL || "ollama-local/qwen2.5:3b";
// `provider/model` — a provider slug + a model id that may itself carry colons/slashes
// (e.g. "ollama-local/qwen2.5:3b"). The delegate model comes from the task spec, else default.
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    // Health probe: `opencode --version` must succeed AND print a version string
    // (offline-safe, no model turn).
    const v = spawnSync("opencode", ["--version"], { encoding: "utf8" });
    const out = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim();
    if (v.status !== 0 || !/\d+\.\d+/.test(out)) {
      console.error("opencode CLI not found on PATH (or no version string)");
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
  const adapter = new OpenCodeAdapter();

  try {
    const result = await delegate(
      { ...spec, model },
      {
        adapter,
        spawnConfig: {
          compositionDir: spec.cwd || process.cwd(),
          model,
          sessionId: spec.sessionId ?? null,
          env: process.env
        },
        writeArtifact,
        logDecision,
        secrets: {},
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
