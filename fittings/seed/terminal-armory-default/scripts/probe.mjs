#!/usr/bin/env node
import { existsSync } from "node:fs";
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
  const ptyVersion = (await import("node-pty/package.json", { assert: { type: "json" } })).default?.version;
  if (!ptyVersion) {
    console.error("[probe] node-pty not loadable");
    process.exit(3);
  }
} catch {
  // node 20 may not support import assertions; try alternative
  try {
    await import("node-pty");
  } catch (err) {
    console.error(`[probe] node-pty not loadable: ${err.message}`);
    process.exit(3);
  }
}

if (args.has("--probe")) {
  console.log("ok");
  process.exit(0);
}
console.log("ok");
process.exit(0);
