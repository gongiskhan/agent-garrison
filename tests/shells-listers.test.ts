// The four session listers (claude/codex/cursor/gemini) and buildIndex - the
// normalised Row shape they all feed. Every fixture is built in a fresh
// mkdtemp sandbox per test, following the DS1-reader convention in
// tests/dev-env-claude-sessions.test.ts.

import { appendFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore — pure .mjs
import { list as listClaude } from "../fittings/seed/remote-shell-runtime/lib/listers/claude.mjs";
// @ts-ignore — pure .mjs
import { list as listCodex } from "../fittings/seed/remote-shell-runtime/lib/listers/codex.mjs";
// @ts-ignore — pure .mjs
import { list as listCursor } from "../fittings/seed/remote-shell-runtime/lib/listers/cursor.mjs";
// @ts-ignore — pure .mjs
import { list as listGemini } from "../fittings/seed/remote-shell-runtime/lib/listers/gemini.mjs";
// @ts-ignore — pure .mjs
import { buildIndex, applyHookStatus } from "../fittings/seed/remote-shell-runtime/lib/session-index.mjs";
// @ts-ignore — pure .mjs
import { claudeTranscriptStatus } from "../fittings/seed/remote-shell-runtime/lib/listers/common.mjs";

const NOW = 1_800_000_000_000; // fixed instant, well past any real boot time

let sandbox: string;
const prevHome = process.env.GARRISON_CLAUDE_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "shells-listers-"));
  // buildIndex always calls the claude lister too, and claude-pty's readers
  // are not env-injectable (they read process.env.GARRISON_CLAUDE_HOME at
  // call time) - point every test at an EMPTY claude home by default, so a
  // test that does not care about claude sessions never silently reads this
  // real machine's actual ~/.claude data. Tests that DO want claude fixtures
  // override this to their own populated dir.
  process.env.GARRISON_CLAUDE_HOME = path.join(sandbox, "empty-claude-home");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(sandbox, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = prevHome;
});

