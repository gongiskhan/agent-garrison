import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLogEntries, tailLogEntry } from "@/lib/claude-logs";

let home: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-logs-"));
  // logs surface
  fs.mkdirSync(path.join(home, "logs", "security"), { recursive: true });
  fs.mkdirSync(path.join(home, "debug"), { recursive: true });
  fs.writeFileSync(path.join(home, "daemon.log"), "boot\nready\nserving\n");
  fs.writeFileSync(path.join(home, "logs", "security", "audit.log"), "line1\nline2\nline3\nline4\n");
  fs.writeFileSync(path.join(home, "debug", "trace.txt"), "dbg-a\ndbg-b\n");
  // sessions surface
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, "projects", "-tmp-proj"), { recursive: true });
  fs.writeFileSync(path.join(home, "sessions", "9937.json"), JSON.stringify({ pid: 9937 }));
  fs.writeFileSync(
    path.join(home, "projects", "-tmp-proj", "abc.jsonl"),
    '{"t":1}\n{"t":2}\n{"t":3}\n'
  );
  // a file OUTSIDE the allowed surfaces, to prove category scoping
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: "x" }));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

describe("claude-logs read-only tailing", () => {
  it("lists the logs surface (logs/**, debug/**, top-level *.log)", async () => {
    const { entries } = await listLogEntries("logs", home);
    const rels = entries.map((e) => e.relPath);
    expect(rels).toContain("daemon.log");
    expect(rels).toContain("logs/security/audit.log");
    expect(rels).toContain("debug/trace.txt");
    // settings.json is NOT a log surface
    expect(rels).not.toContain("settings.json");
  });

  it("lists the sessions surface (sessions/*.json + projects/**/*.jsonl)", async () => {
    const { entries } = await listLogEntries("sessions", home);
    const rels = entries.map((e) => e.relPath);
    expect(rels).toContain("sessions/9937.json");
    expect(rels).toContain("projects/-tmp-proj/abc.jsonl");
    // a log file is NOT a session
    expect(rels).not.toContain("daemon.log");
  });

  it("tails a log file to the last N lines", async () => {
    const tail = await tailLogEntry("logs", "logs/security/audit.log", { maxLines: 2 }, home);
    expect(tail.lines).toEqual(["line3", "line4"]);
    expect(tail.truncated).toBe(true);
    expect(tail.totalBytes).toBeGreaterThan(0);
  });

  it("returns the whole short file when under the line cap (not truncated)", async () => {
    const tail = await tailLogEntry("logs", "daemon.log", { maxLines: 50 }, home);
    expect(tail.lines).toEqual(["boot", "ready", "serving"]);
    expect(tail.truncated).toBe(false);
  });

  it("byte-caps the tail and drops the partial head line", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `row-${i}`).join("\n") + "\n";
    fs.writeFileSync(path.join(home, "logs", "big.log"), big);
    const tail = await tailLogEntry("logs", "logs/big.log", { maxBytes: 40, maxLines: 5000 }, home);
    expect(tail.truncated).toBe(true);
    // last line preserved, head dropped
    expect(tail.lines[tail.lines.length - 1]).toBe("row-199");
    expect(tail.bytes).toBeLessThanOrEqual(40);
  });

  it("rejects path traversal out of the Claude home", async () => {
    await expect(tailLogEntry("logs", "../escape.log", {}, home)).rejects.toThrow();
    await expect(tailLogEntry("logs", "../../etc/passwd", {}, home)).rejects.toThrow();
    await expect(tailLogEntry("logs", "/etc/passwd", {}, home)).rejects.toThrow();
  });

  it("rejects a path outside the requested category surface", async () => {
    // settings.json is in home but not a log surface
    await expect(tailLogEntry("logs", "settings.json", {}, home)).rejects.toThrow(/logs surface/);
    // a session path requested through the logs category
    await expect(tailLogEntry("logs", "sessions/9937.json", {}, home)).rejects.toThrow(/logs surface/);
  });

  it("rejects a symlink that escapes the Claude home", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-outside-"));
    fs.writeFileSync(path.join(outside, "secret.log"), "top secret\n");
    fs.symlinkSync(path.join(outside, "secret.log"), path.join(home, "logs", "link.log"));
    await expect(tailLogEntry("logs", "logs/link.log", {}, home)).rejects.toThrow(/escapes/);
    await fsp.rm(outside, { recursive: true, force: true });
  });
});
