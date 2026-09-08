import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
// @ts-ignore pure mjs
import { readJsonlLines } from "../packages/talk/src/session-transcript.mjs";

describe("native journal tail offsets", () => {
  it("keeps byte offsets correct when a bounded initial tail starts inside UTF-8", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "native-offset-"));
    const file = path.join(dir, "journal.jsonl");
    try {
      const initial = '{"text":"😀"}\n';
      writeFileSync(file, initial);
      const start = Buffer.from(initial).indexOf(Buffer.from("😀")) + 1;
      const first = await readJsonlLines(file, start);
      expect(first.offset).toBe(Buffer.byteLength(initial));
      appendFileSync(file, '{"text":"next complete record"}\n');
      const next = await readJsonlLines(file, first.offset);
      expect(next.lines).toEqual(['{"text":"next complete record"}']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