describe("claude lister", () => {
  it("keeps more than three hundred Claude journals active within five days", () => {
    const home = path.join(sandbox, "claude-many-recent");
    process.env.GARRISON_CLAUDE_HOME = home;
    const dir = path.join(home, "projects", "-tmp-many-claude");
    mkdirSync(dir, { recursive: true });
    const recent = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    for (let i = 0; i < 305; i++) {
      const file = path.join(dir, `recent-${i}.jsonl`);
      writeFileSync(file, JSON.stringify({ type: "assistant", cwd: "/tmp/many-claude", timestamp: recent.toISOString(), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Complete" }] } }) + "\n");
      utimesSync(file, recent, recent);
    }
    expect(listClaude({ windowDays: 5, backgroundAgents: [] })).toHaveLength(305);
  });

  it("recognizes native print completion with a null stop reason after a short text grace period", () => {
    const file = path.join(sandbox, "native-null-stop.jsonl");
    writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(NOW - 45_000).toISOString(), message: { stop_reason: null, content: [{ type: "tool_use", name: "TaskOutput" }] } }) + "\n");
    expect(claudeTranscriptStatus(file, NOW - 45_000, NOW).status).toBe("working");
    appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(NOW).toISOString(), message: { stop_reason: null, content: [{ type: "text", text: "Complete" }] } }) + "\n");
    expect(claudeTranscriptStatus(file, NOW, NOW + 1_000).status).toBe("working");
    const settled = claudeTranscriptStatus(file, NOW, NOW + 6_000);
    expect(settled).toMatchObject({ status: "idle", statusInferred: true });
    const row = { ...settled, id: "native-text", runtime: "claude", lastActivityAt: new Date(NOW).toISOString() };
    const events = [{ event: "agent-start", runtime: "claude", session_id: row.id, ts: new Date(NOW - 10_000).toISOString() }];
    expect(applyHookStatus(row, events, NOW + 6_000).status).toBe("working");
    appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(NOW).toISOString(), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Complete" }] } }) + "\n");
    expect(applyHookStatus({ ...row, ...claudeTranscriptStatus(file, NOW, NOW + 6_000) }, events, NOW + 6_000).status).toBe("idle");
  });

  it("keeps native print clients without a registry working through quiet tools, then clears explicit completion", () => {
    const home = path.join(sandbox, "claude-print");
    process.env.GARRISON_CLAUDE_HOME = home;
    const dir = path.join(home, "projects", "-tmp-print-claude");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "print-claude.jsonl");
    const quietAt = new Date(Date.now() - 45_000);
    writeFileSync(file, JSON.stringify({ type: "assistant", cwd: "/tmp/print-claude", timestamp: quietAt.toISOString(), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "TaskOutput" }] } }) + "\n");
    utimesSync(file, quietAt, quietAt);
    let row = listClaude({ backgroundAgents: [] }).find((r: { id: string }) => r.id === "print-claude");
    expect(row).toMatchObject({ status: "working", statusSource: "transcript-events" });
    appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Complete" }] } }) + "\n");
    row = listClaude({ backgroundAgents: [] }).find((r: { id: string }) => r.id === "print-claude");
    expect(row).toMatchObject({ status: "ended", statusSource: "transcript-events" });
  });

  it("uses journal lifecycle when a live Claude registry omits busy state, retaining quiet tools and clearing completion", () => {
    const home = path.join(sandbox, "claude-quiet");
    process.env.GARRISON_CLAUDE_HOME = home;
    mkdirSync(path.join(home, "sessions"), { recursive: true });
    const dir = path.join(home, "projects", "-tmp-quiet-claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "quiet-claude", cwd: "/tmp/quiet-claude", updatedAt: Date.now() }));
    const file = path.join(dir, "quiet-claude.jsonl");
    const quietAt = new Date(Date.now() - 45_000);
    writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: quietAt.toISOString(), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } }) + "\n");
    utimesSync(file, quietAt, quietAt);
    let row = listClaude({ backgroundAgents: [] }).find((r: { id: string }) => r.id === "quiet-claude");
    expect(row).toMatchObject({ status: "working", statusSource: "transcript-events" });
    expect(Date.parse(row.lastActivityAt)).toBeGreaterThan(quietAt.getTime());
    appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Complete" }] } }) + "\n");
    row = listClaude({ backgroundAgents: [] }).find((r: { id: string }) => r.id === "quiet-claude");
    expect(row).toMatchObject({ status: "idle", statusSource: "transcript-events" });
  });

  it.each([["idle", "agent-start", "idle"], ["busy", "agent-stop", "working"]])("keeps newer %s registry status ahead of older hooks", (registryStatus, hookEvent, expected) => {
    const home = path.join(sandbox, "claude-registry");
    process.env.GARRISON_CLAUDE_HOME = home;
    mkdirSync(path.join(home, "sessions"), { recursive: true });
    writeFileSync(path.join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "registry-order", cwd: "/tmp/registry-order", status: registryStatus, updatedAt: NOW }));
    const row = listClaude({ backgroundAgents: [] }).find((r: { id: string }) => r.id === "registry-order");
    expect(row.statusAt).toBe(new Date(NOW).toISOString());
    const events = [{ event: hookEvent, runtime: "claude", session_id: row.id, ts: new Date(NOW - 1000).toISOString() }];
    expect(applyHookStatus(row, events, NOW).status).toBe(expected);
  });

  it("live registry row, ended-history row, background-agent row; internal cwds dropped", () => {
    const claudeHome = path.join(sandbox, "claude-home");
    process.env.GARRISON_CLAUDE_HOME = claudeHome;
    const sessionsDir = path.join(claudeHome, "sessions");
    const projectsDir = path.join(claudeHome, "projects");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(path.join(projectsDir, "-tmp-alpha"), { recursive: true });
    mkdirSync(path.join(projectsDir, "-tmp-beta"), { recursive: true });

    // Live: a real pid (this process), a project the lister must keep.
    writeFileSync(
      path.join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "live-1", cwd: "/tmp/alpha", status: "busy", updatedAt: NOW })
    );
    // A dead pid: contributes a HISTORY row instead (ended).
    const deadTranscript = path.join(projectsDir, "-tmp-beta", "history-1.jsonl");
    writeFileSync(deadTranscript, `${JSON.stringify({ cwd: "/tmp/beta", type: "ai-title", aiTitle: "Old work" })}\n`);
    utimesSync(deadTranscript, new Date(), new Date());

    const rows = listClaude({ windowDays: 5 });
    const live = rows.find((r: { id: string }) => r.id === "live-1");
    expect(live).toBeTruthy();
    expect(live.status).toBe("working");
    expect(live.statusSource).toBe("registry");
    expect(live.kind).toBe("cli");
    expect(live.transcript.path).toContain(path.join("projects", "-tmp-alpha", "live-1.jsonl"));

    const ended = rows.find((r: { id: string }) => r.id === "history-1");
    expect(ended).toBeTruthy();
    expect(ended.status).toBe("ended");
    expect(ended.title).toBe("Old work");
  });
});

