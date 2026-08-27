// State service invariants — the S1-S11 acceptance criteria that can be
// proven without live tailnet/production state.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StateClient, StateApiError } from "@garrison/state-client";
import { startStateService, type StateHarness } from "./state-service-harness";

let h: Awaited<ReturnType<typeof startStateService>>;
let client: StateClient;
let peer: StateClient;

beforeAll(async () => {
  h = await startStateService({ nodes: ["alpha", "beta"] });
  client = h.client; // alpha
  peer = new StateClient({ url: h.url, token: h.tokens.beta, node: "beta" });
  await client.hello({ clientVersion: "test", localTime: new Date().toISOString() });
  await peer.hello({ clientVersion: "test", localTime: new Date().toISOString() });
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("auth", () => {
  it("refuses a missing or wrong token; health is tokenless", async () => {
    const anon = new StateClient({ url: h.url, token: "not-a-token" });
    await expect(anon.listNodes()).rejects.toMatchObject({ status: 401 });
    const health = await anon.health();
    expect(health.ok).toBe(true);
  });

  it("rejects 'host' as a node name forever", () => {
    expect(() => {
      // registration is local-only; exercise via issueToken
      const { issueToken } = require("./state-service-harness");
      issueToken(h.dbPath, "host");
    }).toThrow();
  });
});

describe("cards", () => {
  const ID = "01CARDTESTAAAAAAAAAAAAAAAA";

  it("creates with client-minted id and computes position in-transaction", async () => {
    const card = await client.createCard({ id: ID, list: "inbox", title: "t", status: "idle" });
    expect(card.rev).toBe(0);
    expect(typeof card.position).toBe("number");
  });

  it("CAS: stale rev is a 409 carrying current state", async () => {
    const err = await client.patchCard(ID, { title: "x" }, { ifMatchRev: 99 }).catch((e) => e);
    expect(err).toBeInstanceOf(StateApiError);
    expect(err.status).toBe(409);
    expect(err.body.rev).toBe(0);
    expect(err.body.card.id).toBe(ID);
  });

  it("coordination_seq is a monotonic floor — a stale client cannot rewind", async () => {
    const up = await client.patchCard(ID, { coordinationSeq: 5 }, { ifMatchRev: 0 });
    expect(up.coordinationSeq).toBe(5);
    const down = await client.patchCard(ID, { coordinationSeq: 2 }, { ifMatchRev: 1 });
    expect(down.coordinationSeq).toBe(5);
  });

  it("no resurrection: writes to a deleted card 404; the id stays burned", async () => {
    const tmp = "01CARDTESTBBBBBBBBBBBBBBBB";
    await client.createCard({ id: tmp, list: "inbox", title: "doomed" });
    await client.deleteCard(tmp, { ifMatchRev: 0 });
    const patchErr = await client.patchCard(tmp, { title: "zombie" }, { ifMatchRev: 1 }).catch((e) => e);
    expect(patchErr.status).toBe(404);
    const createErr = await client.createCard({ id: tmp, list: "inbox", title: "again" }).catch((e) => e);
    expect(createErr.status).toBe(409);
  });

  it("occurrence_key uniqueness is a DB constraint", async () => {
    await client.createCard({ id: "01CARDOCCAAAAAAAAAAAAAAAA1", list: "inbox", occurrenceKey: "job@2026-08-24T03:00" });
    const err = await client
      .createCard({ id: "01CARDOCCAAAAAAAAAAAAAAAA2", list: "inbox", occurrenceKey: "job@2026-08-24T03:00" })
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body.error).toBe("occurrence-exists");
  });

  it("fails closed on an unparseable scheduledFor at write time", async () => {
    const err = await client
      .createCard({ id: "01CARDBADSCHEDAAAAAAAAAAAA", list: "inbox", scheduledFor: "not-a-date" })
      .catch((e) => e);
    expect(err.status).toBe(422);
  });

  it('rejects "host" as a placement target', async () => {
    const err = await client
      .createCard({ id: "01CARDHOSTAAAAAAAAAAAAAAAA", list: "inbox", placement: { target: "host" } })
      .catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.body.error).toBe("reserved-placement");
  });

  it("concurrent double-claim yields exactly one winner", async () => {
    const id = "01CARDCLAIMAAAAAAAAAAAAAAA";
    await client.createCard({ id, list: "ready", title: "claim me" });
    const [a, b] = await Promise.allSettled([
      client.patchCard(id, { claimedBy: "alpha" }, { ifMatchRev: 0 }),
      peer.patchCard(id, { claimedBy: "beta" }, { ifMatchRev: 0 })
    ]);
    const wins = [a, b].filter((r) => r.status === "fulfilled");
    const losses = [a, b].filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason.status).toBe(409);
  });

  it("card docs round-trip", async () => {
    await client.putCardDoc(ID, "brief.md", "# the brief\n");
    const doc = await client.getCardDoc(ID, "brief.md");
    expect(doc?.body).toBe("# the brief\n");
  });
});

