// Detached eager-boot runner. Spawned by src/instrumentation.ts via tsx so
// the eager-boot import chain (node:child_process etc.) never enters Next's
// webpack instrumentation compilation, which cannot handle node:-scheme
// imports on Next 14 (verified: every route 500s if it tries).

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { garrisonDir } from "../src/lib/claude-home";
import { runEagerBoot } from "../src/lib/eager-boot";

async function main(): Promise<void> {
  const summary = await runEagerBoot();
  const line = `${new Date().toISOString()} eager-boot booted=[${summary.booted.join(",")}] warmed=[${summary.warmed.join(",")}] skipped=[${summary.skipped.join(",")}]\n`;
  try {
    const logDir = path.join(garrisonDir(), "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, "eager-boot.log"), line);
  } catch {
    // Logging is best-effort; the boot itself already happened.
  }
  console.log(line.trim());
}

main().catch((error) => {
  console.error("[garrison] eager-boot runner failed:", error);
  process.exit(1);
});
