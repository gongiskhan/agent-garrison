#!/usr/bin/env node
// Verify hook: confirm the UI is built and the skill file shipped, print "ok".
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, "..", "dist", "index.html");
const skillFile = path.resolve(here, "..", ".apm", "skills", "garrison-drill", "SKILL.md");

if (!existsSync(distIndex)) {
  console.error(`[probe] dist not built: ${distIndex}`);
  process.exit(2);
}
if (!existsSync(skillFile)) {
  console.error(`[probe] skill missing: ${skillFile}`);
  process.exit(3);
}

console.log("ok");
process.exit(0);
