#!/usr/bin/env node
// openai-agents-runtime bridge - the uniform runtime-bridge entrypoint (invocable
// face). Exposes delegate(task_spec) -> {summary, artifacts} for
// openai-agents-as-secondary, over an OpenAI-compatible endpoint (OpenAI cloud /
// local Ollama / any /v1/chat/completions base URL).
//
// Usage:
//   bridge.mjs --probe                              # read-only self-test, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//
// The API key is resolved BY NAME (OPENAI_API_KEY) from the server-side env the
// runner materializes from the Vault - it never enters argv and never reaches a
// browser. Full output -> Artifact Store; the delegation -> decisions.jsonl; the
// return is a schema-validated {summary, artifacts}. The self-test imports NO SDK
// and makes NO network call.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { OpenAiAgentsAdapter } from "../lib/openai-adapter.mjs";
import { buildHarness } from "../lib/harness.mjs";
import { OPENAI_PROVIDERS, capabilityRecord, resolveEndpoint, DEFAULT_API_KEY_ENV } from "../lib/providers.mjs";

const DATA_DIR =
  process.env.OPENAI_AGENTS_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "openai-agents-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
// Broad allowlist: any OpenAI-compatible model string a provider fronts (an Ollama
// tag, a gpt-* / o-* slot, a vLLM/Groq/Together model id, new drops).
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

// Read-only self-test: the harness wires per-mode, the three OpenAI-compatible
// providers are present, ollama-local's capability record is text + tool-use only
// (no vision/MCP), and the by-name Vault key resolves for a keyless local target
// without a secret. No SDK import, no network.
function selfTest() {
  const full = buildHarness("full");
  const lean = buildHarness("lean");
  if (!full.toolsEnabled || !full.instructions) throw new Error("harness full FAILED");
  if (lean.toolsEnabled || !lean.instructions) throw new Error("harness lean FAILED");

  for (const p of ["openai", "ollama-local", "openai-compat"]) {
    if (!OPENAI_PROVIDERS[p]) throw new Error(`provider "${p}" is missing from the table`);
  }
  const local = capabilityRecord({ provider: "ollama-local" });
  if (local.image || local.mcp || local.webSearch || local.document) {
    throw new Error("ollama-local capability record must be text + tool-use only");
  }
  // A keyless local endpoint resolves without a secret (the by-name key path is
  // exercised for real for the cloud providers at delegate time).
  const ep = resolveEndpoint({ provider: "ollama-local" }, { secrets: null });
  if (!ep.baseUrl) throw new Error("ollama-local endpoint did not resolve");

  return Object.keys(OPENAI_PROVIDERS);
}

// The by-name Vault key a provider needs (null for keyless local providers).
function apiKeyEnvForProvider(provider) {
  const spec = OPENAI_PROVIDERS[provider];
  if (!spec || !spec.needsKey) return null;
  return spec.apiKeyEnv || DEFAULT_API_KEY_ENV;
}

// Build the spawnConfig from an untrusted (LLM-authored) task spec + the trusted
// server-side context. Exported + pure so the key-exfil trust boundary is
// unit-testable (codex S2a finding): a keyed provider's baseUrl must come ONLY
// from the trusted env (OPENAI_BASE_URL, via resolveBaseUrl), never from
// spec.baseUrl — otherwise the spec could redirect where the vault key is sent.
// spec.baseUrl is honored only for a keyless (local, unauthenticated) endpoint.
export function buildSpawnConfig(spec, { provider, keyless, secrets, haveSecrets, env }) {
  return {
    compositionDir: spec.cwd || (env && env.PWD) || process.cwd(),
    provider,
    model: spec.model,
    promptMode: spec.promptMode || "full",
    baseUrl: keyless ? spec.baseUrl : undefined,
    keyless,
    secrets: haveSecrets ? secrets : null,
    maxTurns: spec.maxTurns,
    budgetTokens: spec.budgetTokens,
    env
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    try {
      const providers = selfTest();
      console.log("ok");
      if (argv.includes("--verbose")) console.log(JSON.stringify({ providers }));
    } catch (e) {
      console.error("openai-agents-runtime self-test failed:", e?.message || e);
      process.exit(1);
    }
    return;
  }

  // STDIN-only task spec (codex S2a finding): no --spec-file / argv path. The
  // delegate spec is untrusted (LLM-authored); reading it only from stdin keeps
  // the input channel single + auditable.
  const raw = readStdin();
  if (!raw.trim()) {
    console.error("no task spec on stdin");
    process.exit(2);
  }
  const spec = parseTaskSpec(raw);

  const provider = spec.provider || "ollama-local";
  const keyless = provider === "openai-compat" && spec.keyless === true;
  const adapter = new OpenAiAgentsAdapter();
  // Resolve the by-name Vault key from the SERVER-SIDE env (materialized from the
  // Vault by the runner). Never read from the task spec / argv.
  const apiKeyEnv = keyless ? null : apiKeyEnvForProvider(provider);
  const secrets = {};
  if (apiKeyEnv && process.env[apiKeyEnv]) secrets[apiKeyEnv] = process.env[apiKeyEnv];
  const haveSecrets = Object.keys(secrets).length > 0;

  try {
    const result = await delegate(
      spec,
      {
        adapter,
        spawnConfig: buildSpawnConfig(spec, { provider, keyless, secrets, haveSecrets, env: process.env }),
        writeArtifact,
        logDecision,
        secrets: haveSecrets ? secrets : {},
        now: () => new Date().toISOString()
      },
      { modelAllowlist: MODEL_ALLOWLIST, requiredKey: apiKeyEnv || undefined }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exit(1);
  }
}

// Run only when invoked as a script, not when imported for unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
