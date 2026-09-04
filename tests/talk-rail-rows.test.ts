// The Sessions section in the rail must never duplicate a conversation the
// user already sees above it: an owned shell IS its thread, a bare `claude`
// session already bound to a conversation IS that conversation, and a row a
// Kanban card already claimed is that card's business, not the rail's.
// visibleSessionRows is the one filter both app.tsx (badge count) and
// sessions-rail.tsx (row list) share, so this pins the filter once instead of
// trusting every call site to reimplement it identically.

import { describe, expect, it } from "vitest";
import { visibleSessionRows, type RailSession } from "../packages/talk/ui/sessions-rail";

function session(overrides: Partial<RailSession> = {}): RailSession {
  return {
    id: "claude:abc",
    node: "dev-madrid",
    nodeAccent: "#b1954e",
    nodeStatus: "online",
    shellOrigin: null,
    runtime: "claude",
    kind: "cli",
    cwd: "/home/ggomes/dev/garrison",
    project: "garrison",
    title: "fix the thing",
    status: "working",
    statusSource: "registry",
    startedAt: "2026-09-02T10:00:00Z",
    lastActivityAt: "2026-09-02T10:05:00Z",
    resumable: true,
    attachable: false,
    resumeRef: "abc",
    resumeCommand: "cd /home/ggomes/dev/garrison && claude --resume abc",
    shell: null,
    threadId: null,
    boundTo: null,
    claimedBy: null,
    transcript: { format: "claude-jsonl", path: "/home/ggomes/.claude/projects/x/abc.jsonl" },
    ...overrides
  };
}

describe("visibleSessionRows", () => {
  it("keeps a plain unbound, unclaimed session", () => {
    const rows = [session()];
    expect(visibleSessionRows(rows)).toEqual(rows);
  });

  it("drops a session already bound to a local thread", () => {
    const rows = [session({ threadId: "shell-dev-madrid-local-alpha" })];
    expect(visibleSessionRows(rows)).toEqual([]);
  });

  it("drops a session already recognised as an open conversation", () => {
    const rows = [session({ boundTo: { kind: "conversation", threadId: "t1" } })];
    expect(visibleSessionRows(rows)).toEqual([]);
  });

  it("drops a session a Kanban card has claimed", () => {
    const rows = [session({ claimedBy: { kind: "card", id: "card-9" } })];
    expect(visibleSessionRows(rows)).toEqual([]);
  });

  it("filters a mixed list to only the rows the rail should render", () => {
    const bare = session({ id: "codex:1" });
    const bound = session({ id: "claude:bound", threadId: "shell-mini-local-beta" });
    const claimed = session({ id: "cursor:claimed", claimedBy: { kind: "card", id: "c1" } });
    const desktop = session({ id: "cursor:desktop", kind: "desktop", runtime: "cursor", resumable: false });
    const out = visibleSessionRows([bare, bound, claimed, desktop]);
    expect(out.map((r) => r.id)).toEqual(["codex:1", "cursor:desktop"]);
  });

  it("never mutates the input array", () => {
    const rows = [session({ id: "a" }), session({ id: "b", threadId: "t" })];
    const copy = [...rows];
    visibleSessionRows(rows);
    expect(rows).toEqual(copy);
  });
});
