import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findSessionByCwd,
  loadAllSessions,
  removeSession,
  setSessionStatus,
  statusFromHookEvent,
  upsertSession
} from "@/lib/garrison-sessions";

let tmpDir: string;
let garrisonStatePath: string;
let sequoiasStatePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-garrison-sessions-"));
  garrisonStatePath = path.join(tmpDir, "garrison.json");
  sequoiasStatePath = path.join(tmpDir, "sequoias.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("statusFromHookEvent", () => {
  it("maps Claude Code hook events to session statuses", () => {
    expect(statusFromHookEvent("UserPromptSubmit")).toBe("working");
    expect(statusFromHookEvent("PostToolUse")).toBe("working");
    expect(statusFromHookEvent("Stop")).toBe("idle");
    expect(statusFromHookEvent("Notification")).toBe("waiting");
    expect(statusFromHookEvent("Unknown")).toBe(null);
  });
});

describe("upsertSession + setSessionStatus + removeSession", () => {
  it("round-trips a session through the store", async () => {
    const now = new Date().toISOString();
    await upsertSession(
      "/repo",
      {
        branch: "main",
        worktreePath: "/wt/main",
        createdAt: now,
        lastStatus: "starting",
        lastStatusAt: now
      },
      { statePath: garrisonStatePath }
    );
    const sessions = await loadAllSessions({
      garrisonStatePath,
      sequoiasStatePath: path.join(tmpDir, "missing.json")
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].worktreePath).toBe("/wt/main");
  });

  it("setSessionStatus updates status + timestamp + hookEvent", async () => {
    const now = new Date().toISOString();
    await upsertSession(
      "/repo",
      {
        branch: "main",
        worktreePath: "/wt/main",
        createdAt: now,
        lastStatus: "starting",
        lastStatusAt: now
      },
      { statePath: garrisonStatePath }
    );
    const matched = await setSessionStatus("/repo", "main", "working", "UserPromptSubmit", {
      statePath: garrisonStatePath
    });
    expect(matched).toBe(true);
    const raw = JSON.parse(fs.readFileSync(garrisonStatePath, "utf8"));
    expect(raw.projects["/repo"].sessions.main.lastStatus).toBe("working");
    expect(raw.projects["/repo"].sessions.main.lastHookEvent).toBe("UserPromptSubmit");
  });

  it("setSessionStatus returns false when no matching session", async () => {
    const matched = await setSessionStatus("/repo", "missing", "working", "Stop", {
      statePath: garrisonStatePath
    });
    expect(matched).toBe(false);
  });

  it("removeSession deletes the entry", async () => {
    const now = new Date().toISOString();
    await upsertSession(
      "/repo",
      {
        branch: "main",
        worktreePath: "/wt/main",
        createdAt: now,
        lastStatus: "starting",
        lastStatusAt: now
      },
      { statePath: garrisonStatePath }
    );
    await removeSession("/repo", "main", { statePath: garrisonStatePath });
    const sessions = await loadAllSessions({
      garrisonStatePath,
      sequoiasStatePath: path.join(tmpDir, "missing.json")
    });
    expect(sessions).toEqual([]);
  });
});

describe("findSessionByCwd", () => {
  it("returns the project+branch of the session whose worktreePath matches realpath", async () => {
    const realDir = fs.realpathSync(tmpDir);
    const wt = path.join(realDir, "wt-a");
    fs.mkdirSync(wt);
    await upsertSession(
      "/repo",
      {
        branch: "feature/foo",
        worktreePath: wt,
        createdAt: new Date().toISOString(),
        lastStatus: "starting",
        lastStatusAt: new Date().toISOString()
      },
      { statePath: garrisonStatePath }
    );
    const found = await findSessionByCwd(wt, { statePath: garrisonStatePath });
    expect(found?.branch).toBe("feature/foo");
    expect(found?.projectPath).toBe("/repo");
  });

  it("returns null when no session matches", async () => {
    const found = await findSessionByCwd("/totally/not/here", {
      statePath: garrisonStatePath
    });
    expect(found).toBeNull();
  });
});

describe("loadAllSessions migration fallback", () => {
  it("merges Garrison-owned sessions with Sequoias-owned sessions", async () => {
    fs.writeFileSync(
      sequoiasStatePath,
      JSON.stringify({
        version: 1,
        projects: {
          "/seq-repo": {
            path: "/seq-repo",
            name: "seq",
            sessions: {
              main: {
                branch: "main",
                worktreePath: "/seq-repo",
                lastStatus: "idle",
                lastStatusAt: "2026-05-11T08:00:00Z"
              }
            }
          }
        }
      })
    );
    await upsertSession(
      "/g-repo",
      {
        branch: "feature/bar",
        worktreePath: "/wt/bar",
        createdAt: new Date().toISOString(),
        lastStatus: "working",
        lastStatusAt: new Date().toISOString()
      },
      { statePath: garrisonStatePath }
    );
    const all = await loadAllSessions({ garrisonStatePath, sequoiasStatePath });
    expect(all).toHaveLength(2);
    const branches = all.map((s) => s.branch).sort();
    expect(branches).toEqual(["feature/bar", "main"]);
  });

  it("when garrison + sequoias name the same project+branch, garrison wins", async () => {
    fs.writeFileSync(
      sequoiasStatePath,
      JSON.stringify({
        version: 1,
        projects: {
          "/repo": {
            path: "/repo",
            name: "x",
            sessions: {
              main: {
                branch: "main",
                worktreePath: "/repo",
                lastStatus: "dead",
                lastStatusAt: "2026-05-11T08:00:00Z"
              }
            }
          }
        }
      })
    );
    await upsertSession(
      "/repo",
      {
        branch: "main",
        worktreePath: "/repo",
        createdAt: new Date().toISOString(),
        lastStatus: "working",
        lastStatusAt: new Date().toISOString()
      },
      { statePath: garrisonStatePath }
    );
    const all = await loadAllSessions({ garrisonStatePath, sequoiasStatePath });
    expect(all).toHaveLength(1);
    expect(all[0].lastStatus).toBe("working");
  });
});
