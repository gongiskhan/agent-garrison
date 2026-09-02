// Lockstep mirror gate - omi-channel and capture-service share their
// board/memory/gateway clients and tailnet helper as BYTE-IDENTICAL COPIES
// (cross-fitting imports are forbidden; the modules take every source-specific
// value by injection). This test is what makes the copies safe: an edit to
// either side fails CI until both are synced - the same discipline
// run-spec-lockstep.test.ts applies to the routing mirrors.
//
// Since 2026-09-02 the wake bus, echo guard and language detector live ONLY in
// capture-service (the one voice layer); omi-channel forwards transcripts to it
// over HTTP and no longer carries those modules, so they left this list.
//
// If this test failed on your change: edit one side, then
// `cp fittings/seed/omi-channel/lib/<file> fittings/seed/capture-service/lib/`
// (or the reverse), and keep both suites green.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIRRORED = [
  "board-client.mjs",
  "memory-writer.mjs",
  "gateway-client.mjs",
  "tailnet-serve.mjs"
];

// lang.mjs is mirrored between capture-service (where the utterance is heard)
// and kanban-loop (where the ack layer renders, in a different process), so
// both need the same detector. Same copy, same gate.
const CAPTURE_TO_KANBAN = ["lang.mjs"];

const omiLib = path.join(__dirname, "..", "fittings", "seed", "omi-channel", "lib");
const captureLib = path.join(__dirname, "..", "fittings", "seed", "capture-service", "lib");
const kanbanLib = path.join(__dirname, "..", "fittings", "seed", "kanban-loop", "lib");

describe("companion lockstep mirrors", () => {
  for (const file of MIRRORED) {
    it(`${file} is byte-identical between omi-channel and capture-service`, () => {
      const original = readFileSync(path.join(omiLib, file), "utf8");
      const copy = readFileSync(path.join(captureLib, file), "utf8");
      expect(copy).toBe(original);
    });
  }

  for (const file of CAPTURE_TO_KANBAN) {
    it(`${file} is byte-identical between capture-service and kanban-loop`, () => {
      const original = readFileSync(path.join(captureLib, file), "utf8");
      const copy = readFileSync(path.join(kanbanLib, file), "utf8");
      expect(copy).toBe(original);
    });
  }
});
