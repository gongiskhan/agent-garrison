import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore — pure .mjs module
import { conversationListMeta } from "../packages/talk/src/conversation-list-meta.mjs";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "conversation-list-meta-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const record = (kind: string, ts: string, payload: Record<string, unknown> = {}) => JSON.stringify({ kind, ts, payload }) + "\n";

describe("canonical conversation list metadata", () => {
  it("follows complete appended records without retaining message bodies or losing a lifecycle event behind long output", () => {
    const file = path.join(dir, "log.jsonl");
    writeFileSync(file, record("user-message", "2030-01-01T01:00:00Z", { text: "Private message" })
      + record("stretch-started", "2030-01-01T01:00:01Z")
      + record("note", "2030-01-01T01:00:02Z", { text: "large output ".repeat(6000) }));
    const first = conversationListMeta(dir);
    expect(first).toMatchObject({ messageCount: 1, updatedAt: "2030-01-01T01:00:02Z", decider: { kind: "stretch-started" } });
    expect(JSON.stringify(first)).not.toContain("Private message");
    const end = record("stretch-ended", "2030-01-01T01:00:03Z", { next: "done", replyRef: "payloads/reply.json", note: "✅" });
    const bytes = Buffer.from(end);
    appendFileSync(file, bytes.subarray(0, bytes.length - 3));
    expect(conversationListMeta(dir)).toEqual(first);
    appendFileSync(file, bytes.subarray(bytes.length - 3));
    expect(conversationListMeta(dir)).toMatchObject({ messageCount: 2, updatedAt: "2030-01-01T01:00:03Z", decider: { kind: "stretch-ended", next: "done" } });
    expect(conversationListMeta(dir).messageCount).toBe(2);
  });

  it("preserves counts through log rotation and rebuilds after truncation", () => {
    const file = path.join(dir, "log.jsonl");
    writeFileSync(file, record("user-message", "2030-01-01T01:00:00Z"));
    expect(conversationListMeta(dir).messageCount).toBe(1);
    renameSync(file, path.join(dir, "log.100.jsonl"));
    writeFileSync(file, record("user-message", "2030-01-01T01:01:00Z"));
    expect(conversationListMeta(dir).messageCount).toBe(2);
    writeFileSync(file, "");
    expect(conversationListMeta(dir).messageCount).toBe(1);
  });

  it("recovers a rotation between stat and open without caching the new log under the old inode", () => {
    const file = path.join(dir, "log.jsonl");
    writeFileSync(file, record("user-message", "2030-01-01T01:00:00Z"));
    const open = fs.openSync;
    let rotated = false;
    vi.spyOn(fs, "openSync").mockImplementation(((name: fs.PathLike, flags: string, ...rest: unknown[]) => {
      if (name === file && flags === "r" && !rotated) {
        rotated = true;
        renameSync(file, path.join(dir, "log.100.jsonl"));
        writeFileSync(file, record("stretch-ended", "2030-01-01T01:01:00Z", { next: "done", replyRef: "payloads/reply.json" }));
      }
      return (open as (...args: unknown[]) => number)(name, flags, ...rest);
    }) as typeof fs.openSync);
    conversationListMeta(dir);
    expect(conversationListMeta(dir)).toMatchObject({ messageCount: 2, decider: { kind: "stretch-ended", next: "done" } });
  });
});
