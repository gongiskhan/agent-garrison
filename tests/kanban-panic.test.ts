import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore fitting modules are plain ESM
import { processBatch, processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore fitting modules are plain ESM
import { atomicWriteJSON, loadCard, saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore fitting modules are plain ESM
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore fitting modules are plain ESM
import { liveSessionPointerFile } from "../fittings/seed/kanban-loop/lib/live-session.mjs";
// @ts-ignore fitting modules are plain ESM
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "kanban-panic-"));
  roots.push(root);
  return root;
}

function board() {
  return {
    version: 3,
    lists: [
      { id: "plan", title: "Plan", order: 0, kind: "agent", trigger: "immediate", phase: "plan", validNext: ["done"] },
      { id: "test", title: "Test", order: 1, kind: "agent", trigger: "scheduler-beat", phase: "test", batched: true, validNext: ["done"] },
      { id: "done", title: "Done", order: 2, kind: "manual", trigger: "manual", terminal: true, validNext: [] },
      { id: "needs-attention", title: "Needs attention", order: 3, kind: "manual", trigger: "manual", validNext: ["plan", "test"] }
    ]
  };
}

async function putCard(root: string, id: string, overrides: Record<string, unknown> = {}) {
  const runDir = path.join(root, "runs", id);
  mkdirSync(path.join(root, "cards", id), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const card = {
    id,
    title: `panic ${id.slice(0, 4)}`,
    description: "stop safely",
    project: "demo",
    list: "plan",
    status: "ok",
    iterations: 0,
    rev: 0,
    runId: `run-${id}`,
    runDir,
    runSeq: 0,
    logIndex: 0,
    sessionIds: [],
    events: [],
    goalMode: false,
    ...overrides
  };
  await atomicWriteJSON(path.join(root, "cards", id, "card.json"), card);
  return card;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Panic engine semantics", () => {
  it("parks a single interrupted turn before a valid-looking partial verdict can advance", async () => {
    const root = tempRoot();
    process.env.GARRISON_POLICY_PATH = path.join(root, "no-policy.json");
    resetPolicyCache();
    const b = board();
    await saveBoard(b, root);
    const card = await putCard(root, "A".repeat(26));

    const result = await processCard({
      root,
      board: b,
      card,
      cwd: root,
      now: () => "2026-08-05T10:00:00.000Z",
      runFn: async ({ onJournal }: { onJournal: (identity: unknown) => void }) => {
        onJournal({ sessionId: "panic-session", transcriptPath: path.join(root, "panic-session.jsonl") });
        return {
          reply: "done",
          stoppedByUser: true,
          stoppedReason: "user-interrupt",
          interruptedByCardId: card.id,
          sessionId: "panic-session"
        };
      }
    });

    expect(result.outcome).toMatchObject({ status: "needs-attention", reason: "user-interrupt", interrupted: true });
    const disk = await loadCard(root, card.id);
    expect(disk).toMatchObject({
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "plan",
      iterations: 0,
      retryKeepsContext: true,
      sessionIds: ["panic-session"]
    });
    expect(disk.attentionReason).toMatch(/partial output.*not treated as a verdict/i);
    expect(disk.events.at(-1)).toMatchObject({ kind: "interrupted" });
    expect(readFileSync(path.join(root, "cards", card.id, "log-1.md"), "utf8")).toMatch(/partial output ignored for routing/i);
    expect(existsSync(liveSessionPointerFile(root, card.id, disk.runSeq)!)).toBe(false);
  });

  it("also treats Panic during the verdict follow-up as terminal", async () => {
    const root = tempRoot();
    process.env.GARRISON_POLICY_PATH = path.join(root, "no-policy.json");
    resetPolicyCache();
    const b = board();
    await saveBoard(b, root);
    const card = await putCard(root, "E".repeat(26));
    let calls = 0;

    const result = await processCard({
      root,
      board: b,
      card,
      cwd: root,
      runFn: async () => {
        calls += 1;
        return calls === 1
          ? { reply: "work finished; preparing the verdict" }
          : { reply: "done", stoppedByUser: true, stoppedReason: "user-interrupt", interruptedByCardId: card.id };
      }
    });

    expect(calls).toBe(2);
    expect(result.outcome).toMatchObject({ status: "needs-attention", reason: "user-interrupt" });
    expect(await loadCard(root, card.id)).toMatchObject({ list: "needs-attention", parkedFrom: "plan", iterations: 0 });
  });

  it("parks every member of an interrupted shared batch and never spends a verdict nudge", async () => {
    const root = tempRoot();
    process.env.GARRISON_POLICY_PATH = path.join(root, "no-policy.json");
    resetPolicyCache();
    const b = board();
    await saveBoard(b, root);
    const cards = await Promise.all([
      putCard(root, "B".repeat(26), { list: "test" }),
      putCard(root, "C".repeat(26), { list: "test" })
    ]);
    let calls = 0;

    const result = await processBatch({
      root,
      board: b,
      listId: "test",
      cards,
      cwd: root,
      now: () => "2026-08-05T10:00:00.000Z",
      batchRunFn: async ({ cards: running }: { cards: any[] }) => {
        calls += 1;
        return {
          reply: running.map((c) => `${c.id} done`).join("\n"),
          stoppedByUser: true,
          stoppedReason: "user-interrupt",
          interruptedByCardId: cards[1].id,
          affectedCardIds: cards.map((c) => c.id)
        };
      }
    });

    expect(calls).toBe(1);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o: any) => o.reason === "user-interrupt")).toBe(true);
    for (const card of cards) {
      const disk = await loadCard(root, card.id);
      expect(disk).toMatchObject({ list: "needs-attention", parkedFrom: "test", iterations: 0, retryKeepsContext: true });
      expect(disk.attentionReason).toMatch(/shared Test batch.*every card/i);
      expect(disk.events.at(-1)).toMatchObject({ kind: "interrupted" });
      const log = readFileSync(path.join(root, "cards", card.id, "log-1.md"), "utf8");
      expect(log).toContain(`# iteration 1 (batch:demo)`);
      expect(log).toContain(`${card.id} done`);
      expect(log).toMatch(/stopped by card Panic; every partial batch verdict was ignored/i);
    }
  });

  it("parks the whole batch when Panic lands during its verdict follow-up", async () => {
    const root = tempRoot();
    process.env.GARRISON_POLICY_PATH = path.join(root, "no-policy.json");
    resetPolicyCache();
    const b = board();
    await saveBoard(b, root);
    const cards = await Promise.all([
      putCard(root, "F".repeat(26), { list: "test" }),
      putCard(root, "G".repeat(26), { list: "test" })
    ]);
    let calls = 0;

    const result = await processBatch({
      root,
      board: b,
      listId: "test",
      cards,
      cwd: root,
      batchRunFn: async ({ cards: running }: { cards: any[] }) => {
        calls += 1;
        return calls === 1
          ? { reply: "tests finished; verdicts next" }
          : {
              reply: running.map((c) => `${c.id} done`).join("\n"),
              stoppedByUser: true,
              stoppedReason: "user-interrupt",
              interruptedByCardId: cards[0].id,
              affectedCardIds: cards.map((c) => c.id)
            };
      }
    });

    expect(calls).toBe(2);
    expect(result.outcomes.every((o: any) => o.reason === "user-interrupt")).toBe(true);
    for (const card of cards) {
      expect(await loadCard(root, card.id)).toMatchObject({ list: "needs-attention", parkedFrom: "test", iterations: 0 });
    }
  });
});

