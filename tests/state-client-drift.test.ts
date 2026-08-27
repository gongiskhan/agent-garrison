// Every generated copy of the state client (and repo-key) must be
// BYTE-IDENTICAL to its source. One editable source, N verified copies —
// drift is a red test, never a mystery.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

// Import the manifest from the sync script itself so the test can never
// drift from the generator.
import { SYNC_MANIFEST, expectedBody } from "../scripts/sync-state-client.mjs";

describe("state client copies", () => {
  for (const entry of SYNC_MANIFEST) {
    for (const target of entry.targets) {
      it(`${target} matches ${entry.source}`, () => {
        const actual = readFileSync(path.join(ROOT, target), "utf8");
        expect(actual).toBe(expectedBody(entry));
      });
    }
  }
});
