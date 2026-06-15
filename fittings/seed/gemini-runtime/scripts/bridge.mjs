#!/usr/bin/env node
// gemini-runtime bridge — uniform runtime-bridge for Gemini-as-secondary (capability
// delegation incl. image). delegate(task_spec) -> {summary, artifacts}. Task spec
// via STDIN (never argv). See codex-runtime/scripts/bridge.mjs for the shared shape.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { delegate, parseTaskSpec } from "../../../../packages/claude-pty/src/runtime-bridge.mjs";
import { GeminiAdapter } from "../lib/gemini-adapter.mjs";

const DATA_DIR = process.env.GEMINI_RUNTIME_DATA || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "gemini-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const MODEL_ALLOWLIST = /^gemini[-_.\d a-z]*/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

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
    const v = spawnSync("gemini", ["--version"], { encoding: "utf8" });
    if (v.status !== 0) {
      console.error("gemini CLI not found on PATH");
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
  const adapter = new GeminiAdapter();
  try {
    const result = await delegate(
      spec,
      {
        adapter,
        spawnConfig: { compositionDir: spec.cwd || process.cwd(), model: spec.model, env: process.env },
        writeArtifact,
        logDecision,
        secrets: process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {},
        now: () => new Date().toISOString()
      },
      { modelAllowlist: MODEL_ALLOWLIST }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exit(1);
  }
}

main();
