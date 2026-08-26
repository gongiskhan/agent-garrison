// Card-log write ordering.
//
// The second half of this file drove processCard, which owned the live-log
// lifecycle: drain the streamed chunks, then write the authoritative reply, then
// ignore any late callback a transport still held. processCard is gone with the
// Conversations cut and the conversation store owns a turn's transcript now, so
// what remains here is the board-side invariant it was built on — concurrent
// rewrites of one log file must not share a temp path.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore pure mjs
import { writeCardLog } from "../fittings/seed/kanban-loop/lib/board.mjs";

describe("Kanban live-log write ordering", () => {
  it("uses independent atomic temp files for concurrent rewrites", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-log-atomic-"));
    const id = "01LOGRACECARD0000000000000";
    const payloads = Array.from(
      { length: 32 },
      (_, index) => `payload-${index}:${String(index).repeat(2048)}`
    );

    await expect(Promise.all(
      payloads.map((payload) => writeCardLog(root, id, 1, payload))
    )).resolves.toHaveLength(payloads.length);

    const cardDir = path.join(root, "cards", id);
    const written = readFileSync(path.join(cardDir, "log-1.md"), "utf8");
    expect(payloads.map((payload) => `${payload}\n`)).toContain(written);
    expect(readdirSync(cardDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

});
