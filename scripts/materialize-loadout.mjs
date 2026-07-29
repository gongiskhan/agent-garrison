#!/usr/bin/env node
// Materialize a Loadout on THIS machine (brief Phase 1, host-local proof).
//
// Runs the same materializer the outpost worker runs, against a vault-rendered
// .env produced here. Sharing the code is the point: a host-local green run is
// only evidence for the remote case if both execute identical logic.
//
// Usage:
//   node scripts/materialize-loadout.mjs <loadout-id> [--target <dir>] [--branch <b>] [--dry-env]
//
//   --target   materialize into this directory instead of the projects root
//   --branch   check out this branch instead of the descriptor's default
//   --dry-env  resolve the vault and REPORT which names resolved (and from
//              which key), without cloning or running anything. Prints no values.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// The app's TS libs are not importable from a bare .mjs, so shell out to tsx for
// the vault-facing half. Keeps the secret handling in ONE implementation
// (src/lib/loadout.ts) rather than a second copy that could drift.
function renderEnvViaTsx(loadoutId) {
  // Wrapped in an async IIFE: `tsx -e` compiles to CJS, where TOP-LEVEL AWAIT
  // is a hard error ("not supported with the cjs output format").
  const script = `
    import { readLoadout, renderLoadoutEnv } from "./src/lib/loadout";
    (async () => {
      const l = await readLoadout(${JSON.stringify(loadoutId)});
      if (!l) { console.error("no such loadout: " + ${JSON.stringify(loadoutId)}); process.exit(2); }
      const rendered = await renderLoadoutEnv(l);
      process.stdout.write(JSON.stringify({ loadout: l, ...rendered }));
    })().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
  `;
  const res = spawnSync("npx", ["tsx", "-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (res.status !== 0) {
    console.error(res.stderr || "failed to render the loadout env");
    process.exit(res.status ?? 1);
  }
  return JSON.parse(res.stdout);
}

async function main() {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("usage: materialize-loadout.mjs <loadout-id> [--target <dir>] [--branch <b>] [--dry-env]");
    process.exit(2);
  }
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : null;
  };

  const { loadout, content, resolved, missing } = renderEnvViaTsx(id);

  console.log(`loadout:  ${loadout.id}`);
  console.log(`remote:   ${loadout.repo_remote}`);
  console.log(`branch:   ${flag("branch") || loadout.default_branch}`);
  console.log(`env vars: ${resolved.length} declared`);
  for (const r of resolved) {
    // Names and their SOURCE KEY only. Never a value. The source is worth
    // printing because it is how you see the PROJECT__VAR override taking
    // effect rather than silently falling back to the shared value.
    console.log(`  ${r.found ? "ok  " : "MISS"} ${r.name}${r.source && r.source !== r.name ? `  <- ${r.source}` : ""}`);
  }
  if (missing.length) {
    console.error(`\nmissing from the vault: ${missing.join(", ")}`);
    console.error("add them in the Vault surface, then re-run.");
    process.exit(1);
  }
  if (args.includes("--dry-env")) {
    console.log("\n--dry-env: resolved cleanly, nothing materialized.");
    console.log("LOADOUT-ENV-OK");
    return;
  }

  const { materialize, materializationTranscript } = await import(
    path.join(repoRoot, "fittings/seed/outpost-worker/scripts/materialize.mjs")
  );

  const projectsRoot = flag("target")
    ? path.dirname(path.resolve(flag("target")))
    : path.join(process.env.HOME || "", "dev");
  // --target names the checkout dir itself; the materializer composes
  // <projectsRoot>/<id>, so pin the id when the caller overrides the path.
  const effective = flag("target")
    ? { ...loadout, id: path.basename(path.resolve(flag("target"))) }
    : loadout;

  const started = Date.now();
  const result = await materialize(effective, {
    projectsRoot,
    envContent: content,
    branch: flag("branch"),
    log: (m) => console.log(`  ${m}`)
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${materializationTranscript(result, { secretValues: [] })}`);
  if (!result.ok) {
    console.error(`materialization FAILED at "${result.failed}" after ${secs}s`);
    process.exit(1);
  }
  console.log(`materialized ${loadout.id} -> ${result.target} in ${secs}s`);
  console.log("LOADOUT-MATERIALIZE-OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
