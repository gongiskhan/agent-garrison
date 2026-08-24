#!/usr/bin/env node
// Generate the fittings' copies of the state client (and the repo-key
// normaliser for coord-mcp). ONE editable source, N verified copies —
// tests/state-client-drift.test.ts asserts every copy is byte-identical, so
// drift is a red test rather than a mystery. This is the honest form of
// vendoring, and what lets coord-mcp stay stdio and zero-dependency.
//
//   node scripts/sync-state-client.mjs           # write copies
//   node scripts/sync-state-client.mjs --check   # exit 1 on drift (CI/test)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SYNC_MANIFEST = [
  {
    source: "packages/garrison-state-client/index.mjs",
    header: "// GENERATED from packages/garrison-state-client/index.mjs — do not edit; run scripts/sync-state-client.mjs\n",
    targets: [
      "fittings/seed/kanban-loop/lib/state-client.mjs",
      "fittings/seed/scheduler/scripts/lib/state-client.mjs",
      "fittings/seed/coord-mcp/scripts/lib/state-client.mjs",
      "fittings/seed/improver/lib/state-client.mjs",
      "fittings/seed/orchestrator/lib/state-client.mjs",
      "fittings/seed/web-channel-default/lib/state-client.mjs",
      "fittings/seed/http-gateway/scripts/lib/state-client.mjs"
    ]
  },
  {
    source: "services/state/src/lib/repo-key.mjs",
    header: "// GENERATED from services/state/src/lib/repo-key.mjs — do not edit; run scripts/sync-state-client.mjs\n",
    targets: ["fittings/seed/coord-mcp/scripts/lib/repo-key.mjs"]
  }
];

export function expectedBody(entry) {
  const source = readFileSync(path.join(ROOT, entry.source), "utf8");
  return entry.header + source;
}

const check = process.argv.includes("--check");
let drift = 0;
for (const entry of SYNC_MANIFEST) {
  const body = expectedBody(entry);
  for (const target of entry.targets) {
    const abs = path.join(ROOT, target);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (current === body) continue;
    if (check) {
      console.error(`DRIFT: ${target} does not match ${entry.source}`);
      drift++;
    } else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      console.log(`synced ${target}`);
    }
  }
}
if (check && drift) process.exit(1);
if (check) console.log("state-client copies are in sync");