function writeCodexRollout(root: string, uuid: string, payload: Record<string, unknown>, mtime: Date) {
  const dir = path.join(root, "2026", "09", "03");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-03T10-00-00-${uuid}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: uuid, ...payload } })}\n`);
  utimesSync(file, mtime, mtime);
  return file;
}

describe("codex lister", () => {
  it("uses the native state database's saved names and titles by id, with journal metadata fallback", () => {
    const home = path.join(sandbox, "codex-state");
    for (const id of ["renamed", "titled", "metadata"]) {
      writeCodexRollout(path.join(home, "sessions"), id, { cwd: "/tmp/shared", title: `Journal ${id}` }, new Date(NOW));
    }
    execFileSync("sqlite3", [path.join(home, "state_5.sqlite"), `
      create table threads (id text, title text, name text, updated_at integer, first_user_message text);
      insert into threads values ('renamed', 'Original title', 'Saved task name', 2, 'Private prompt');
      insert into threads values ('titled', 'Distinct task title', null, 1, 'Private prompt');
    `]);
    const rows = listCodex({ now: NOW, env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: home } });
    expect(Object.fromEntries(rows.map((row: { id: string; title: string }) => [row.id, row.title])))
      .toEqual({ renamed: "Saved task name", titled: "Distinct task title", metadata: "Journal metadata" });
    expect(JSON.stringify(rows)).not.toContain("Private prompt");
  });

  it("reads an older native state schema without the optional name column", () => {
    const home = path.join(sandbox, "codex-state-old");
    writeCodexRollout(path.join(home, "sessions"), "older", { cwd: "/tmp/shared" }, new Date(NOW));
    execFileSync("sqlite3", [path.join(home, "state_4.sqlite"), "create table threads (id text, title text); insert into threads values ('older', 'Older task title');"]);
    expect(listCodex({ now: NOW, env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: home } })[0].title).toBe("Older task title");
  });

  it("reads session_index titles, skips subagent threads, dedupes across homes", () => {
    const home = path.join(sandbox, "codex-home");
    const sessionsRoot = path.join(home, "sessions");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, "session_index.jsonl"),
      `${JSON.stringify({ id: "019f-parent", thread_name: "Parent thread", updated_at: "2026-09-03T10:00:00Z" })}\n`
    );
    writeCodexRollout(sessionsRoot, "019f-parent", { cwd: "/tmp/proj", timestamp: "2026-09-03T09:00:00Z" }, new Date(NOW - 5_000));
    // A subagent thread: same session_id points at the parent, own id differs.
    writeCodexRollout(
      sessionsRoot,
      "019f-child",
      { cwd: "/tmp/proj", timestamp: "2026-09-03T09:05:00Z", thread_source: "subagent", session_id: "019f-parent" },
      new Date(NOW - 4_000)
    );

    const rows = listCodex({ windowDays: 5, now: NOW, env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: home } as unknown as NodeJS.ProcessEnv });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("019f-parent");
    expect(rows[0].title).toBe("Parent thread");
    expect(rows[0].status).toBe("working"); // 5s old, within the transcript window
    expect(rows[0].statusSource).toBe("transcript");
  });

  it("a transcript older than the working window reads as unknown, not idle", () => {
    const home = path.join(sandbox, "codex-home2");
    mkdirSync(home, { recursive: true });
    writeCodexRollout(path.join(home, "sessions"), "019f-old", { cwd: "/tmp/proj" }, new Date(NOW - 5 * 60_000));
    const rows = listCodex({ windowDays: 5, now: NOW, env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: home } as unknown as NodeJS.ProcessEnv });
    expect(rows[0].status).toBe("unknown");
  });
});

describe("cursor lister", () => {
  function desktopFixture() {
    const db = path.join(sandbox, "state.vscdb");
    const meta = JSON.stringify({ name: "Desktop title", status: "completed", createdAt: NOW - 1000, lastUpdatedAt: NOW, conversation: "private-body-sentinel" });
    execFileSync("sqlite3", [db, `create table cursorDiskKV (key text primary key, value text); insert into cursorDiskKV values ('composerData:desktop-only', '${meta}');`]);
    const env = { HOME: sandbox, GARRISON_CURSOR_HOME: path.join(sandbox, "cursor"), GARRISON_CURSOR_STATE_DB: db };
    return { db, env, list: (now = NOW) => listCursor({ windowDays: 5, now, env }) };
  }

  async function holdDatabase(db: string) {
    const child = spawn("sqlite3", [db], { stdio: ["pipe", "pipe", "pipe"] });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SQLite fixture did not acquire its lock")), 5000);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("SQLite fixture exited before locking")); });
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("LOCKED")) { clearTimeout(timer); resolve(); }
      });
    });
    child.stdin.write("BEGIN EXCLUSIVE;\nSELECT 'LOCKED';\n");
    try { await ready; } catch (err) { child.kill(); throw err; }
    return async () => {
      const ended = once(child, "exit");
      child.stdin.end("ROLLBACK;\n");
      await ended;
    };
  }

  it("retains metadata-only desktop sessions during a failed read and refreshes after recovery", async () => {
    const fixture = desktopFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initial = fixture.list();
    expect(initial).toHaveLength(1);
    const release = await holdDatabase(fixture.db);
    try {
      clock.mockReturnValue(NOW + 6000);
      expect(fixture.list(NOW + 6000)).toEqual(initial);
      clock.mockReturnValue(NOW + 12000);
      expect(fixture.list(NOW + 12000)).toEqual(initial);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(String(warnings.mock.calls[0][0])).toContain("database-locked");
      expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/Desktop title|private-body-sentinel|state\.vscdb/);
    } finally {
      await release();
    }
    execFileSync("sqlite3", [fixture.db, "update cursorDiskKV set value = json_set(value, '$.name', 'Renamed desktop');"]);
    clock.mockReturnValue(NOW + 18000);
    expect(fixture.list(NOW + 18000)[0]).toMatchObject({ title: "Renamed desktop", lastActivityAt: new Date(NOW).toISOString() });
  });

  it("expires cached desktop sessions by original activity during an ongoing read failure", async () => {
    const fixture = desktopFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(fixture.list()).toHaveLength(1);
    const release = await holdDatabase(fixture.db);
    try {
      const later = NOW + 6 * 86400000;
      clock.mockReturnValue(later);
      expect(fixture.list(later)).toEqual([]);
    } finally {
      await release();
    }
  });

  it("clears cached desktop sessions after a successful empty read or confirmed database removal", () => {
    const fixture = desktopFixture();
    const original = readFileSync(fixture.db);
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(fixture.list()).toHaveLength(1);
    execFileSync("sqlite3", [fixture.db, "delete from cursorDiskKV;"]);
    clock.mockReturnValue(NOW + 6000);
    expect(fixture.list(NOW + 6000)).toEqual([]);
    writeFileSync(fixture.db, original);
    clock.mockReturnValue(NOW + 12000);
    expect(fixture.list(NOW + 12000)).toHaveLength(1);
    rmSync(fixture.db);
    clock.mockReturnValue(NOW + 18000);
    expect(fixture.list(NOW + 18000)).toEqual([]);
  });

  it("a chats-indexed id is a CLI row with the meta cwd; an un-indexed id is a desktop row", () => {
    const home = path.join(sandbox, "cursor-home");
    const slug = "-tmp-proj";
    const transcriptsRoot = path.join(home, "projects", slug, "agent-transcripts");
    mkdirSync(transcriptsRoot, { recursive: true });

    const cliFile = path.join(transcriptsRoot, "cli-1", "cli-1.jsonl");
    mkdirSync(path.dirname(cliFile), { recursive: true });
    writeFileSync(cliFile, `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>\nfix the header\n</user_query>" }] } })}\n`);
    utimesSync(cliFile, new Date(NOW), new Date(NOW));
    mkdirSync(path.join(home, "chats", "ws1", "cli-1"), { recursive: true });
    writeFileSync(
      path.join(home, "chats", "ws1", "cli-1", "meta.json"),
      JSON.stringify({ cwd: "/tmp/proj", createdAtMs: NOW - 1000, updatedAtMs: NOW })
    );

    const desktopFile = path.join(transcriptsRoot, "desktop-1", "desktop-1.jsonl");
    mkdirSync(path.dirname(desktopFile), { recursive: true });
    writeFileSync(desktopFile, `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello desktop" }] } })}\n`);
    utimesSync(desktopFile, new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000));

    const rows = listCursor({ windowDays: 5, now: NOW, env: { HOME: sandbox, GARRISON_CURSOR_HOME: home } as unknown as NodeJS.ProcessEnv });
    const cli = rows.find((r: { id: string }) => r.id === "cli-1");
    expect(cli.kind).toBe("cli");
    expect(cli.cwd).toBe("/tmp/proj");
    expect(cli.status).toBe("working");
    expect(cli.title).toBe("fix the header");

    const desktop = rows.find((r: { id: string }) => r.id === "desktop-1");
    expect(desktop.kind).toBe("desktop");
    expect(desktop.status).toBe("unknown");
    expect(desktop.title).toBe("hello desktop");
  });
});

