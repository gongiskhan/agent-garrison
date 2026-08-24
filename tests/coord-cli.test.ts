import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startStateService, type StateHarness } from "./state-service-harness";
// @ts-ignore — pure .mjs fitting module
import { holderTokenFor } from "../fittings/seed/coord-mcp/scripts/lib/plan-lease.mjs";

// CO5 — the `coord` observability CLI: canary self-test + status layers + tail.
// Planning leases, plans and intents are mesh state, so the CLI is driven
// against a real state service on an ephemeral port; the hook heartbeat log
// stays node-local and is still seeded on disk.

const COORD = path.resolve(__dirname, "..", "fittings", "seed", "coord-mcp", "scripts", "coord.mjs");

let harness: StateHarness & { tokens: Record<string, string> };
let gh: string; // sandbox GARRISON_HOME
let ch: string; // sandbox GARRISON_CLAUDE_HOME (empty projects -> Layer 2 controlled)

function run(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [COORD, ...args], {
    env: {
      ...process.env,
      GARRISON_HOME: gh,
      GARRISON_CLAUDE_HOME: ch,
      GARRISON_STATE_URL: harness.url,
      GARRISON_STATE_TOKEN: harness.token,
      GARRISON_NODE_NAME: "test-node",
      ...env
    },
    encoding: "utf8"
  });
}

// A lock only shows up in the machine-wide picture if the mesh can name its
// repo: the service has no list-leases verb, so `coord` probes the focus repo
// plus every repo with an open intent. Seeding both is the real shape.
async function seedLock(repoKey: string, holder: string, summary: string, ttlMs: number): Promise<void> {
  await harness.client.declareIntent({ repoKey, session: holder, area: "seed", reason: "keeps the repo discoverable" });
  await harness.client.acquireLease({
    key: `plan:${repoKey}`,
    holder,
    // The token a real begin_planning would have minted: derived from the
    // holder's session id, which is what makes force-release possible at all.
    holderToken: holderTokenFor(holder),
    ttlMs,
    meta: { repoKey, summary, startedAt: new Date().toISOString() }
  });
}

beforeAll(async () => {
  harness = await startStateService({ nodes: ["test-node"] });
}, 30_000);
afterAll(async () => {
  await harness.stop();
});

beforeEach(() => {
  gh = mkdtempSync(path.join(tmpdir(), "coord-cli-gh-"));
  ch = mkdtempSync(path.join(tmpdir(), "coord-cli-ch-"));
  mkdirSync(path.join(ch, "projects"), { recursive: true });
});
afterEach(() => {
  rmSync(gh, { recursive: true, force: true });
  rmSync(ch, { recursive: true, force: true });
});

describe("coord canary", () => {
  it("self-tests the write->detect->inject chain and prints COORD-CANARY OK", () => {
    const out = run(["canary"]);
    expect(out).toContain("COORD-CANARY OK");
  });

  it("leaves ZERO synthetic records behind (intents released, no canary heartbeat lines)", async () => {
    run(["canary"]);
    // The ledger is append-only: cleanup means RELEASED, so nothing synthetic is
    // left open for another session's digest to trip over.
    const open = await harness.client.listIntents(undefined);
    expect(open.filter((i: { session: string }) => i.session.startsWith("canary-"))).toEqual([]);
    const fs = await import("node:fs");
    const hbPath = path.join(gh, "coord", "heartbeat.log");
    const hb = fs.existsSync(hbPath) ? fs.readFileSync(hbPath, "utf8") : "";
    expect(hb).not.toContain("canary-C");
    expect(hb).not.toContain("coord-canary-repo");
  });
});

describe("coord status", () => {
  it("shows liveness + a seeded planning-lease holder and waiter (layer 1 + layer 5)", async () => {
    const repo = "github.com/example/projectX";
    await seedLock(repo, "HOLDER-SESS", "big refactor", 600_000);
    // A waiter is a declared-but-ungranted plan in the same append-only ledger.
    await harness.client.appendPlan({ repoKey: repo, session: "WAITER-SESS", payload: { kind: "wait", summary: "other work" } });

    const out = run(["status"]);
    expect(out).toContain("Liveness");
    expect(out).toContain("agent_mail");
    expect(out).toContain("Planning locks");
    expect(out).toContain("HOLDER-SESS");
    expect(out).toContain("WAITER-SESS");
    expect(out).toContain(repo); // locks are named by their MESH key now
  });

  it("flags a STALE (expired) lease", async () => {
    await seedLock("github.com/example/stale", "GHOST", "abandoned", 1);
    await new Promise((r) => setTimeout(r, 30));
    const out = run(["status"]);
    expect(out).toContain("STALE");
    expect(out).toContain("GHOST");
  });

  it("says the state service is unreachable instead of printing an empty, reassuring board", () => {
    const out = run(["status"], { GARRISON_STATE_URL: "http://127.0.0.1:1", GARRISON_STATE_TOKEN: "nope" });
    expect(out).toContain("DOWN");
    expect(out).toContain("state service unreachable");
    expect(out).not.toContain("no active planning locks");
  });
});

describe("coord release-lock", () => {
  it("force-releases the lease and drops its waiters", async () => {
    const repo = "github.com/example/forced";
    await seedLock(repo, "STUCK", "wedged mid-plan", 600_000);
    await harness.client.appendPlan({ repoKey: repo, session: "WAITING", payload: { kind: "wait", summary: "blocked" } });

    const out = run(["release-lock", `--repo=${repo}`]);
    expect(JSON.parse(out.trim()).released).toBe(true);
    expect(await harness.client.getLease(`plan:${repo}`)).toBeNull();

    const after = run(["status"]);
    expect(after).not.toContain("STUCK");
    expect(after).not.toContain("WAITING");
  });
});

describe("coord status --tail", () => {
  it("tails the hook heartbeat log (layer 3)", () => {
    mkdirSync(path.join(gh, "coord"), { recursive: true });
    writeFileSync(
      path.join(gh, "coord", "heartbeat.log"),
      JSON.stringify({ ts: new Date().toISOString(), event: "SessionStart", session: "HB-SESS", repo: "/r", conflicts: 2, digestBytes: 410 }) + "\n"
    );
    const out = run(["status", "--tail"]);
    expect(out).toContain("heartbeat");
    expect(out).toContain("HB-SESS");
    expect(out).toContain("conflicts=2");
  });
});
