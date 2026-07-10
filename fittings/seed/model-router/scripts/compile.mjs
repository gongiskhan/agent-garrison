#!/usr/bin/env node
// compile.mjs — the Orchestrator policy compiler CLI.
//   --check            compile the active Profile, assert it is byte-stable
//                      (compiling twice yields identical bytes), validate the
//                      config, print `routing-compile-ok`. Non-zero on failure.
//   --profile <name>   compile a specific Profile (default: activeProfile).
//   --out <file>       write the compiled routing.md (default: stdout).
//   --policy <file>    ALSO compile the machine-readable policy (D4) and write
//                      it atomically (temp+rename) to <file>; with --check the
//                      policy is compiled + byte-stability asserted, not written.
//   --config <file>    config path (default: ../config/routing.seed.json).
//
// Pure: the compiler does no I/O beyond reading the config and writing --out/--policy.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  compileRouting,
  validateRoutingConfig,
  routingMarker,
  routingMarkerV2,
  isV2,
  compilePolicy,
  stableStringify
} from "../lib/routing-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { check: false, profile: null, out: null, config: null, policy: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--policy") out.policy = argv[++i];
  }
  return out;
}

// Atomic write: temp file in the same dir, then rename (POSIX atomic).
function writeFileAtomic(path, contents) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, target);
}

function loadConfig(p) {
  const path = p ? resolve(p) : join(here, "..", "config", "routing.seed.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const errors = validateRoutingConfig(config);
  if (errors.length) {
    console.error("routing config INVALID:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  const profile = args.profile || config.activeProfile;
  const compiled = compileRouting(config, profile);

  if (args.check) {
    const again = compileRouting(config, profile);
    if (compiled !== again) {
      console.error("routing compile is NOT byte-stable (two compiles differ)");
      process.exit(1);
    }
    const marker = isV2(config) ? routingMarkerV2(profile) : routingMarker(profile);
    if (!compiled.includes(marker)) {
      console.error(`compiled output missing marker for profile ${profile}`);
      process.exit(1);
    }
    // The machine-readable policy must also compile + be byte-stable (D4).
    const policyBytes = stableStringify(compilePolicy(config, profile));
    if (policyBytes !== stableStringify(compilePolicy(config, profile))) {
      console.error("policy compile is NOT byte-stable (two compiles differ)");
      process.exit(1);
    }
    console.log(
      `routing-compile-ok profile=${profile} bytes=${Buffer.byteLength(compiled)} policyBytes=${Buffer.byteLength(policyBytes)}`
    );
    // S1 acceptance sentinel (FLOW_PLAN): a v2 policy compiled + byte-stable.
    if (isV2(config)) console.log("ORCHESTRATOR_POLICY_OK");
    return;
  }

  if (args.policy) {
    const policyBytes = stableStringify(compilePolicy(config, profile));
    writeFileAtomic(args.policy, policyBytes);
    console.log(`wrote ${args.policy} (${Buffer.byteLength(policyBytes)} bytes, profile=${profile})`);
  }

  if (args.out) {
    writeFileSync(resolve(args.out), compiled, "utf8");
    console.log(`wrote ${args.out} (${Buffer.byteLength(compiled)} bytes, profile=${profile})`);
  } else if (!args.policy) {
    process.stdout.write(compiled);
  }
}

main();