describe("gemini lister", () => {
  it("orders sessions by startTime and marks only the newest as latest", () => {
    const home = path.join(sandbox, "gemini-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: { "/tmp/g": "g-proj" } }));
    const chatsDir = path.join(home, "tmp", "g-proj", "chats");
    mkdirSync(chatsDir, { recursive: true });
    const older = path.join(chatsDir, "session-1-a.jsonl");
    writeFileSync(older, `${JSON.stringify({ sessionId: "a", startTime: "2026-09-01T00:00:00Z", lastUpdated: "2026-09-01T00:05:00Z" })}\n`);
    utimesSync(older, new Date(NOW - 60_000), new Date(NOW - 60_000));
    const newer = path.join(chatsDir, "session-2-b.jsonl");
    writeFileSync(
      newer,
      [
        JSON.stringify({ sessionId: "b", startTime: "2026-09-02T00:00:00Z", lastUpdated: "2026-09-02T00:05:00Z" }),
        JSON.stringify({ $set: { messages: [{ id: 1, type: "user", content: [{ text: "help me debug" }] }] } })
      ].join("\n") + "\n"
    );
    utimesSync(newer, new Date(NOW), new Date(NOW));

    const rows = listGemini({ windowDays: 5, now: NOW, env: { GEMINI_CLI_HOME: home } as unknown as NodeJS.ProcessEnv });
    const a = rows.find((r: { id: string }) => r.id === "a");
    const b = rows.find((r: { id: string }) => r.id === "b");
    expect(a.resumeRef).toBe("1");
    expect(b.resumeRef).toBe("latest");
    expect(b.title).toBe("help me debug");
  });
});

describe("buildIndex", () => {
  it("tags a listed session claimed by a thread, and hides an owned-shell duplicate", () => {
    const garrisonHomeDir = path.join(sandbox, "garrison");
    const codexHomeDir = path.join(sandbox, "codex-idx");
    mkdirSync(path.join(garrisonHomeDir, "web-channel", "threads"), { recursive: true });
    mkdirSync(codexHomeDir, { recursive: true });

    // A codex session already owned by a Conversation thread.
    writeCodexRollout(path.join(codexHomeDir, "sessions"), "019f-claimed", { cwd: "/tmp/claimed" }, new Date(NOW - 1000));
    writeFileSync(
      path.join(garrisonHomeDir, "web-channel", "threads", "t1.json"),
      JSON.stringify({ id: "t1", sessionIds: ["019f-claimed"] })
    );

    // A second codex session, "owned" by a Garrison shell running codex in
    // the same cwd - the owned-shell row must suppress this duplicate.
    writeCodexRollout(path.join(codexHomeDir, "sessions"), "019f-dup", { cwd: "/tmp/dup" }, new Date(NOW - 1000));
    const fakeManager = {
      sessions: new Map([
        ["s1", {
          id: "s1", transport: { name: "local" }, tmuxSession: "dup",
          cwd: "/tmp/dup", label: "dup shell", createdAt: "2026-09-03T09:00:00Z",
          lastEventAt: "2026-09-03T09:00:01Z", state: "running", runtime: "codex",
          resumeRef: "019f-dup", resumeCommand: null, paneCommand: "codex", lastOutputAt: NOW
        }]
      ])
    };

    const rows = buildIndex({
      manager: fakeManager as never,
      now: NOW,
      garrisonHomeDir,
      env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: codexHomeDir } as unknown as NodeJS.ProcessEnv,
      claudeBackgroundAgents: []
    });

    const claimed = rows.find((r: { id: string }) => r.id === "019f-claimed");
    expect(claimed.claimedBy).toEqual({ kind: "thread", id: "t1" });
    expect(claimed.resumeCommand).toContain("'codex'");

    expect(rows.find((r: { id: string }) => r.id === "019f-dup")).toBeUndefined();
    const shellRow = rows.find((r: { id: string }) => r.id === "shell:local:dup");
    expect(shellRow).toBeTruthy();
    expect(shellRow.status).toBe("working");
    expect(shellRow.statusSource).toBe("hooks");
  });

  it("a peer wrapper with the same tmux name cannot claim this node's shell", () => {
    const home = path.join(sandbox, "local-claims");
    mkdirSync(path.join(home, "web-channel", "threads"), { recursive: true });
    writeFileSync(path.join(home, "web-channel", "threads", "peer.json"), JSON.stringify({
      id: "peer-wrapper", context: { shell: { node: "peer", transport: "local", tmuxSession: "shared-name" } }
    }));
    const manager = { sessions: new Map([["s", { id: "s", transport: { name: "local" }, tmuxSession: "shared-name", cwd: "/tmp/project" }]]) };
    const rows = buildIndex({ manager, now: NOW, garrisonHomeDir: home, claudeBackgroundAgents: [], env: { HOME: sandbox, GARRISON_HOME: home, GARRISON_NODE_NAME: "self", GARRISON_CURSOR_HOME: sandbox, GEMINI_CLI_HOME: sandbox } });
    expect(rows.find((r: { id: string }) => r.id === "shell:local:shared-name").threadId).toBeNull();
  });

  it("sorts working before idle before unknown, most recent first within a tier", () => {
    const garrisonHomeDir = path.join(sandbox, "garrison2");
    const codexHomeDir = path.join(sandbox, "codex-idx2");
    mkdirSync(path.join(garrisonHomeDir, "web-channel", "threads"), { recursive: true });
    mkdirSync(codexHomeDir, { recursive: true });
    writeCodexRollout(path.join(codexHomeDir, "sessions"), "019f-fresh", { cwd: "/tmp/fresh" }, new Date(NOW - 1000));
    writeCodexRollout(path.join(codexHomeDir, "sessions"), "019f-stale", { cwd: "/tmp/stale" }, new Date(NOW - 10 * 60_000));

    const rows = buildIndex({
      manager: null,
      now: NOW,
      garrisonHomeDir,
      env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: codexHomeDir } as unknown as NodeJS.ProcessEnv,
      claudeBackgroundAgents: []
    });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["019f-fresh", "019f-stale"]);
    expect(rows[0].status).toBe("working");
    expect(rows[1].status).toBe("unknown");
  });
});

