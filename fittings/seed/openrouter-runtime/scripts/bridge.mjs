#!/usr/bin/env node
// openrouter-runtime bridge — uniform runtime-bridge for OpenRouter-as-secondary.
// delegate(task_spec) -> {summary, artifacts}. Task spec via STDIN (never argv).
// Same shape as codex/gemini bridges; the engine underneath is HTTP, not a CLI.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { OpenAICompatAdapter } from "../lib/openai-compat-adapter.mjs";

const DATA_DIR =
  process.env.OPENROUTER_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "openrouter-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
// OpenRouter model ids are always "vendor/model" - accept the whole catalog
// rather than a curated subset, so a model added upstream works immediately.
const MODEL_ALLOWLIST = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;
const KEY_ENV = "OPENROUTER_API_KEY";

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
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: KEY_ENV,
    // OpenRouter attributes traffic with these; they are optional but polite.
    headers: { "HTTP-Referer": "https://github.com/gongiskhan/agent-garrison", "X-Title": "Agent Garrison" }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    // Read-only liveness: the public catalog proves the endpoint is reachable
    // without spending a token or requiring a key to be present yet.
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        console.error(`openrouter catalog answered ${response.status}`);
        process.exit(1);
      }
      console.log("ok");
    } catch (err) {
      console.error(`openrouter unreachable: ${err?.message || err}`);
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