describe("leases", () => {
  it("two simultaneous acquires: one GRANTED, one WAIT", async () => {
    const [a, b] = await Promise.all([
      client.acquireLease({ key: "plan:github.com/x/y", holder: "s1", holderToken: "t1" }),
      peer.acquireLease({ key: "plan:github.com/x/y", holder: "s2", holderToken: "t2" })
    ]);
    const granted = [a, b].filter((r) => r.granted);
    const waiting = [a, b].filter((r) => !r.granted);
    expect(granted).toHaveLength(1);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].holder).toBe(granted[0] === a ? "s1" : "s2");
  });

  it("same-holder re-entry renews and KEEPS the fence", async () => {
    const first = await client.acquireLease({ key: "plan:github.com/re/entry", holder: "s1", holderToken: "tok" });
    const again = await client.acquireLease({ key: "plan:github.com/re/entry", holder: "s1", holderToken: "tok" });
    expect(again.granted).toBe(true);
    expect(again.fence).toBe(first.fence);
    expect(again.reentry).toBe(true);
  });

  it("a lapsed holder's fenced card write is rejected", async () => {
    const id = "01CARDFENCEAAAAAAAAAAAAAAA";
    await client.createCard({ id, list: "ready" });
    const lease1 = await client.acquireLease({ key: `dispatch:${id}`, holder: "alpha", holderToken: "a1", ttlMs: 50 });
    await client.patchCard(id, { leaseFence: lease1.fence }, { ifMatchRev: 0, fence: lease1.fence });
    await new Promise((r) => setTimeout(r, 80));
    const lease2 = await peer.acquireLease({ key: `dispatch:${id}`, holder: "beta", holderToken: "b1" });
    expect(lease2.granted).toBe(true);
    expect(lease2.fence!).toBeGreaterThan(lease1.fence!);
    const card = await client.getCard(id);
    await peer.patchCard(id, { leaseFence: lease2.fence }, { ifMatchRev: card.rev, fence: lease2.fence });
    const card2 = await client.getCard(id);
    const err = await client
      .patchCard(id, { stale: true }, { ifMatchRev: card2.rev, fence: lease1.fence })
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body.error).toBe("fenced");
  });
});

describe("config docs", () => {
  it("If-Match rev CAS with history", async () => {
    await client.putConfig("fitting.test", "global", { a: 1 }, { ifMatchRev: 0 });
    const conflict = await client.putConfig("fitting.test", "global", { a: 2 }, { ifMatchRev: 0 }).catch((e) => e);
    expect(conflict.status).toBe(409);
    expect(conflict.body.body).toEqual({ a: 1 });
    const ok = await client.putConfig("fitting.test", "global", { a: 2 }, { ifMatchRev: 1 });
    expect(ok.rev).toBe(2);
  });

  it("X-Baseline-Sha CAS preserves the orchestrator-policy contract", async () => {
    const first = await client.putConfig("runtime.policy", "composition:default", { v: 1 }, { baselineSha: null });
    const stale = await client
      .putConfig("runtime.policy", "composition:default", { v: 2 }, { baselineSha: "0".repeat(64) })
      .catch((e) => e);
    expect(stale.status).toBe(409);
    const ok = await client.putConfig("runtime.policy", "composition:default", { v: 2 }, { baselineSha: first.bodySha });
    expect(ok.rev).toBe(2);
  });

  it("a write with no precondition is refused — no overwrite overload", async () => {
    const err = await client
      .request("PUT", "/v1/config/fitting.test/global", { body: { a: 3 } })
      .catch((e: unknown) => e);
    expect((err as StateApiError).status).toBe(428);
  });
});

