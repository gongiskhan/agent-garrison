#!/usr/bin/env node
// huggingface-runtime bridge — uniform runtime-bridge for HF-as-secondary via the
// Inference Providers router. delegate(task_spec) -> {summary, artifacts}. Task
// spec via STDIN (never argv). Same shape as the codex/gemini/openrouter bridges.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { OpenAICompatAdapter } from "../lib/openai-compat-adapter.mjs";

const DATA_DIR =
  process.env.HUGGINGFACE_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "huggingface-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
// HF repo ids are "org/model", optionally with a ":provider" suffix the router
// accepts to pin which inference provider serves the request.
const MODEL_ALLOWLIST = /^[a-z0-9._-]+\/[a-z0-9._-]+(:[a-z0-9-]+)?$/i;
const KEY_ENV = "HF_TOKEN";

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
    const r = spawnSync("python3", [cli, "write", "--namespace", ns, "--name", name], {
      input: content,
      encoding: "utf8"
    });
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

function adapter() {
  return new OpenAICompatAdapter({
    id: "huggingface",
    label: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    keyEnv: KEY_ENV
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    try {
      const response = await fetch("https://router.huggingface.co/v1/models", {
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        console.error(`huggingface router answered ${response.status}`);
        process.exit(1);
      }
      console.log("ok");
    } catch (err) {
      console.error(`huggingface router unreachable: ${err?.message || err}`);
      process.exit(1);
    }
    return;
  }
  const specFileIdx = argv.indexOf("--spec-file");
  const raw = specFileIdx >= 0 ? readFileSync(argv[specFileIdx + 1], "utf8") : readStdin();
  if (!raw.trim()) {
    console.error("no task spec on stdin (or --spec-file)");
    process.exit(2);
  }
  const spec = parseTaskSpec(raw);
  try {
    const result = await delegate(
      spec,
      {
        adapter: adapter(),
        spawnConfig: { compositionDir: spec.cwd || process.cwd(), model: spec.model, env: process.env },
        writeArtifact,
        logDecision,
        secrets: process.env[KEY_ENV] ? { [KEY_ENV]: process.env[KEY_ENV] } : {},
        now: () => new Date().toISOString()
      },
      { modelAllowlist: MODEL_ALLOWLIST, requiredKey: KEY_ENV }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exit(1);
  }
}

main();
