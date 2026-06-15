#!/usr/bin/env node
// compile.mjs — the Model Router compiler CLI.
//   --check            compile the active Profile, assert it is byte-stable
//                      (compiling twice yields identical bytes), validate the
//                      config, print `routing-compile-ok`. Non-zero on failure.
//   --profile <name>   compile a specific Profile (default: activeProfile).
//   --out <file>       write the compiled routing.md (default: stdout).
//   --config <file>    config path (default: ../config/routing.seed.json).
//
// Pure: the compiler does no I/O beyond reading the config and writing --out.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { compileRouting, validateRoutingConfig, routingMarker } from "../lib/routing-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { check: false, profile: null, out: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--config") out.config = argv[++i];
  }
  return out;
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
    if (!compiled.includes(routingMarker(profile))) {
      console.error(`compiled output missing marker for profile ${profile}`);
      process.exit(1);
    }
    console.log(`routing-compile-ok profile=${profile} bytes=${Buffer.byteLength(compiled)}`);
    return;
  }

  if (args.out) {
    writeFileSync(resolve(args.out), compiled, "utf8");
    console.log(`wrote ${args.out} (${Buffer.byteLength(compiled)} bytes, profile=${profile})`);
  } else {
    process.stdout.write(compiled);
  }
}

main();
