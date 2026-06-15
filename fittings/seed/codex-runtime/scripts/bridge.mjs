#!/usr/bin/env node
// codex-runtime bridge — the uniform runtime-bridge entrypoint (BRIEF v4).
// Exposes delegate(task_spec) -> {summary, artifacts} for Codex-as-secondary.
//
// Usage:
//   bridge.mjs --probe                # health check, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//
// The task spec is read from STDIN (or --spec-file <path>) — NEVER interpolated
// into argv (shell-injection guard under bypassPermissions). Full output goes to
// the Artifact Store; the delegation is appended to decisions.jsonl; the return
// is a schema-validated {summary, artifacts}.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { delegate, parseTaskSpec } from "../../../../packages/claude-pty/src/runtime-bridge.mjs";
import { CodexAdapter } from "../lib/codex-adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CODEX_RUNTIME_DATA || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "codex-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const MODEL_ALLOWLIST = /^(gpt-5|o[34]|codex|gpt-4)/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Write full output to the Artifact Store. Prefers the documents fitting's
// artifacts.py write CLI when present (ARTIFACTS_CLI); falls back to a local file.
async function writeArtifact(ns, name, content) {
  const cli = process.env.ARTIFACTS_CLI;
  if (cli && existsSync(cli)) {
    const r = spawnSync("python3", [cli, "write", "--namespace", ns, "--name", name], { input: content, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      try {
        return JSON.parse(r.stdout).path || `${ns}/${name}`;
      } catch {
        /* fall through to local */
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
    const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
    if (v.status !== 0) {
      console.error("codex CLI not found on PATH");
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
  const adapter = new CodexAdapter();
  try {
    const result = await delegate(spec, {
      adapter,
      spawnConfig: { compositionDir: spec.cwd || process.cwd(), model: spec.model, env: process.env },
      writeArtifact,
      logDecision,
      secrets: process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {},
      now: () => new Date().toISOString()
    }, { modelAllowlist: MODEL_ALLOWLIST });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exit(1);
  }
}

main();