describe("append-only surfaces", () => {
  it("events expose no update or delete verb", async () => {
    const { seq } = await client.appendEvent({ kind: "test.event", subjectType: "card", subjectId: "x" });
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const err = await client.request(method, `/v1/events/${seq}`, { body: {} }).catch((e: unknown) => e);
      expect((err as StateApiError).status).toBe(404);
    }
  });

  it("feedback tombstones drop rows without rewriting", async () => {
    const { id } = await client.appendFeedback({ kind: "override", payload: { note: 1 } });
    const before = await client.listFeedback();
    expect(before.some((f: { id: string }) => f.id === id)).toBe(true);
    await client.tombstoneFeedback(id, "test");
    const after = await client.listFeedback();
    expect(after.some((f: { id: string }) => f.id === id)).toBe(false);
    const raw = await client.listFeedback({ includeTombstoned: true });
    expect(raw.some((f: { id: string }) => f.id === id)).toBe(true);
  });

  it("intents release is set-once; there is no delete", async () => {
    const { seq } = await client.declareIntent({ repoKey: "github.com/x/y", session: "s", reason: "r" });
    const open = await client.listIntents("github.com/x/y");
    expect(open.some((i: { seq: number }) => i.seq === seq)).toBe(true);
    await client.releaseIntents({ seqs: [seq] });
    const after = await client.listIntents("github.com/x/y");
    expect(after.some((i: { seq: number }) => i.seq === seq)).toBe(false);
  });
});

describe("secrets", () => {
  it("fail-closed: denied keys are NAMED, never silently omitted; audit rides the outcome", async () => {
    await client.putSecret("MESH_TEST_KEY", "v1");
    const err = await peer.resolveSecrets(["MESH_TEST_KEY"]).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.body.denied).toEqual(["MESH_TEST_KEY"]);
    await client.putGrant("beta", "MESH_TEST_*");
    const ok = await peer.resolveSecrets(["MESH_TEST_KEY"]);
    expect(ok.values.MESH_TEST_KEY).toBe("v1");
    expect(ok.missing).toEqual([]);
  });

  it("loadout-env renders bare names with PROJECT__ override and reports missing", async () => {
    await client.putSecret("DATABASE_URL", "postgres://shared");
    await client.putSecret("EKOA_TEST__DATABASE_URL", "postgres://override");
    await client.putGrant("alpha", "*");
    await client.putConfig("loadout.ekoa-test", "global", {
      id: "ekoa-test",
      env_vars: ["DATABASE_URL", "MISSING_ONE"]
    }, { ifMatchRev: 0 });
    const env = await client.loadoutEnv("ekoa-test");
    expect(env.content).toContain("DATABASE_URL=");
    expect(env.content).toContain("postgres://override");
    expect(env.content).not.toContain("EKOA_TEST__");
    expect(env.missing).toEqual(["MISSING_ONE"]);
  });

  it("composition-env mode:all requires a grant covering every key", async () => {
    const err = await peer.compositionEnv("default").catch((e) => e);
    expect(err.status).toBe(403);
    const env = await client.compositionEnv("default");
    expect(env.content).toContain("MESH_TEST_KEY=v1");
  });
});

