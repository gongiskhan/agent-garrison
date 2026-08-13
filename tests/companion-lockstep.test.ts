// Lockstep mirror gate — the capture-service reuses omi-channel's wake bus,
// echo guard, board/memory/gateway clients and tailnet helper as
// BYTE-IDENTICAL COPIES (cross-fitting imports are forbidden; the modules
// take every source-specific value by injection). This test is what makes the
// copies safe: an edit to either side fails CI until both are synced — the
// same discipline run-spec-lockstep.test.ts applies to the routing mirrors.
//
// If this test failed on your change: edit the omi-channel original, then
// `cp fittings/seed/omi-channel/lib/<file> fittings/seed/capture-service/lib/`
// (or the reverse), and keep omi's suites green — the defaults must preserve
// omi behaviour exactly.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIRRORED = [
  "wake.mjs",
  "echo-guard.mjs",
  "board-client.mjs",
  "memory-writer.mjs",
  "gateway-client.mjs",
  "tailnet-serve.mjs"
];

const omiLib = path.join(__dirname, "..", "fittings", "seed", "omi-channel", "lib");
const captureLib = path.join(__dirname, "..", "fittings", "seed", "capture-service", "lib");

describe("companion lockstep mirrors", () => {
  for (const file of MIRRORED) {
    it(`${file} is byte-identical between omi-channel and capture-service`, () => {
      const original = readFileSync(path.join(omiLib, file), "utf8");
      const copy = readFileSync(path.join(captureLib, file), "utf8");
      expect(copy).toBe(original);
    });
  }
});
