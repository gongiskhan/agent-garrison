#!/usr/bin/env node
// Verify hook (read-only): confirm the server module imports cleanly without
// starting a listener. Prints "ok" on success so the runner's verify step
// (expect: ok) passes. Does NOT require DEEPGRAM_API_KEY — a missing key is a
// runtime concern surfaced on /health, not a verify failure.
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
try {
  const mod = await import(path.join(here, "server.mjs"));
  if (typeof mod.startServer !== "function") {
    console.error("[probe] server.mjs did not export startServer");
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
} catch (err) {
  console.error(`[probe] failed to import server.mjs: ${err.message}`);
  process.exit(2);
}
