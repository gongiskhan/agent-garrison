import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
// @ts-ignore pure mjs
import { readCursorDesktopTranscript } from "../packages/talk/src/cursor-desktop-transcript.mjs";

describe("Cursor IDE output without a JSONL journal", () => {
  it("reads only the selected composer's ordered message text and sees its revision", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-ide-output-"));
    const db = path.join(dir, "state.vscdb");
    const sql = (statement: string) => execFileSync("sqlite3", [db, statement]);
    const row = (key: string, value: object) => sql(`insert or replace into cursorDiskKV values ('${key}', '${JSON.stringify(value).replace(/'/g, "''")}');`);
    try {
      sql("create table cursorDiskKV (key text primary key, value text);");
      row("composerData:neutral", { fullConversationHeadersOnly: [{ bubbleId: "u1" }, { bubbleId: "a1" }], privateContext: "DO_NOT_READ" });
      row("bubbleId:neutral:u1", { bubbleId: "u1", type: 1, text: "Check the layout." });
      row("bubbleId:neutral:a1", { bubbleId: "a1", type: 2, text: "Reviewing…", images: ["DO_NOT_READ"] });
      row("bubbleId:other:a1", { bubbleId: "a1", type: 2, text: "OTHER_COMPOSER" });
      let result = readCursorDesktopTranscript(db, "neutral");
      expect(result.available).toBe(true);
      expect(result.events.map((e: { id: string }) => e.id)).toEqual(["cursor-db:u1", "cursor-db:a1"]);
      expect(JSON.stringify(result)).not.toMatch(/DO_NOT_READ|OTHER_COMPOSER/);
      row("bubbleId:neutral:a1", { bubbleId: "a1", type: 2, text: "Layout checked." });
      result = readCursorDesktopTranscript(db, "neutral");
      expect(result.events[1].blocks[0].text).toBe("Layout checked.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
