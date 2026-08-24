import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startStateService, type StateHarness } from "./state-service-harness";

// The COMMITTED correctness gate for the planning gate now that it is MESH
// state: the lock is a lease on the state service, the plan ledger and the
// intents are its append-only tables, and there is NO local fallback.
//
// Driven the way Claude Code drives it — the real server.mjs as a child
// process, over newline-delimited JSON-RPC on stdio — so the transport, the
// discovery path and the tool envelopes are all under test, not just the libs.

const SERVER = path.resolve(__dirname, "..", "fittings", "seed", "coord-mcp", "scripts", "server.mjs");

interface RpcResult {
  content?: { type: string; text: string }[];
  isError?: boolean;
}

/** One coord-mcp process == one Claude Code session, which is the real shape. */
class CoordSession {
  private proc: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  stderr = "";

  constructor(env: Record<string, string>, cwd: string) {
    this.proc = spawn(process.execPath, [SERVER], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout!.on("data", (chunk) => {
      this.buffer += String(chunk);
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
    this.proc.stderr!.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
  }

  request(method: string, params?: unknown): Promise<Record<string, any>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} (stderr: ${this.stderr})`)), 15_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** The tool's JSON payload, plus the isError flag the envelope carries. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`tool ${name} errored: ${JSON.stringify(msg.error)}`);
    const result = msg.result as RpcResult;
    const payload = JSON.parse(result.content![0].text);
    return { ...payload, _isError: Boolean(result.isError) };
  }

  stop(): void {
    this.proc.kill("SIGTERM");
  }
}

function gitRepo(withOrigin: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coord-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (withOrigin) execFileSync("git", ["remote", "add", "origin", withOrigin], { cwd: dir });
  writeFileSync(path.join(dir, ".coord"), "");
  return dir;
}

let harness: StateHarness & { tokens: Record<string, string> };
let sessions: CoordSession[] = [];
let repos: string[] = [];

function session(name: string, node = "test-node"): CoordSession {
  const s = new CoordSession(
    {
      GARRISON_STATE_URL: harness.url,
      GARRISON_STATE_TOKEN: harness.tokens[node],
      GARRISON_NODE_NAME: node,
      COORD_SESSION: name
    },
    process.cwd()
  );
  sessions.push(s);
  return s;
}

function repo(origin: string | null = "https://github.com/example/thing.git"): string {
  const dir = gitRepo(origin);
  repos.push(dir);
  return dir;
}

beforeAll(async () => {
  harness = await startStateService({ nodes: ["test-node", "other-node"] });
}, 30_000);

afterAll(async () => {
  await harness.stop();
});

afterEach(() => {
  for (const s of sessions) s.stop();
  sessions = [];
  for (const d of repos) rmSync(d, { recursive: true, force: true });
  repos = [];
});

describe("coord-mcp over the state service", () => {
  it("speaks MCP stdio and advertises its tools unchanged", async () => {
    const a = session("A");
    const init = await a.request("initialize", {});
    expect(init.result.protocolVersion).toBe("2024-11-05");
    expect(init.result.serverInfo.name).toBe("coord-mcp");
    const list = await a.request("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "begin_planning",
      "end_planning",
      "plan_heartbeat",
      "plan_status",
      "declare_intent",
      "release_intents",
      "coord_digest"
    ]);
  });

  it("PLAN-GATE — A grants, B (another process) waits, A releases, B inherits A's plan", async () => {
    const dir = repo();
    const a = session("sessionA");
    const b = session("sessionB");

    const granted = await a.call("begin_planning", { repo: dir, summary: "refactor the capability resolver" });
    expect(granted.status).toBe("GRANTED");
    // The repo is keyed by its normalized ORIGIN, so the same checkout on any
    // node — at any path — is the same lock.
    expect(granted.repo).toBe("github.com/example/thing");
    expect(granted.lock.fence).toBeGreaterThan(0);
    expect(granted.readBundle.releasedPlan).toBeNull();

    const wait = await b.call("begin_planning", { repo: dir, summary: "rework the runner" });
    expect(wait.status).toBe("WAIT");
    expect(wait.holder.session).toBe("sessionA");
    expect(wait.holder.summary).toBe("refactor the capability resolver");
    expect(wait.holder.expiresAt).toBeTruthy();

    // B recorded itself as a waiter; plan_status surfaces it beside the holder.
    const status = await a.call("plan_status", { repo: dir });
    expect(status.lock.held).toBe(true);
    expect(status.lock.lock.session).toBe("sessionA");
    expect(status.waiters.map((w: { session: string }) => w.session)).toContain("sessionB");

    const beat = await a.call("plan_heartbeat", { repo: dir });
    expect(beat.ok).toBe(true);

    const end = await a.call("end_planning", { repo: dir });
    expect(end.status).toBe("RELEASED");

    const second = await b.call("begin_planning", { repo: dir, summary: "rework the runner" });
    expect(second.status).toBe("GRANTED");
    expect(second.readBundle.releasedPlan.summary).toBe("refactor the capability resolver");
    expect(second.readBundle.releasedPlan.session).toBe("sessionA");
  });

  it("re-entry by the same session renews and KEEPS the fence (a mid-session restart is not a WAIT)", async () => {
    const dir = repo("https://github.com/example/reentry.git");
    const first = await session("same").call("begin_planning", { repo: dir, summary: "long plan" });
    expect(first.status).toBe("GRANTED");
    // A brand-new PROCESS for the same session id — what a crashed-and-respawned
    // MCP server looks like. It must re-enter its own lease, not wait on it.
    const again = await session("same").call("begin_planning", { repo: dir, summary: "long plan" });
    expect(again.status).toBe("GRANTED");
    expect(again.lock.fence).toBe(first.lock.fence);
  });

  it("heartbeat on a lapsed lease refuses, and another session takes it over", async () => {
    const dir = repo("https://github.com/example/stale.git");
    const a = new CoordSession(
      {
        GARRISON_STATE_URL: harness.url,
        GARRISON_STATE_TOKEN: harness.tokens["test-node"],
        GARRISON_NODE_NAME: "test-node",
        COORD_SESSION: "ghost",
        COORD_PLAN_LOCK_TTL_MS: "700"
      },
      process.cwd()
    );
    sessions.push(a);
    expect((await a.call("begin_planning", { repo: dir, summary: "abandoned" })).status).toBe("GRANTED");
    await new Promise((r) => setTimeout(r, 900)); // past the TTL — no heartbeat

    const beat = await a.call("plan_heartbeat", { repo: dir });
    expect(beat.ok).toBe(false);
    expect(beat.reason).toBe("expired");

    const taker = await session("taker").call("begin_planning", { repo: dir, summary: "takeover" });
    expect(taker.status).toBe("GRANTED");
    expect(taker.recoveredStaleLock).toBe(true);
  });

  it("different repos never block each other", async () => {
    const one = repo("https://github.com/example/one.git");
    const two = repo("git@github.com:example/two.git");
    const a = session("A");
    const b = session("B");
    expect((await a.call("begin_planning", { repo: one, summary: "x" })).status).toBe("GRANTED");
    const other = await b.call("begin_planning", { repo: two, summary: "y" });
    expect(other.status).toBe("GRANTED");
    expect(other.repo).toBe("github.com/example/two"); // scp-like origin normalises the same
  });

  it("a checkout with NO origin is node-scoped: two nodes at the same path do not share a lock", async () => {
    const dir = repo(null);
    const mine = session("here", "test-node");
    const theirs = session("there", "other-node");

    const a = await mine.call("begin_planning", { repo: dir, summary: "on this node" });
    const b = await theirs.call("begin_planning", { repo: dir, summary: "on the other node" });

    expect(a.status).toBe("GRANTED");
    expect(b.status).toBe("GRANTED"); // NOT a WAIT — these are two different checkouts
    expect(a.repo).toMatch(/^local:test-node:[0-9a-f]{16}$/);
    expect(b.repo).toMatch(/^local:other-node:[0-9a-f]{16}$/);
    expect(a.repo).not.toBe(b.repo);

    // And each node's plan_status sees only its own lease.
    const mineStatus = await mine.call("plan_status", { repo: dir });
    const theirStatus = await theirs.call("plan_status", { repo: dir });
    expect(mineStatus.lock.lock.session).toBe("here");
    expect(theirStatus.lock.lock.session).toBe("there");
  });

  it("intents are mesh state: a conflict declared in one process surfaces in another's digest", async () => {
    const dir = repo("https://github.com/example/intents.git");
    const a = session("OWNER");
    const b = session("READER");

    const declared = await a.call("declare_intent", { repo: dir, area: "src/lib/runner.ts", reason: "rewiring up()" });
    expect(declared.status).toBe("DECLARED");
    expect(declared.intent.seq).toBeGreaterThan(0);

    const digest = await b.call("coord_digest", { repo: dir, area: "src/lib/runner.ts" });
    expect(digest.hasConflicts).toBe(true);
    expect(digest.text).toContain("OWNER");
    expect(digest.text).toContain("rewiring up()");
    expect(digest.text).toContain("begin_planning"); // the standing nudge
    expect(digest.bytes).toBeLessThan(1400);

    // Release is a set-once tombstone, not a delete: the conflict stops surfacing.
    expect((await a.call("release_intents", { repo: dir })).released).toBe(1);
    const after = await b.call("coord_digest", { repo: dir, area: "src/lib/runner.ts" });
    expect(after.hasConflicts).toBe(false);
  });

  it("a session does not conflict with its own intent, and other repos are unaffected", async () => {
    const dir = repo("https://github.com/example/scope.git");
    const other = repo("https://github.com/example/elsewhere.git");
    const a = session("SOLO");
    await a.call("declare_intent", { repo: dir, area: "src/x", reason: "mine" });
    expect((await a.call("coord_digest", { repo: dir, area: "src/x" })).hasConflicts).toBe(false);
    expect((await a.call("coord_digest", { repo: other, area: "src/x" })).hasConflicts).toBe(false);
  });

  it("FAILURE HONESTY — an unreachable service is a loud error naming it, never a local lock", async () => {
    const dir = repo("https://github.com/example/down.git");
    const orphan = new CoordSession(
      {
        GARRISON_STATE_URL: "http://127.0.0.1:1", // nothing listens here
        GARRISON_STATE_TOKEN: "irrelevant",
        GARRISON_NODE_NAME: "test-node",
        COORD_SESSION: "stranded",
        GARRISON_HOME: mkdtempSync(path.join(tmpdir(), "coord-nohome-"))
      },
      process.cwd()
    );
    sessions.push(orphan);
    const res = await orphan.call("begin_planning", { repo: dir, summary: "should not be granted" });
    expect(res._isError).toBe(true);
    expect(res.status).toBe("ERROR");
    expect(res.error).toBe("state-unavailable");
    expect(res.service).toBe("http://127.0.0.1:1");
    expect(res.message).toContain("no local fallback");
  });

  it("an UNENROLLED node refuses rather than guessing a service", async () => {
    const dir = repo("https://github.com/example/unenrolled.git");
    const bare = new CoordSession(
      {
        GARRISON_STATE_URL: "",
        GARRISON_STATE_TOKEN: "",
        GARRISON_NODE_NAME: "test-node",
        COORD_SESSION: "unenrolled",
        // A GARRISON_HOME with no state.json — the file fallback finds nothing.
        GARRISON_HOME: mkdtempSync(path.join(tmpdir(), "coord-unenrolled-"))
      },
      process.cwd()
    );
    sessions.push(bare);
    const res = await bare.call("plan_status", { repo: dir });
    expect(res._isError).toBe(true);
    expect(res.message).toContain("not enrolled in the mesh");
  });

  it("discovers the service from $GARRISON_HOME/state.json when the env is bare", async () => {
    const dir = repo("https://github.com/example/discovery.git");
    const home = mkdtempSync(path.join(tmpdir(), "coord-home-"));
    writeFileSync(
      path.join(home, "state.json"),
      JSON.stringify({ url: harness.url, token: harness.tokens["test-node"], node: "test-node" })
    );
    const viaFile = new CoordSession(
      { GARRISON_STATE_URL: "", GARRISON_STATE_TOKEN: "", GARRISON_HOME: home, COORD_SESSION: "file-discovered" },
      process.cwd()
    );
    sessions.push(viaFile);
    expect((await viaFile.call("begin_planning", { repo: dir, summary: "found it" })).status).toBe("GRANTED");
    rmSync(home, { recursive: true, force: true });
  });
});