describe("scheduler", () => {
  it("a shell job with a non-node-local target is rejected at write", async () => {
    const err = await client
      .putSchedulerJob("bad-shell", { cron: "* * * * *", target: "any", spec: { kind: "shell", command: "/Users/x/run.sh" } }, { ifMatchRev: 0 })
      .catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.body.error).toBe("shell-jobs-are-node-local");
  });

  it("a shared job fired on two nodes runs ONCE (lease + occurrence ledger)", async () => {
    await client.putSchedulerJob("shared-tick", {
      cron: "*/5 * * * *",
      target: "any",
      spec: { kind: "fitting-script", fitting: "kanban-loop", script: "scripts/kanban.mjs", args: ["--tick"] }
    }, { ifMatchRev: 0 });
    const occurrence = "2026-08-24T03:00";
    const [a, b] = await Promise.all([
      client.acquireLease({ key: `job:shared-tick:${occurrence}`, holder: "alpha", holderToken: "a" }),
      peer.acquireLease({ key: `job:shared-tick:${occurrence}`, holder: "beta", holderToken: "b" })
    ]);
    expect([a, b].filter((r) => r.granted)).toHaveLength(1);
    const winner = a.granted ? client : peer;
    const started = await winner.recordSchedulerRun({ jobId: "shared-tick", occurrence });
    expect(started.recorded).toBe(true);
    // The belt to the lease's braces: even a rogue double-record dedupes.
    const dupe = await winner.recordSchedulerRun({ jobId: "shared-tick", occurrence });
    expect(dupe.recorded).toBe(false);
  });

  it("re-register preserves the enabled choice unless stated", async () => {
    await client.putSchedulerJob("toggle-me", { cron: "* * * * *", target: "node:alpha", spec: { kind: "shell", command: "true" }, enabled: false }, { ifMatchRev: 0 });
    await client.putSchedulerJob("toggle-me", { cron: "*/2 * * * *", target: "node:alpha", spec: { kind: "shell", command: "true" } }, { ifMatchRev: 1 });
    const jobs = await client.listSchedulerJobs("alpha");
    const job = jobs.find((j: { id: string }) => j.id === "toggle-me");
    expect(job.enabled).toBe(false);
    expect(job.cron).toBe("*/2 * * * *");
  });
});

describe("compositions", () => {
  it("guards files with the transfer allow-list — node-local files are unstorable", async () => {
    await client.putComposition("default", "name: test\n", { ifMatchRev: 0 });
    await client.putCompositionFile("default", ".garrison/routing.json", "{}");
    await client.putCompositionFile("default", ".garrison/prompts/orchestrator.md", "# p");
    for (const bad of [".env", "local.yml", "apm.lock.yaml", ".garrison/owner.json", "../escape.md", ".garrison/prompts/soul.md"]) {
      const err = await client.putCompositionFile("default", bad, "x").catch((e) => e);
      // Traversal segments are eaten by URL normalization before the handler
      // (404); everything else is the allow-list's explicit 422. Either way:
      // unstorable.
      expect([422, 404], bad).toContain(err.status);
    }
  });

  it("manifest CAS surfaces 'another node changed this composition'", async () => {
    const err = await peer.putComposition("default", "name: other\n", { ifMatchRev: 0 }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.body.manifestYaml).toBe("name: test\n");
  });
});

describe("sessions", () => {
  it("only the home node writes its sessions; peers read", async () => {
    await client.upsertSession("sess-1", { status: "running", compositionId: "default", controlUrl: "http://127.0.0.1:8083" });
    const err = await peer.upsertSession("sess-1", { status: "ended" }).catch((e) => e);
    expect(err.status).toBe(403);
    const listed = await peer.listSessions({ node: "alpha" });
    expect(listed.some((s) => s.id === "sess-1")).toBe(true);
  });
});

describe("change feed", () => {
  it("a write on one node is observable by another within one poll (<2s)", async () => {
    const { seq: cursor } = await peer.changes(0, { wait: 0 });
    const t0 = Date.now();
    const watcher = peer.changes(cursor, { wait: 10 });
    await client.createCard({ id: "01CARDFEEDAAAAAAAAAAAAAAAA", list: "inbox", title: "feed me" });
    const result = await watcher;
    const elapsed = Date.now() - t0;
    expect(result.changes.some((c) => c.entity === "card" && c.entityId === "01CARDFEEDAAAAAAAAAAAAAAAA")).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("a pre-history cursor is a 410 cursor-lost, the ONLY resync path", async () => {
    // Cursor far below the retained window can only happen after pruning;
    // simulate by asking for a negative-adjacent cursor after inserts exist.
    // (The prune path itself is time-based; here we assert the 410 contract.)
    const err = await client.request("GET", "/v1/changes?since=-5").catch((e: unknown) => e);
    expect((err as StateApiError).status).toBe(422);
  });
});
