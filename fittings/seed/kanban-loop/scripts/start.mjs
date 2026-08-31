#!/usr/bin/env node
// Kanban Loop own-port entrypoint — invoked by Garrison's runner during
// composition `up` (startOwnPortFitting spawns scripts/start.mjs), by eager
// boot, and by the per-fitting /api/fittings/kanban-loop/start path. Hands off
// to server.mjs, which binds the board port, writes the ~/.garrison/ui-fittings
// status file Garrison surfaces at /embed/kanban-loop, and serves the REST/SSE
// surface + the responsive board UI.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

// Self-heal a stale UI bundle before serving. The process spawns from the
// CHECKOUT SEED dir while `apm install`'s setup hook rebuilds the INSTALLED
// copy's dist/ - so every UI edit in the seed tree silently served the old
// bundle until someone rebuilt by hand (live 2026-08-31: the date-to-footer
// work sat invisible behind an 08:28 bundle all day). If any ui/ source is
// newer than dist/kanban.bundle.js, rebuild; a build failure serves the stale
// bundle rather than nothing, loudly.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const bundle = statSync(path.join(ROOT, "dist", "kanban.bundle.js")).mtimeMs;
  const newest = readdirSync(path.join(ROOT, "ui"))
    .map((f) => statSync(path.join(ROOT, "ui", f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  if (newest > bundle) {
    console.error("[kanban-loop] ui/ newer than dist/ - rebuilding the bundle");
    execFileSync(process.execPath, [path.join(ROOT, "ui", "build.mjs")], { stdio: "inherit" });
  }
} catch (err) {
  console.error("[kanban-loop] bundle staleness check failed (serving as-is):", err?.message ?? err);
}

startServer().catch((err) => {
  console.error("[kanban-loop] start failed:", err);
  process.exit(1);
});
