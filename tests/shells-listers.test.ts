// The four session listers (claude/codex/cursor/gemini) and buildIndex - the
// normalised Row shape they all feed. Every fixture is built in a fresh
// mkdtemp sandbox per test, following the DS1-reader convention in
// tests/dev-env-claude-sessions.test.ts.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { list as listClaude } from "../fittings/seed/remote-shell-runtime/lib/listers/claude.mjs";
// @ts-ignore — pure .mjs
import { list as listCodex } from "../fittings/seed/remote-shell-runtime/lib/listers/codex.mjs";
// @ts-ignore — pure .mjs
import { list as listCursor } from "../fittings/seed/remote-shell-runtime/lib/listers/cursor.mjs";
// @ts-ignore — pure .mjs
import { list as listGemini } from "../fittings/seed/remote-shell-runtime/lib/listers/gemini.mjs";
// @ts-ignore — pure .mjs
import { buildIndex } from "../fittings/seed/remote-shell-runtime/lib/session-index.mjs";

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
  rmSync(sandbox, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = prevHome;
});

describe("claude lister", () => {
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

    const rows = listCodex({ windowDays: 5, now: NOW, env: { GARRISON_HOME: sandbox, CODEX_HOME: home } as unknown as NodeJS.ProcessEnv });
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
    const rows = listCodex({ windowDays: 5, now: NOW, env: { GARRISON_HOME: sandbox, CODEX_HOME: home } as unknown as NodeJS.ProcessEnv });
    expect(rows[0].status).toBe("unknown");
  });
});

describe("cursor lister", () => {
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

    const rows = listCursor({ windowDays: 5, now: NOW, env: { GARRISON_CURSOR_HOME: home } as unknown as NodeJS.ProcessEnv });
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
          resumeRef: null, resumeCommand: null, paneCommand: "codex", lastOutputAt: NOW
        }]
      ])
    };

    const rows = buildIndex({
      manager: fakeManager as never,
      now: NOW,
      garrisonHomeDir,
      env: { GARRISON_HOME: sandbox, CODEX_HOME: codexHomeDir } as unknown as NodeJS.ProcessEnv,
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
      env: { GARRISON_HOME: sandbox, CODEX_HOME: codexHomeDir } as unknown as NodeJS.ProcessEnv,
      claudeBackgroundAgents: []
    });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["019f-fresh", "019f-stale"]);
    expect(rows[0].status).toBe("working");
    expect(rows[1].status).toBe("unknown");
  });
});
