#!/usr/bin/env node
// dispatcher — the Dispatcher duty CLI (MARATHON-V3 D6).
//
// Usage:
//   node scripts/dispatch.mjs --probe                # read-only self-test, prints "ok", no network
//   echo '<spec_json>' | node scripts/dispatch.mjs   # spec via STDIN -> a dispatch result JSON on STDOUT
//
// Spec (STDIN, JSON):
//   {
//     model:   { duties, selectedDuties },   # the resolved composition model
//     message: "the inbound task string",
//     cardLevel?: number,                     # a card-level explicit level (human override)
//     call?: { shape, provider, model, maxTokens, timeoutMs },  # the default dispatch cell
//     evidenceFile?: "path/to/decisions.jsonl"
//   }
//
// Result (STDOUT, JSON):
//   { duty, level, confidence, reason, overridden, overrideSource, dispatchOk, callError, evidence }
//
// The single-shot model call is delegated to the garrison-call fitting (never a
// primary, no session). This CLI resolves garrison-call as a sibling fitting and
// spawns it, piping the built call spec to its STDIN.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/dispatch-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --probe: prove the module loads and exposes the contract, without any network.
if (process.argv.includes("--probe")) {
  const needed = ["dispatch", "buildDispatchPrompt", "parseDispatch", "applyOverride", "routingEvidence"];
  const ok = needed.every((fn) => typeof core[fn] === "function");
  if (ok) {
    process.stdout.write("ok");
    process.exit(0);
  }
  process.stderr.write("probe failed: dispatch-core did not expose the expected contract\n");
  process.exit(1);
}

// Resolve the garrison-call script — a sibling fitting under the same parent dir
// (both in fittings/seed and in apm_modules/_local). Env override wins.
function resolveGarrisonCall() {
  const override = process.env.GARRISON_CALL_SCRIPT;
  if (override) return override;
  return path.resolve(HERE, "..", "..", "garrison-call", "scripts", "call.mjs");
}

// A garrison-call invoker: spawn the call script, pipe the spec JSON to STDIN,
// parse the result JSON from STDOUT. Never throws — a spawn/parse failure comes
// back as { ok:false, error } so dispatch() applies its documented fallback.
function makeCall(callScript) {
  return (spec) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [callScript], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        resolve({ ok: false, error: `spawn garrison-call failed: ${err?.message || String(err)}` });
        return;
      }
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (errOut += d.toString()));
      child.on("error", (err) => resolve({ ok: false, error: `garrison-call error: ${err?.message || String(err)}` }));
      child.on("close", () => {
        try {
          resolve(JSON.parse(out.trim()));
        } catch {
          resolve({ ok: false, error: `garrison-call returned non-JSON: ${(out || errOut).slice(0, 200)}` });
        }
      });
      child.stdin.write(JSON.stringify(spec));
      child.stdin.end();
    });
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
    process.stdout.write(JSON.stringify({ error: "no spec on STDIN — pipe a JSON spec object" }));
    process.exit(1);
  }
  let spec;
  try {
    spec = JSON.parse(input);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `spec is not valid JSON: ${err?.message || String(err)}` }));
    process.exit(1);
  }

  const model = spec.model ?? { duties: {}, selectedDuties: [] };
  const callOpts = spec.call ?? {};
  const call = makeCall(resolveGarrisonCall());

  const result = await core.dispatch(model, spec.message ?? "", {
    call,
    shape: callOpts.shape,
    provider: callOpts.provider,
    model: callOpts.model,
    maxTokens: callOpts.maxTokens,
    timeoutMs: callOpts.timeoutMs,
    cardLevel: spec.cardLevel,
    evidenceFile: spec.evidenceFile
  });

  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: `unexpected failure: ${err?.message || String(err)}` }));
  process.exit(1);
});
