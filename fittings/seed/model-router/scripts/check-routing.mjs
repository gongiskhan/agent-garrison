#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileRoutingMarkdown, validateRoutingConfig } from "./lib/router-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG = process.env.GARRISON_ROUTING_CONFIG ?? path.join(ROOT, "routing.json");

async function main() {
  if (!process.argv.includes("--check")) {
    console.error("usage: check-routing.mjs --check");
    process.exit(2);
  }
  const config = JSON.parse(await fs.readFile(CONFIG, "utf8"));
  const errors = validateRoutingConfig(config);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  const compiled = compileRoutingMarkdown(config);
  if (!compiled.includes(`<!-- garrison:routing v1 profile=${config.activeProfile} -->`)) {
    console.error("compiled routing marker missing");
    process.exit(1);
  }
  process.stdout.write("ok\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
