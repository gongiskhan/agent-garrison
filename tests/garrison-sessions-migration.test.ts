import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  upsertSession,
  loadAllSessions,
  findWorktreeById,
  setWorktreeStatus,
  setBinding,
  removeBinding,
  updateBindingLastSummary
} from "@/lib/garrison-sessions";
import type { WorktreeBinding } from "@/lib/types";

let stateFile: string;

beforeEach(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-state-"));
  stateFile = path.join(dir, "state.json");
});

afterEach(async () => {
  if (stateFile) {
    await fsp.rm(path.dirname(stateFile), { recursive: true, force: true }).catch(() => null);
  }
});

describe("garrison-sessions migration + helpers", () => {
  it("legacy session record gains status/baseBranch/urls defaults on read; id assigned on next upsert", async () => {
    const legacyState = {
      version: 1,
      projects: {
        "/test/repo": {
          path: "/test/repo",
          name: "repo",
          sessions: {
            "feat/x": {
              branch: "feat/x",
              worktreePath: "/test/wt/feat-x",
              ports: { frontend: 50000 },
              createdAt: "2026-01-01T00:00:00Z",
              lastStatus: "idle",
              lastStatusAt: "2026-01-01T00:00:00Z"
            }
          }
        }
      }
    };
    await fsp.mkdir(path.dirname(stateFile), { recursive: true });
    await fsp.writeFile(stateFile, JSON.stringify(legacyState));

    const sessions = await loadAllSessions({ garrisonStatePath: stateFile, sequoiasStatePath: "/dev/null" });
    expect(sessions).toHaveLength(1);

    // Touch the record via upsertSession (preserving the worktreePath); this is
    // the path that assigns a stable UUID.
    await upsertSession(
      "/test/repo",
      {
        branch: "feat/x",
        worktreePath: "/test/wt/feat-x",
        ports: { frontend: 50000 },
        createdAt: "2026-01-01T00:00:00Z",
        lastStatus: "idle",
        lastStatusAt: "2026-01-01T00:00:00Z"
      },
      { statePath: stateFile }
    );

    const id = await readId(stateFile);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const found = await findWorktreeById(id ?? "", { statePath: stateFile });
    expect(found?.session.status).toBe("active");
    expect(found?.session.baseBranch).toBe("main");
    expect(found?.session.urls?.frontend).toMatch(/^http:\/\/.+:50000$/);
  });

  it("setWorktreeStatus changes status to merged", async () => {
    await upsertSession(
      "/r",
      {
        branch: "feat/y",
        worktreePath: "/w/feat-y",
        createdAt: "now",
        lastStatus: "idle",
        lastStatusAt: "now",
        id: "11111111-1111-1111-1111-111111111111",
        status: "active",
        baseBranch: "main"
      },
      { statePath: stateFile }
    );
    const ok = await setWorktreeStatus("/r", "feat/y", "merged", { statePath: stateFile });
    expect(ok).toBe(true);
    const found = await findWorktreeById("11111111-1111-1111-1111-111111111111", { statePath: stateFile });
    expect(found?.session.status).toBe("merged");
  });

  it("setBinding adds, replaces and removeBinding deletes", async () => {
    await upsertSession(
      "/r",
      {
        branch: "feat/z",
        worktreePath: "/w/feat-z",
        createdAt: "now",
        lastStatus: "idle",
        lastStatusAt: "now",
        id: "22222222-2222-2222-2222-222222222222",
        baseBranch: "main",
        status: "active"
      },
      { statePath: stateFile }
    );
    const b1: WorktreeBinding = {
      soul: "engineer",
      sessionId: "s1",
      mode: "headless",
      tier: { model: "claude-haiku-4-5" },
      tierFlags: ["--model", "claude-haiku-4-5"],
      spawnedAt: "now"
    };
    await setBinding("/r", "feat/z", b1, { statePath: stateFile });
    let found = await findWorktreeById("22222222-2222-2222-2222-222222222222", { statePath: stateFile });
    expect(found?.session.bindings).toHaveLength(1);

    const b2: WorktreeBinding = { ...b1, tier: { model: "claude-opus-4-7" }, tierFlags: ["--model", "claude-opus-4-7"] };
    await setBinding("/r", "feat/z", b2, { statePath: stateFile });
    found = await findWorktreeById("22222222-2222-2222-2222-222222222222", { statePath: stateFile });
    expect(found?.session.bindings).toHaveLength(1);
    expect(found?.session.bindings?.[0].tier.model).toBe("claude-opus-4-7");

    await updateBindingLastSummary("/r", "feat/z", "s1", "2026-05-13T00:00:00Z", { statePath: stateFile });
    found = await findWorktreeById("22222222-2222-2222-2222-222222222222", { statePath: stateFile });
    expect(found?.session.bindings?.[0].lastSummaryAt).toBe("2026-05-13T00:00:00Z");

    const removed = await removeBinding("/r", "feat/z", { sessionId: "s1" }, { statePath: stateFile });
    expect(removed).toBe(true);
    found = await findWorktreeById("22222222-2222-2222-2222-222222222222", { statePath: stateFile });
    expect(found?.session.bindings).toEqual([]);
  });
});

async function readId(filePath: string): Promise<string | null> {
  const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as {
    projects: Record<string, { sessions: Record<string, { id?: string }> }>;
  };
  for (const project of Object.values(raw.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (session.id) return session.id;
    }
  }
  return null;
}