describe("recent native session discovery regressions", () => {
  it("includes the real Codex home alongside the runner home and an old creation directory resumed today", () => {
    const nativeHome = path.join(sandbox, ".codex");
    const runtimeHome = path.join(sandbox, "runtime-codex");
    const native = writeCodexRollout(path.join(nativeHome, "sessions"), "native-resumed", { cwd: "/tmp/native" }, new Date(NOW));
    const oldDir = path.join(nativeHome, "sessions", "2025", "01", "01");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(path.join(oldDir, path.basename(native)), readFileSync(native));
    rmSync(native);
    utimesSync(path.join(oldDir, path.basename(native)), new Date(NOW), new Date(NOW));
    for (let i = 10; i < 20; i++) mkdirSync(path.join(nativeHome, "sessions", "2026", "09", String(i)), { recursive: true });
    writeCodexRollout(path.join(runtimeHome, "sessions"), "runtime-1", { cwd: "/tmp/runtime" }, new Date(NOW));
    const rows = listCodex({ now: NOW, env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: runtimeHome } });
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual(["native-resumed", "runtime-1"]);
  });

  it("keeps Codex running through a quiet long tool call, then clears immediately on task_complete", () => {
    const home = path.join(sandbox, "codex-signals");
    const file = writeCodexRollout(path.join(home, "sessions"), "quiet-turn", { cwd: "/tmp/quiet" }, new Date(NOW));
    appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(NOW - 600_000).toISOString(), payload: { type: "task_started" } }) + "\n");
    utimesSync(file, new Date(NOW - 600_000), new Date(NOW - 600_000));
    const list = () => listCodex({ now: NOW, env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: home } });
    expect(list()[0]).toMatchObject({ status: "working", statusSource: "transcript-events" });
    appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(NOW).toISOString(), payload: { type: "task_complete" } }) + "\n");
    utimesSync(file, new Date(NOW), new Date(NOW));
    expect(list()[0]).toMatchObject({ status: "idle", statusSource: "transcript-events" });
  });

  it("keeps unrelated native sessions in the same folder as an owned shell", () => {
    const home = path.join(sandbox, "codex-siblings");
    writeCodexRollout(path.join(home, "sessions"), "owned-session", { cwd: "/tmp/shared" }, new Date(NOW));
    writeCodexRollout(path.join(home, "sessions"), "independent-session", { cwd: "/tmp/shared" }, new Date(NOW));
    const manager = { sessions: new Map([["s", { id: "s", transport: { name: "local" }, tmuxSession: "one", runtime: "codex", cwd: "/tmp/shared", resumeRef: "owned-session" }]]) };
    const rows = buildIndex({ manager, now: NOW, garrisonHomeDir: sandbox, claudeBackgroundAgents: [], env: { HOME: sandbox, GARRISON_HOME: sandbox, CODEX_HOME: home, GARRISON_CURSOR_HOME: sandbox, GEMINI_CLI_HOME: sandbox } });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(["shell:local:one", "independent-session"]));
    expect(rows.some((r: { id: string }) => r.id === "owned-session")).toBe(false);
  });

  it("shows Cursor flat text journals with unknown cwd and metadata-only CLI sessions", () => {
    const home = path.join(sandbox, "cursor-flat");
    const dir = path.join(home, "projects", "Users-client-project", "agent-transcripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "desktop.txt"), "user:\nPlease inspect the layout.\n");
    utimesSync(path.join(dir, "desktop.txt"), new Date(NOW), new Date(NOW));
    const chat = path.join(home, "chats", "ws", "cli-without-journal");
    mkdirSync(chat, { recursive: true });
    writeFileSync(path.join(chat, "meta.json"), JSON.stringify({ cwd: "/tmp/client", updatedAtMs: NOW, createdAtMs: NOW }));
    const rows = buildIndex({ now: NOW, garrisonHomeDir: sandbox, claudeBackgroundAgents: [], env: { HOME: sandbox, GARRISON_HOME: sandbox, GARRISON_CURSOR_HOME: home, GEMINI_CLI_HOME: sandbox } });
    expect(rows.find((r: { id: string }) => r.id === "desktop")).toMatchObject({ kind: "desktop", cwd: null, transcript: { format: "cursor-agent-text" } });
    expect(rows.find((r: { id: string }) => r.id === "cli-without-journal")).toMatchObject({ kind: "cli", cwd: "/tmp/client", status: "unknown" });
  });
});

describe("session-specific hook evidence", () => {
  const row = { id: "a", runtime: "cursor", cwd: "/tmp/shared", status: "unknown", lastActivityAt: new Date(NOW).toISOString() };
  it("does not light up sibling sessions when another id is working in the same folder", () => {
    const events = [{ event: "agent-start", runtime: "cursor", cwd: row.cwd, session_id: "b", ts: new Date(NOW).toISOString() }];
    expect(applyHookStatus(row, events, NOW).status).toBe("unknown");
  });
  it("does not apply an id-less cwd event when that cwd has several sessions", () => {
    const events = [{ event: "agent-start", runtime: "cursor", cwd: row.cwd, session_id: "unknown", ts: new Date(NOW).toISOString() }];
    expect(applyHookStatus(row, events, NOW, 2).status).toBe("unknown");
    expect(applyHookStatus(row, events, NOW, 1).status).toBe("working");
  });
  it("a later transcript completion wins over a missed Stop hook", () => {
    const events = [{ event: "agent-start", session_id: "a", ts: new Date(NOW - 1000).toISOString() }];
    expect(applyHookStatus({ ...row, status: "idle", statusAt: new Date(NOW).toISOString() }, events, NOW).status).toBe("idle");
  });
});
