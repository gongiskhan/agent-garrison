#!/usr/bin/env node
// agent-sdk-runtime bridge — the uniform runtime-bridge entrypoint (BRIEF §"The
// adapter", invocable face). Exposes delegate(task_spec) -> {summary, artifacts}
// for agent-sdk-as-secondary.
//
// Usage:
//   bridge.mjs --probe                              # read-only self-test, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//
// The runtime is first-class routable to any provider in the SDK provider table,
// including the Anthropic endpoint on the Max subscription (D29). Full output ->
// Artifact Store; the delegation -> decisions.jsonl; the return is a
// schema-validated {summary, artifacts}. The self-test imports NO SDK and makes
// NO network call.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { AgentSdkAdapter } from "../lib/agent-sdk-adapter.mjs";
import { buildHarness } from "../lib/harness.mjs";
import { SDK_PROVIDERS, capabilityRecord } from "../lib/providers.mjs";

const DATA_DIR =
  process.env.AGENT_SDK_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "agent-sdk-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
// Broad allowlist: any Anthropic-compatible model string a provider fronts (Ollama
// tags, GLM/DeepSeek/MiniMax slots, proxied OpenAI/Gemini/Qwen, new drops).
const MODEL_ALLOWLIST = /^[\w./:+-]{1,128}$/;

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

// Read-only self-test: the harness wires per-mode and never loads user settings,
// the Anthropic subscription provider is present (first-class, D29), and
// DeepSeek's capability record is text+tool-use only.
function selfTest() {
  const full = buildHarness("full");
  const lean = buildHarness("lean");
  if (full.preset !== "claude_code" || !full.settingSources.includes("project")) throw new Error("harness full FAILED");
  if (lean.preset !== null || lean.settingSources.length !== 0) throw new Error("harness lean FAILED");
  if (full.settingSources.includes("user") || lean.settingSources.includes("user")) {
    throw new Error("harness must not load user settings (#217 defence)");
  }

  if (!SDK_PROVIDERS.anthropic) throw new Error("the Anthropic subscription provider is missing (D29)");
  const ds = capabilityRecord({ provider: "deepseek" });
  if (ds.mcp || ds.image || ds.document || ds.webSearch) throw new Error("deepseek capability record must be text+tool-use only");

  return Object.keys(SDK_PROVIDERS);
}

function vaultKeyForProvider(provider) {
  return SDK_PROVIDERS[provider]?.vaultKey || null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    try {
      const providers = selfTest();
      console.log("ok");
      if (argv.includes("--verbose")) console.log(JSON.stringify({ providers }));
    } catch (e) {
      console.error("agent-sdk-runtime self-test failed:", e?.message || e);
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

  const provider = spec.provider || "ollama-local";
  const adapter = new AgentSdkAdapter();
  const vk = vaultKeyForProvider(provider);
  const secrets = {};
  if (vk && process.env[vk]) secrets[vk] = process.env[vk];
  const haveSecrets = Object.keys(secrets).length > 0;

  try {
    const result = await delegate(
      spec,
      {
        adapter,
        spawnConfig: {
          compositionDir: spec.cwd || process.cwd(),
          provider,
          model: spec.model,
          promptMode: spec.promptMode || "full",
          baseUrl: spec.baseUrl,
          secrets: haveSecrets ? secrets : null,
          maxTurns: spec.maxTurns,
          budgetTokens: spec.budgetTokens,
          env: process.env
        },
        writeArtifact,
        logDecision,
        secrets: haveSecrets ? secrets : {},
        now: () => new Date().toISOString()
      },
      { modelAllowlist: MODEL_ALLOWLIST, requiredKey: vk || undefined }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exit(1);
  }
}

main();