describe("POST /cards/:id/panic", () => {
  it("stops and releases a remote claim while preserving placement and partial evidence", async () => {
    const root = tempRoot();
    await saveBoard(board(), root);
    const id = "R".repeat(26);
    const evidence = path.join(root, "cards", id, "dispatch", "partial.txt");
    mkdirSync(path.dirname(evidence), { recursive: true });
    writeFileSync(evidence, "partial remote proof\n");
    await putCard(root, id, {
      status: "running",
      placement: { target: "studio" },
      dispatch: {
        machine: "studio",
        workerId: "worker-one",
        runId: "remote-run",
        routingToken: "route-one",
        phase: "plan",
        logIndex: 1,
        claimRevision: 1,
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        state: "running"
      }
    });
    const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10 }, root));
    const base = `http://127.0.0.1:${await listen(server)}`;
    try {
      const response = await fetch(`${base}/cards/${id}/panic`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, stopped: true, remote: true });
      expect(await loadCard(root, id)).toMatchObject({
        list: "needs-attention",
        status: "needs-attention",
        parkedFrom: "plan",
        placement: { target: "studio" },
        dispatch: { machine: "studio", state: "failed" }
      });
      expect(existsSync(evidence)).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("sends an exact card-bound interrupt and leaves the running CAS to the engine", async () => {
    const root = tempRoot();
    const b = board();
    await saveBoard(b, root);
    const card = await putCard(root, "D".repeat(26), { status: "running", runSeq: 3, rev: 7 });
    let interruptBody: any = null;
    const gateway = http.createServer((req, res) => {
      if (req.url === "/chat/interrupt" && req.method === "POST") {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          interruptBody = JSON.parse(raw);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, lane: "agent-sdk", stopped: true, cardIds: [card.id] }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
    const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl, cap: 10 }, root));
    const base = `http://127.0.0.1:${await listen(server)}`;

    try {
      const response = await fetch(`${base}/cards/${card.id}/panic`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        stopped: true,
        affectedCardIds: [card.id],
        sharedBatch: false
      });
      expect(interruptBody).toEqual({ cardId: card.id });
      // A separate endpoint write would bump rev and race processCard's terminal
      // CAS. Panic only signals; the active engine turn owns the eventual park.
      expect(await loadCard(root, card.id)).toMatchObject({ status: "running", list: "plan", rev: 7, runSeq: 3 });
    } finally {
      await close(server);
      await close(gateway);
    }
  });
});
