import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// lang.mjs is mirrored between capture-service (where the utterance is heard)
// and kanban-loop (where the ack layer renders, in a different process), so
// both need the same detector. Same copy, same gate.
const CAPTURE_TO_KANBAN = ["lang.mjs"];

const captureLib = path.join(__dirname, "..", "fittings", "seed", "capture-service", "lib");
const kanbanLib = path.join(__dirname, "..", "fittings", "seed", "kanban-loop", "lib");

describe("companion lockstep mirrors", () => {
  for (const file of CAPTURE_TO_KANBAN) {
    it(`${file} is byte-identical between capture-service and kanban-loop`, () => {
      const original = readFileSync(path.join(captureLib, file), "utf8");
      const copy = readFileSync(path.join(kanbanLib, file), "utf8");
      expect(copy).toBe(original);
    });
  }
});
