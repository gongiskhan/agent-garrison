#!/usr/bin/env node
// garrison-up — set the active-composition pointer and switch to it (WS4 / D6).
//
// Usage:
//   node scripts/garrison-up.mjs --composition <id-or-path>
//   node scripts/garrison-up.mjs -c <id-or-path>
//   node scripts/garrison-up.mjs --composition=<id-or-path>
//   node scripts/garrison-up.mjs --help
//
// <id-or-path> is either a composition id under compositions/ (e.g. "default")
// or a filesystem path to an apm.yml (or a directory containing one).
//
// Behaviour: resolves the target FIRST (reads its apm.yml, runs the capability
// resolver). On a resolver error it prints the message and exits non-zero
// WITHOUT changing running state or the pointer. Otherwise it downs the current
// active composition, writes the pointer, and ups the target.
//
// This CLI imports Garrison's TypeScript lib. When run under plain `node` it
// re-execs itself through the repo's local tsx so the .ts imports resolve; the
// GARRISON_UP_TSX guard prevents an infinite re-exec loop.

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Pure arg parser — exported for the unit test. Recognises --composition / -c
// (space- or =-separated) and --help / -h. Unknown flags are ignored.
export function parseGarrisonUpArgs(argv) {
  const out = { composition: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--composition" || arg === "-c") {
      out.composition = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--composition=")) {
      out.composition = arg.slice("--composition=".length);
    } else if (arg.startsWith("-c=")) {
      out.composition = arg.slice("-c=".length);
    }
  }
  if (out.composition !== null) out.composition = out.composition.trim() || null;
  return out;
}

const HELP = `garrison-up — switch the active composition

Usage:
  node scripts/garrison-up.mjs --composition <id-or-path>
  node scripts/garrison-up.mjs -c <id-or-path>

Options:
  -c, --composition <id-or-path>  Composition id (under compositions/) or a path
                                  to an apm.yml (or a dir containing one).
  -h, --help                      Show this help.`;

async function main() {
  const args = parseGarrisonUpArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.composition) {
    console.error("error: --composition <id-or-path> is required\n");
    console.error(HELP);
    return 2;
  }

  const here = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(here), "..");

  // Re-exec under the local tsx so the TypeScript imports below resolve when
  // this file is run by plain `node`.
  if (!process.env.GARRISON_UP_TSX) {
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const res = spawnSync(tsxBin, [here, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, GARRISON_UP_TSX: "1" }
    });
    return res.status ?? 1;
  }

  const { switchComposition } = await import(path.join(repoRoot, "src/lib/composition-switch.ts"));
  const { resolveCompositionPointer } = await import(path.join(repoRoot, "src/lib/active-composition.ts"));

  const resolved = resolveCompositionPointer(args.composition);
  console.log(`garrison-up: switching to "${args.composition}" (id: ${resolved.id})`);
  const result = await switchComposition(args.composition);
  if (!result.ok) {
    console.error(`garrison-up: switch blocked\n${result.error}`);
    return 1;
  }
  console.log(`garrison-up: active composition is now "${result.id}"`);
  return 0;
}

// Only run when invoked directly (so a vitest import of parseGarrisonUpArgs
// never triggers the re-exec / switch side effects).
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    });
}
