#!/usr/bin/env node
// probe.mjs — verify hook (read-only): compile the active Profile and assert
// the config is valid + byte-stable, then print `ok`. Refuses silent success.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compileRouting, validateRoutingConfig } from "../lib/routing-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

try {
  const config = JSON.parse(readFileSync(join(here, "..", "config", "routing.seed.json"), "utf8"));
  const errors = validateRoutingConfig(config);
  if (errors.length) {
    console.error("routing config invalid: " + errors.join("; "));
    process.exit(1);
  }
  const a = compileRouting(config, config.activeProfile);
  const b = compileRouting(config, config.activeProfile);
  if (a !== b || !a.length) {
    console.error("routing compile not byte-stable");
    process.exit(1);
  }
  console.log("ok");
} catch (err) {
  console.error("probe failed: " + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
