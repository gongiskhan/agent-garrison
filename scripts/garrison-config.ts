#!/usr/bin/env tsx
// garrison config — CLI for the ~/.claude ↔ seed drift sync (S8, D25).
//   garrison config status   → show drift
//   garrison config pull      → write the seed payload into ~/.claude
//   garrison config commit    → capture ~/.claude drift into the seed, commit + push agent-garrison
//
// Logic lives in src/lib/claude-config-sync.ts (unit-tested); this wires paths
// + the git side of `commit`. Run via `npm run config -- <verb>`.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  computeDrift,
  configPull,
  configCaptureIntoPayload,
  writeBreadcrumb,
  formatStatus,
  generateCommitMessage
} from "../src/lib/claude-config-sync";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const PAYLOAD = path.join(REPO, "fittings/seed/claude-config/payload");

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
}

async function main(): Promise<number> {
  const verb = process.argv[2] || "status";

  if (verb === "status") {
    console.log(formatStatus(await computeDrift(CLAUDE_HOME, PAYLOAD)));
    return 0;
  }

  if (verb === "pull") {
    const written = await configPull(CLAUDE_HOME, PAYLOAD);
    await writeBreadcrumb(CLAUDE_HOME);
    console.log(written.length ? `garrison config pull: wrote ${written.length} file(s) into ~/.claude` : "garrison config pull: nothing to write (in sync)");
    for (const f of written) console.log(`  ${f}`);
    return 0;
  }

  if (verb === "commit") {
    const written = await configCaptureIntoPayload(CLAUDE_HOME, PAYLOAD);
    if (!written.length) {
      console.log("garrison config commit: no ~/.claude drift to capture");
      return 0;
    }
    const relPayload = path.relative(REPO, PAYLOAD);
    git(["add", "--", ...written.map((f) => path.join(relPayload, f))]);
    git(["commit", "-m", generateCommitMessage(written)]);
    console.log(`garrison config commit: captured ${written.length} file(s), committed to agent-garrison`);
    if (process.argv.includes("--push")) {
      git(["push"]);
      console.log("garrison config commit: pushed");
    } else {
      console.log("garrison config commit: pass --push to push (or run `git push` in the repo)");
    }
    return 0;
  }

  console.error(`unknown verb "${verb}" — use: status | pull | commit`);
  return 2;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
