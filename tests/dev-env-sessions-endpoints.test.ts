import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DS2 endpoints + reboot-restore gate. Boots the real dev-env server fully
// sandboxed (own HOME/state/.claude, tmux OFF) and drives the new endpoints over
// HTTP. No claude is ever spawned — the restored tab and the open-from-history
// path are LAZY (resume happens later on focus), which is exactly the property
// under test.
const SB = mkdtempSync(path.join(tmpdir(), "ds2-endpoints-"));
const CLAUDE = path.join(SB, ".claude");
const STATE = path.join(SB, "state.json");
const PROJ = path.join(SB, "proj"); // a live agent's cwd
const PROJB = path.join(SB, "projB"); // a history-only session's cwd
const PROJC = path.join(SB, "projC"); // a restored (open, not live) tab's cwd
for (const d of [path.join(CLAUDE, "sessions"), path.join(CLAUDE, "projects", "enc"), PROJ, PROJB, PROJC]) {
  mkdirSync(d, { recursive: true });
}

process.env.HOME = SB; // status file → sandbox
process.env.GARRISON_STATE_PATH = STATE;
process.env.GARRISON_CLAUDE_HOME = CLAUDE;
process.env.DEV_ENV_USE_TMUX = "off";

const RESTORED_CSID = "11111111-aaaa-bbbb-cccc-222222222222"; // post-reboot open tab, no PTY
const LIVE_CSID = "33333333-dddd-eeee-ffff-444444444444"; // live agent
const HIST_CSID = "55555555-0000-1111-2222-666666666666"; // history only

// Live registry: one live claude in PROJ (this pid, no startedAt → skips the
// boot/reuse verification so no `ps` is shelled out in the test).
writeFileSync(path.join(CLAUDE, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: LIVE_CSID, cwd: PROJ, status: "idle" }));

// Transcripts: a history-only session AND the restored tab's session (so the
// "open is excluded from history" assertion is real, not vacuous).
const titleLine = (sid: string, title: string, cwd: string) =>
  [JSON.stringify({ type: "user", cwd, gitBranch: "main", message: { role: "user", content: "work" } }), JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: sid })].join("\n") + "\n";
writeFileSync(path.join(CLAUDE, "projects", "enc", `${HIST_CSID}.jsonl`), titleLine(HIST_CSID, "Past session title", PROJB));
writeFileSync(path.join(CLAUDE, "projects", "enc", `${RESTORED_CSID}.jsonl`), titleLine(RESTORED_CSID, "Restored tab title", PROJC));

// Ledger: a restored-but-not-live OPEN tab (the reboot survivor).
const nowIso = new Date().toISOString();
writeFileSync(
  STATE,
  JSON.stringify({
    version: 1,
    projects: {
      [PROJC]: {
        path: PROJC,
        name: "projC",
        sessions: {
          main: { branch: "main", projectPath: PROJC, id: "restored-id", claudeSessionId: RESTORED_CSID, openedInDevEnv: true, lastStatus: "idle", lastStatusAt: nowIso, createdAt: nowIso }
        }
      }
    }
  })
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

// Runtime path so TS treats the untyped server.mjs as `any` (no .d.mts for its
// large API) — the orchestrator-prefix.test.ts pattern.
const SERVER = path.join(__dirname, "..", "fittings", "seed", "dev-env", "scripts", "server.mjs");
const { startServer } = await import(SERVER);
let server: { close: () => void };
let base: string;

beforeAll(async () => {
  const port = await freePort();
  const r = await startServer({ port, host: "127.0.0.1", defaultShell: "/bin/zsh", dirtyTtlMs: 10_000, useTmux: "off" });
  server = r.server;
  base = `http://127.0.0.1:${r.options.port}`;
});

afterAll(() => {
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  rmSync(SB, { recursive: true, force: true });
});

const getJSON = async (p: string) => (await fetch(base + p)).json();
const postJSON = async (p: string, body: unknown) =>
  (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

describe("dev-env session endpoints — endpoints-ok + reboot-restore-ok", () => {
  it("reboot-restore: an openedInDevEnv record with no PTY shows as a restorable tab (no claude spawned)", async () => {
    const { sessions } = await getJSON("/sessions");
    const tab = sessions.find((s: { id: string }) => s.id === "restored-id");
    expect(tab).toBeTruthy();
    expect(tab.openedInDevEnv).toBe(true);
    expect(tab.claudeSessionId).toBe(RESTORED_CSID);
    expect(tab.claudePty.state).toBe("none"); // lazy — not spawned on boot
  });

  it("agents lists the live registry session, tagged not-open", async () => {
    const { agents } = await getJSON("/sessions/agents");
    const a = agents.find((x: { sessionId: string }) => x.sessionId === LIVE_CSID);
    expect(a).toBeTruthy();
    expect(a.cwd).toBe(PROJ);
    expect(a.isOpen).toBe(false);
  });

  it("history lists the titled past session and excludes live + open sessions", async () => {
    const { history } = await getJSON("/sessions/history");
    expect(history.find((x: { sessionId: string }) => x.sessionId === HIST_CSID)?.title).toBe("Past session title");
    expect(history.find((x: { sessionId: string }) => x.sessionId === LIVE_CSID)).toBeUndefined(); // live → Agents
    expect(history.find((x: { sessionId: string }) => x.sessionId === RESTORED_CSID)).toBeUndefined(); // open → tab
  });

  it("POST /sessions/open pins a history session as a tab WITHOUT spawning", async () => {
    const res = await postJSON("/sessions/open", { sessionId: HIST_CSID, cwd: PROJB, title: "Past session title" });
    expect(res.id).toBeTruthy();
    expect(res.session.openedInDevEnv).toBe(true);
    expect(res.session.claudeSessionId).toBe(HIST_CSID);
    expect(res.session.claudePty.state).toBe("none"); // lazy
    const { history } = await getJSON("/sessions/history");
    expect(history.find((x: { sessionId: string }) => x.sessionId === HIST_CSID)).toBeUndefined(); // now open
  });

  it("two sessions in the same cwd open as DISTINCT tabs (no identity collapse)", async () => {
    const id1 = "aaaaaaaa-1111-2222-3333-444444444444";
    const id2 = "bbbbbbbb-5555-6666-7777-888888888888";
    const r1 = await postJSON("/sessions/open", { sessionId: id1, cwd: PROJB, title: "S1" });
    const r2 = await postJSON("/sessions/open", { sessionId: id2, cwd: PROJB, title: "S2" });
    expect(r1.id).not.toBe(r2.id);
    expect(r1.session.claudeSessionId).toBe(id1);
    expect(r2.session.claudeSessionId).toBe(id2);
  });

  it("rejects an invalid (shell-injection) sessionId with 400", async () => {
    const res = await fetch(base + "/sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "$(reboot)", cwd: PROJB })
    });
    expect(res.status).toBe(400);
  });

  it("close unpins the tab but KEEPS the record", async () => {
    const res = await postJSON("/sessions/restored-id/close", {});
    expect(res.unpinned).toBe(true);
    const { sessions } = await getJSON("/sessions");
    const tab = sessions.find((s: { id: string }) => s.id === "restored-id");
    expect(tab).toBeTruthy(); // record kept (not deleted)
    expect(tab.openedInDevEnv).toBe(false);
  });
});
