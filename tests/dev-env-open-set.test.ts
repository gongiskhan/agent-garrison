import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// DS2 open-set gate. The persisted `openedInDevEnv` flag is what makes the tab
// strip survive a reboot (nothing is live then, so the strip can't be re-derived
// from liveness). state.mjs resolves STATE_FILE at module load, so the sandbox
// path is set BEFORE a dynamic import.
const sandboxDir = mkdtempSync(path.join(tmpdir(), "ds2-openset-"));
const STATE = path.join(sandboxDir, "state.json");
process.env.GARRISON_STATE_PATH = STATE;

// Runtime path so TS treats the untyped state.mjs as `any` (no .d.mts for its
// large API) — the orchestrator-prefix.test.ts pattern.
const STATE_MOD = path.join(__dirname, "..", "fittings", "seed", "dev-env", "scripts", "state.mjs");
const { setSessionOpen, migrateOpenSet, aggregateSessions, setSessionStatus, readStateFile, openSessionByClaudeId, applyHookEvent, tombstoneCwd, findSessionById } = await import(STATE_MOD);

interface SeedSession {
  id: string;
  branch: string;
  openedInDevEnv?: boolean;
}

function writeState(sessions: SeedSession[]): void {
  const sess: Record<string, unknown> = {};
  const nowIso = new Date().toISOString();
  for (const s of sessions) {
    sess[s.branch] = {
      branch: s.branch,
      projectPath: sandboxDir, // a real dir so aggregateSessions doesn't hide it
      id: s.id,
      createdAt: nowIso,
      lastStatus: "idle",
      lastStatusAt: nowIso,
      ...(Object.prototype.hasOwnProperty.call(s, "openedInDevEnv") ? { openedInDevEnv: s.openedInDevEnv } : {})
    };
  }
  writeFileSync(STATE, JSON.stringify({ version: 1, projects: { [sandboxDir]: { path: sandboxDir, name: "sandbox", sessions: sess } } }, null, 2));
}

function rawSessions(): Record<string, { openedInDevEnv?: boolean }> {
  return readStateFile()!.projects[sandboxDir].sessions;
}

beforeEach(() => writeState([]));
afterAll(() => rmSync(sandboxDir, { recursive: true, force: true }));

