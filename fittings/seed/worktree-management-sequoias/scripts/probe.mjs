#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const args = new Set(process.argv.slice(2));
const here = path.dirname(url.fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, "..", "dist", "index.html");

if (!existsSync(distIndex)) {
  console.error(`[probe] dist not built: ${distIndex}`);
  process.exit(2);
}

try {
  execSync("git --version", { stdio: "ignore" });
} catch {
  console.error("[probe] git not found");
  process.exit(3);
}

if (args.has("--probe")) {
  console.log("ok");
  process.exit(0);
}
console.log("ok");
process.exit(0);
