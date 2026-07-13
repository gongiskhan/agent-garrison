#!/usr/bin/env node
// garrison-call — the single-shot / structured LLM call interface.
//
// Usage:
//   node scripts/call.mjs --probe                 # read-only self-test, prints "ok", no network
//   echo '<spec_json>' | node scripts/call.mjs    # spec via STDIN (never argv) -> result JSON on STDOUT
//
// Spec (STDIN, JSON):
//   { shape, baseUrl?, provider?, model, prompt | messages, system?, schema?, timeoutMs?, maxTokens? }
//     shape:    "anthropic" | "openai" | "ollama"   (wire protocol)
//     provider: a named entry in the allowlist table (anthropic | ollama-local | deepseek | zai-glm | openai)
//     baseUrl:  an explicit base URL — allowed ONLY if it is a listed entry, or loopback for the ollama/openai shapes
//     schema:   a JSON schema; when present the call is STRUCTURED (output parsed + validated, returned as `structured`)
//
// Result (STDOUT, JSON):
//   { ok:true, text }              # unstructured
//   { ok:true, structured, usage } # structured (schema validated)
//   { ok:false, error }            # fence / missing-key / network / non-2xx / bad-JSON — error is secret-free
//
// SECRETS: provider keys are resolved from the environment BY VAULT NAME
// (never hardcoded here, never printed). The base-URL fence is default-deny — an
// unlisted, non-loopback base URL is rejected loudly. NEVER a primary: no tool
// loop, no session, one request only.

import { readFileSync } from "node:fs";
import { runCall } from "../lib/call-core.mjs";
import { PROVIDERS, SHAPES } from "../lib/providers.mjs";

// --probe: prove the module + provider table load, without any network call.
if (process.argv.includes("--probe")) {
  const providerCount = Object.keys(PROVIDERS).length;
  if (providerCount > 0 && SHAPES.length === 3 && typeof runCall === "function") {
    process.stdout.write("ok");
    process.exit(0);
  }
  process.stderr.write("probe failed: provider table or shapes not loaded\n");
  process.exit(1);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const input = readStdin().trim();
  if (!input) {
    process.stdout.write(JSON.stringify({ ok: false, error: "no spec on STDIN — pipe a JSON spec object" }));
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(input);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: `spec is not valid JSON: ${err?.message || String(err)}` }));
    process.exit(1);
  }

  const result = await runCall(spec);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  // Last-resort guard: still emit the contract shape on an unexpected throw.
  process.stdout.write(JSON.stringify({ ok: false, error: `unexpected failure: ${err?.message || String(err)}` }));
  process.exit(1);
});
