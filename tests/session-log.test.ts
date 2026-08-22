// The append-only session log substrate (Harness brief §1): append/shadow/
// reopen-seq/read-cursor semantics, runtime-neutral schema.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { SessionLog, readEvents, listRuns, capPayload, sessionLogPath, resetRunLog, runLog } from "../packages/claude-pty/src/session-log.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "slog-"));
  env = { GARRISON_HOME: tmp };
  resetRunLog();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("SessionLog", () => {
  it("appends ordered events and resumes seq across reopen", () => {
    const log = new SessionLog("default@2026-08-22", { env });
    expect(log.append({ domain: "lifecycle", kind: "run-start", payload: { a: 1 } })).toBe(0);
    expect(log.append({ domain: "session", kind: "injection", turn: "t1", payload: { text: "hi" } })).toBe(1);
    const reopened = new SessionLog("default@2026-08-22", { env });
    expect(reopened.append({ domain: "agent", kind: "sdk-message", payload: {} })).toBe(2);
    const lines = readFileSync(sessionLogPath("default@2026-08-22", env), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ v: 1, seq: 0, run: "default@2026-08-22", domain: "lifecycle", kind: "run-start", turn: null });
  });

  it("shadows supersede without deleting", () => {
    const log = new SessionLog("r1", { env });
    const orig = log.append({ domain: "session", kind: "sdk-message", payload: { text: "long" } });
    log.shadow(orig, { domain: "session", kind: "compaction", payload: { text: "short" } });
    const { events } = readEvents("r1", { env });
    expect(events).toHaveLength(2);
    expect(events[1].shadowOf).toBe(orig);
    expect(events[0].payload.text).toBe("long"); // still there, still searchable
  });

  it("caps oversized payloads with an explicit truncation marker", () => {
    const big = "x".repeat(300 * 1024);
    const capped = capPayload({ big });
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(256 * 1024);
    expect(typeof capped.head).toBe("string");
  });

  it("readEvents pages by opaque cursor and skips torn tails", () => {
    const log = new SessionLog("r2", { env });
    for (let i = 0; i < 5; i++) log.append({ domain: "agent", kind: "e", payload: i });
    const p1 = readEvents("r2", { limit: 2, env });
    expect(p1.events.map((e: { payload: number }) => e.payload)).toEqual([0, 1]);
    const p2 = readEvents("r2", { offset: p1.offset, limit: 10, env });
    expect(p2.events.map((e: { payload: number }) => e.payload)).toEqual([2, 3, 4]);
    expect(readEvents("r2", { offset: p2.offset, env }).events).toHaveLength(0);
  });

  it("runLog is env-driven and absent-tolerant; listRuns sees the file", () => {
    expect(runLog({ GARRISON_HOME: tmp })).toBeNull();
    const withRun = { GARRISON_HOME: tmp, GARRISON_SESSION_LOG_RUN: "envrun" };
    const log = runLog(withRun);
    expect(log).not.toBeNull();
    log.append({ domain: "lifecycle", kind: "run-start", payload: null });
    expect(listRuns(env).map((r: { runId: string }) => r.runId)).toContain("envrun");
  });
});