describe("open-set — open-set-ok", () => {
  it("setSessionOpen flips and persists openedInDevEnv; aggregateSessions exposes it", async () => {
    writeState([{ id: "s1", branch: "main" }]); // legacy record, no flag
    expect(aggregateSessions().find((r: { id: string; openedInDevEnv?: boolean }) => r.id === "s1")!.openedInDevEnv).toBe(false); // undefined → false

    expect(await setSessionOpen("s1", true)).toBe(true);
    expect(rawSessions().main.openedInDevEnv).toBe(true);
    expect(aggregateSessions().find((r: { id: string; openedInDevEnv?: boolean }) => r.id === "s1")!.openedInDevEnv).toBe(true);

    await setSessionOpen("s1", false);
    expect(rawSessions().main.openedInDevEnv).toBe(false);
    expect(aggregateSessions().find((r: { id: string; openedInDevEnv?: boolean }) => r.id === "s1")!.openedInDevEnv).toBe(false);
  });

  it("setSessionOpen returns false for an unknown session id", async () => {
    writeState([{ id: "s1", branch: "main" }]);
    expect(await setSessionOpen("nope", true)).toBe(false);
  });

  it("migrateOpenSet seeds legacy records from the derive, leaves explicit ones, and is idempotent", async () => {
    writeState([
      { id: "a", branch: "a" }, // legacy → derive says open
      { id: "b", branch: "b" }, // legacy → derive says closed
      { id: "c", branch: "c", openedInDevEnv: true } // explicit → untouched
    ]);
    const derive = (s: { id: string }) => s.id === "a";
    expect(await migrateOpenSet(derive)).toBe(2); // a, b seeded; c skipped

    const raw = rawSessions();
    expect(raw.a.openedInDevEnv).toBe(true);
    expect(raw.b.openedInDevEnv).toBe(false);
    expect(raw.c.openedInDevEnv).toBe(true);

    expect(await migrateOpenSet(derive)).toBe(0); // idempotent — all explicit now
  });

  it("hook-autocreated sessions default to openedInDevEnv:false (Agents, not auto-tab)", async () => {
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: {} }));
    await setSessionStatus(sandboxDir, "main", "working", "PostToolUse", { cwd: sandboxDir });
    expect(rawSessions().main.openedInDevEnv).toBe(false);
  });

  it("openSessionByClaudeId keeps two sessions in the SAME cwd as distinct pinned records; re-pins by id", async () => {
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: {} }));
    const a = await openSessionByClaudeId({ claudeSessionId: "aaaaaaaa-1111-2222-3333-444444444444", cwd: sandboxDir, title: "A" });
    const b = await openSessionByClaudeId({ claudeSessionId: "bbbbbbbb-5555-6666-7777-888888888888", cwd: sandboxDir, title: "B" });
    expect(a.id).not.toBe(b.id);
    const open = aggregateSessions().filter((r: { projectPath: string; openedInDevEnv?: boolean }) => r.projectPath === sandboxDir && r.openedInDevEnv);
    expect(open.length).toBe(2); // both distinct sessions present and pinned
    // re-opening A re-pins the SAME record (no duplicate)
    const a2 = await openSessionByClaudeId({ claudeSessionId: "aaaaaaaa-1111-2222-3333-444444444444", cwd: sandboxDir });
    expect(a2.id).toBe(a.id);
    expect(aggregateSessions().filter((r: { projectPath: string }) => r.projectPath === sandboxDir).length).toBe(2);
  });

  it("findSessionById exposes claudeSessionId + the map key (so lazy resume uses --resume the EXACT id, not --continue)", async () => {
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: {} }));
    const sid = "eeeeeeee-1111-2222-3333-444444444444";
    const rec = await openSessionByClaudeId({ claudeSessionId: sid, cwd: sandboxDir });
    const found = findSessionById(rec.id);
    expect(found.claudeSessionId).toBe(sid);
    expect(found.key).toBe(sid); // sessions-map key is the session id, not "main"
  });

  function countRecordsWithSid(sid: string): number {
    const st = readStateFile()!;
    let count = 0;
    for (const p of Object.values(st.projects) as Array<{ sessions?: Record<string, { claudeSessionId?: string }> }>) {
      for (const s of Object.values(p.sessions ?? {})) if (s.claudeSessionId === sid) count++;
    }
    return count;
  }

  it("a hook and /sessions/open racing on the same sid/cwd never create a duplicate record", async () => {
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: {} }));
    const sid = "dddddddd-1111-2222-3333-444444444444";
    await Promise.all([
      openSessionByClaudeId({ claudeSessionId: sid, cwd: sandboxDir, title: "T" }),
      applyHookEvent("PostToolUse", { cwd: sandboxDir, session_id: sid })
    ]);
    expect(countRecordsWithSid(sid)).toBe(1);
  });

  it("hook/open race never duplicates the sid even when a sid-LESS branch row already exists for the cwd", async () => {
    writeState([{ id: "pre", branch: "main" }]); // pre-existing sessions["main"], no claudeSessionId
    const sid = "ffffffff-1111-2222-3333-444444444444";
    await Promise.all([
      openSessionByClaudeId({ claudeSessionId: sid, cwd: sandboxDir, title: "T" }),
      applyHookEvent("PostToolUse", { cwd: sandboxDir, session_id: sid })
    ]);
    expect(countRecordsWithSid(sid)).toBe(1); // the id is never stamped onto two rows
  });

  it("two concurrent hooks for different sids against a sid-LESS cwd row never collapse — each ends up a distinct record", async () => {
    writeState([{ id: "pre", branch: "main" }]); // sid-less sessions["main"], projectPath=sandboxDir
    const sidA = "aaaaaaaa-9999-2222-3333-444444444444";
    const sidB = "bbbbbbbb-9999-2222-3333-444444444444";
    await Promise.all([
      applyHookEvent("PostToolUse", { cwd: sandboxDir, session_id: sidA }),
      applyHookEvent("PostToolUse", { cwd: sandboxDir, session_id: sidB })
    ]);
    expect(countRecordsWithSid(sidA)).toBe(1);
    expect(countRecordsWithSid(sidB)).toBe(1); // distinct rows — neither hijacked the other
  });

  it("a hook for a NEW sid in a cwd that already owns a DIFFERENT sid creates a distinct row (never hijacks/overwrites)", async () => {
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: {} }));
    const sidA = "11111111-aaaa-2222-3333-444444444444";
    const sidB = "22222222-bbbb-2222-3333-444444444444";
    await openSessionByClaudeId({ claudeSessionId: sidA, cwd: sandboxDir, title: "A" });
    await applyHookEvent("PostToolUse", { cwd: sandboxDir, session_id: sidB });
    expect(countRecordsWithSid(sidA)).toBe(1); // sidA preserved, not overwritten
    expect(countRecordsWithSid(sidB)).toBe(1); // sidB is its own distinct row
    const st = readStateFile()!;
    const ids = new Set<string>();
    for (const p of Object.values(st.projects) as Array<{ sessions?: Record<string, { id?: string; claudeSessionId?: string }> }>) {
      for (const s of Object.values(p.sessions ?? {})) if (s.claudeSessionId) ids.add(s.id!);
    }
    expect(ids.size).toBe(2); // two distinct session records
  });

  it("a hook carrying claudeSessionId updates the UUID-keyed /open record — no duplicate branch-keyed session", async () => {
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: {} }));
    const sid = "cccccccc-1111-2222-3333-444444444444";
    await openSessionByClaudeId({ claudeSessionId: sid, cwd: sandboxDir, title: "T" });
    await applyHookEvent("PostToolUse", { cwd: sandboxDir, session_id: sid });
    const sessions = rawSessions() as Record<string, { lastStatus?: string }>;
    expect(Object.keys(sessions)).toEqual([sid]); // the one UUID-keyed record, no sessions["main"] dup
    expect(sessions[sid].lastStatus).toBe("working");
  });

  it("a stale matched-hook write does not resurrect a session whose cwd was tombstoned by a concurrent delete", async () => {
    const projectPath = sandboxDir;
    // empty project (the session row was just deleted by DELETE /sessions)
    writeFileSync(STATE, JSON.stringify({ version: 1, projects: { [projectPath]: { path: projectPath, name: "r", sessions: {} } } }));
    tombstoneCwd(projectPath); // the concurrent delete tombstoned the session cwd
    // the stale matched hook fires against the project key, carrying the matched cwd
    const res = await setSessionStatus(projectPath, "feat", "working", "PostToolUse", {
      claudeSessionId: "ssssssss-1111-2222-3333-444444444444",
      cwd: projectPath
    });
    expect(res).toBeNull(); // tombstone honored against the cwd — not resurrected
    expect(Object.keys(readStateFile()!.projects[projectPath].sessions)).toEqual([]); // no row recreated
  });

  it("serializes a concurrent unpin and hook status update — both writes survive (no lost write/corruption)", async () => {
    writeState([{ id: "s1", branch: "main", openedInDevEnv: true }]);
    await Promise.all([
      setSessionOpen("s1", false), // unpin
      setSessionStatus(sandboxDir, "main", "working", "PostToolUse", { cwd: sandboxDir }) // hook
    ]);
    const raw = rawSessions().main as { openedInDevEnv?: boolean; lastStatus?: string };
    expect(raw.openedInDevEnv).toBe(false); // unpin landed
    expect(raw.lastStatus).toBe("working"); // hook landed too — neither clobbered the other
  });
});
