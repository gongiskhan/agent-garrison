import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readLiveRegistry,
  listHistory,
  isInternalCwd
} from "../fittings/seed/dev-env/scripts/claude-sessions.mjs";

// DS1-reader gate. claude-sessions.mjs reads Claude Code's own on-disk session
// data: the live registry (~/.claude/sessions/*.json) and the transcript store
// (~/.claude/projects/*/*.jsonl). Sandboxed via GARRISON_CLAUDE_HOME — the
// readers resolve paths at call time so one env var redirects both.

let sandbox: string;
let sessionsDir: string;
let projectsDir: string;
const prevHome = process.env.GARRISON_CLAUDE_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "ds1-claude-"));
  sessionsDir = path.join(sandbox, "sessions");
  projectsDir = path.join(sandbox, "projects");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  process.env.GARRISON_CLAUDE_HOME = sandbox;
  delete process.env.GARRISON_CLAUDE_SESSIONS_DIR;
  delete process.env.GARRISON_CLAUDE_PROJECTS_DIR;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = prevHome;
});

function writeSession(name: string, obj: unknown): void {
  writeFileSync(path.join(sessionsDir, name), JSON.stringify(obj));
}

function writeTranscript(dir: string, sid: string, lines: unknown[], mtime?: Date): string {
  const d = path.join(projectsDir, dir);
  mkdirSync(d, { recursive: true });
  const p = path.join(d, `${sid}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

describe("readLiveRegistry — live-registry-ok", () => {
  it("returns only alive, non-internal sessions; drops stale/internal/broad-root; passes status through", () => {
    const alive = process.pid;
    const dead = 2_147_483_640; // above any real pid → ESRCH → not alive
    // No startedAt here → neither boot nor reuse verification applies, so the
    // test exercises pure cwd/pid/alive filtering without shelling out to ps
    // (those guards have their own focused tests below).
    writeSession("a.json", { pid: alive, sessionId: "real", cwd: "/Users/ggomes/dev/projA", status: "idle", updatedAt: 222, kind: "interactive" });
    writeSession("b.json", { pid: alive, sessionId: "shell", cwd: "/Users/ggomes/dev/projB", status: "shell" });
    writeSession("c.json", { pid: dead, sessionId: "stale", cwd: "/Users/ggomes/dev/projC" });
    writeSession("d.json", { pid: alive, sessionId: "internal-garrison", cwd: path.join(os.homedir(), ".garrison/model-router/classifier-cwd") });
    writeSession("e.json", { pid: alive, sessionId: "internal-comp", cwd: "/Users/ggomes/dev/garrison/compositions/default" });
    writeSession("f.json", { pid: alive, sessionId: "broadroot", cwd: os.homedir() });
    writeSession("g.json", { pid: alive }); // missing sessionId/cwd → skipped
    writeSession("h.txt", { pid: alive, sessionId: "ignored-nonjson-name", cwd: "/x" }); // not *.json

    const rows = readLiveRegistry();
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["real", "shell"]);
    const real = rows.find((r) => r.sessionId === "real")!;
    expect(real.status).toBe("idle");
    expect(real.updatedAt).toBe(222);
    expect(real.pid).toBe(alive);
    expect(rows.find((r) => r.sessionId === "shell")!.status).toBe("shell");
  });

  it("drops a process that started before this boot (crash/reboot leftover) and one with no startedAt is kept", () => {
    const alive = process.pid;
    const bootMs = Date.now() - os.uptime() * 1000;
    writeSession("preboot.json", { pid: alive, sessionId: "preboot", cwd: "/Users/ggomes/dev/projZ", startedAt: bootMs - 100_000 });
    writeSession("nostart.json", { pid: alive, sessionId: "nostart", cwd: "/Users/ggomes/dev/projY" }); // no startedAt → keep
    const ids = readLiveRegistry().map((r) => r.sessionId);
    expect(ids).not.toContain("preboot");
    expect(ids).toContain("nostart");
  });

  it("drops a numeric-named file whose filename pid disagrees with the JSON pid", () => {
    const alive = process.pid;
    writeSession("77777.json", { pid: alive, sessionId: "mismatch", cwd: "/Users/ggomes/dev/projM", startedAt: Date.now() });
    expect(readLiveRegistry().find((r) => r.sessionId === "mismatch")).toBeUndefined();
  });

  it("same-boot pid reuse: a startedAt that disagrees with the actual process start (epoch) is dropped", () => {
    const alive = process.pid;
    const E = Date.now(); // the "actual" start instant we inject for this pid
    writeSession("ver.json", { pid: alive, sessionId: "verified", cwd: "/Users/ggomes/dev/projV", startedAt: E });
    writeSession("reu.json", { pid: alive, sessionId: "reused", cwd: "/Users/ggomes/dev/projR", startedAt: E + 1_000_000 });
    writeSession("nop.json", { pid: alive, sessionId: "noStart", cwd: "/Users/ggomes/dev/projN" }); // no startedAt → not verified
    // Inject the actual start epoch (avoids shelling out to ps; timezone-robust).
    const startTimeOf = () => new Map<number, number>([[alive, E]]);
    const ids = readLiveRegistry({ startTimeOf })
      .map((r) => r.sessionId)
      .sort();
    expect(ids).toEqual(["noStart", "verified"]); // reused dropped; no-startedAt kept
  });

  it("returns [] when the sessions dir is absent", () => {
    rmSync(sessionsDir, { recursive: true, force: true });
    expect(readLiveRegistry()).toEqual([]);
  });

  it("isInternalCwd flags machinery + workspace roots (incl. exact ~/.garrison) but not a real project or ~/.claude", () => {
    expect(isInternalCwd(os.homedir())).toBe(true);
    expect(isInternalCwd(path.join(os.homedir(), "dev"))).toBe(true);
    expect(isInternalCwd("/anything/compositions/default")).toBe(true);
    expect(isInternalCwd(path.join(os.homedir(), ".garrison"))).toBe(true); // exact root
    expect(isInternalCwd(path.join(os.homedir(), ".garrison/model-router/classifier-cwd"))).toBe(true);
    expect(isInternalCwd(path.join(os.homedir(), ".claude"))).toBe(false);
    expect(isInternalCwd("/Users/ggomes/dev/ekoa-dev")).toBe(false);
    expect(isInternalCwd("")).toBe(true);
  });
});

describe("listHistory — history-title-ok", () => {
  it("title = latest ai-title > first user message > null; reads cwd/branch/start", () => {
    const recent = new Date(Date.now() - 86_400_000);
    writeTranscript(
      "p-a",
      "sidA",
      [
        {
          type: "user",
          timestamp: "2026-06-20T01:00:00.000Z",
          cwd: "/Users/ggomes/dev/projA",
          gitBranch: "main",
          message: { role: "user", content: "First prompt about widgets" }
        },
        { type: "ai-title", aiTitle: "Old title", sessionId: "sidA" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
        { type: "ai-title", aiTitle: "Latest title wins", sessionId: "sidA" }
      ],
      recent
    );
    writeTranscript(
      "p-b",
      "sidB",
      [
        {
          type: "user",
          timestamp: "2026-06-20T02:00:00.000Z",
          cwd: "/Users/ggomes/dev/projB",
          message: { role: "user", content: [{ type: "text", text: "Fix the flaky test in CI" }] }
        },
        { type: "assistant", message: { role: "assistant", content: "done" } }
      ],
      recent
    );
    writeTranscript(
      "p-c",
      "sidC",
      [
        { type: "last-prompt", leafUuid: "x", sessionId: "sidC" },
        { type: "system", cwd: "/Users/ggomes/dev/projC", content: "boot" }
      ],
      recent
    );

    const byId = Object.fromEntries(listHistory({ windowDays: 30 }).map((h) => [h.sessionId, h]));
    expect(byId.sidA.title).toBe("Latest title wins");
    expect(byId.sidA.cwd).toBe("/Users/ggomes/dev/projA");
    expect(byId.sidA.gitBranch).toBe("main");
    expect(byId.sidA.startedAt).toBe("2026-06-20T01:00:00.000Z");
    expect(byId.sidB.title).toBe("Fix the flaky test in CI");
    expect(byId.sidC.title).toBeNull();
  });

  it("on a file larger than the head window, the LATEST (tail) ai-title wins over an old head ai-title", () => {
    const recent = new Date(Date.now() - 86_400_000);
    const lines: unknown[] = [
      { type: "user", cwd: "/Users/ggomes/dev/projBig", message: { role: "user", content: "start" } },
      { type: "ai-title", aiTitle: "EarlyTitle", sessionId: "sidBig" }
    ];
    // ~24 KB of filler so the file exceeds the 8 KB head window; the latest
    // ai-title then lives only in the tail.
    for (let i = 0; i < 220; i++) {
      lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `filler line ${i} ${"x".repeat(80)}` }] } });
    }
    lines.push({ type: "ai-title", aiTitle: "FinalTitle", sessionId: "sidBig" });
    writeTranscript("p-big", "sidBig", lines, recent);

    const big = listHistory({ windowDays: 30 }).find((h) => h.sessionId === "sidBig")!;
    expect(big.title).toBe("FinalTitle");
  });

  it("expands the tail to recover an ai-title that sits outside the initial 64KB tail window", () => {
    const recent = new Date(Date.now() - 86_400_000);
    const lines: unknown[] = [
      { type: "user", cwd: "/Users/ggomes/dev/projDeep", message: { role: "user", content: "deep start" } },
      { type: "ai-title", aiTitle: "DeepTitle", sessionId: "sidDeep" }
    ];
    // ~100 KB of trailing filler so the only ai-title is >64KB from the end —
    // recoverable only by the lazy tail expansion, not the initial tail read.
    for (let i = 0; i < 900; i++) {
      lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `filler ${i} ${"y".repeat(90)}` }] } });
    }
    writeTranscript("p-deep", "sidDeep", lines, recent);

    const deep = listHistory({ windowDays: 30 }).find((h) => h.sessionId === "sidDeep")!;
    expect(deep.title).toBe("DeepTitle");
  });

  it("excludes transcripts older than the window and orders newest-first", () => {
    const old = new Date(Date.now() - 60 * 86_400_000);
    const d3 = new Date(Date.now() - 3 * 86_400_000);
    const d1 = new Date(Date.now() - 1 * 86_400_000);
    writeTranscript("p-old", "sidOld", [{ type: "user", cwd: "/x", message: { role: "user", content: "old" } }], old);
    writeTranscript("p1", "older", [{ type: "user", cwd: "/x", message: { role: "user", content: "a" } }], d3);
    writeTranscript("p2", "newer", [{ type: "user", cwd: "/y", message: { role: "user", content: "b" } }], d1);

    const ids = listHistory({ windowDays: 30 }).map((h) => h.sessionId);
    expect(ids).not.toContain("sidOld");
    expect(ids.indexOf("newer")).toBeLessThan(ids.indexOf("older"));
  });
});

describe("listHistory — history-cache-ok", () => {
  it("mtime-keyed cache: stale content with unchanged mtime returns the cached title; a new mtime refreshes", () => {
    const stable = new Date(Date.now() - 2 * 86_400_000);
    const p = writeTranscript(
      "p-cache",
      "sidX",
      [
        { type: "user", cwd: "/Users/ggomes/dev/projX", message: { role: "user", content: "x" } },
        { type: "ai-title", aiTitle: "A", sessionId: "sidX" }
      ],
      stable
    );
    expect(listHistory({ windowDays: 30 }).find((h) => h.sessionId === "sidX")!.title).toBe("A");

    // change content but RESTORE the same mtime → cache must still serve "A"
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", cwd: "/Users/ggomes/dev/projX", message: { role: "user", content: "x" } }),
        JSON.stringify({ type: "ai-title", aiTitle: "B", sessionId: "sidX" })
      ].join("\n") + "\n"
    );
    utimesSync(p, stable, stable);
    expect(listHistory({ windowDays: 30 }).find((h) => h.sessionId === "sidX")!.title).toBe("A");

    // bump mtime → cache refreshes to "B"
    const bumped = new Date(Date.now() - 1 * 86_400_000);
    utimesSync(p, bumped, bumped);
    expect(listHistory({ windowDays: 30 }).find((h) => h.sessionId === "sidX")!.title).toBe("B");
  });
});
