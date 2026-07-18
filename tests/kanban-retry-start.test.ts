// Regression for needs-attention recovery through the board's visible Advance button.
// A parked card must resume the phase recorded in card.parkedFrom when that list still
// exists, even when the board-wide needs-attention validNext does not include it. The
// endpoint also keeps the existing run identity/artifacts + audit timeline and kicks an
// immediate recovered phase through the gateway.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
const RUNS_DIR = mkdtempSync(path.join(tmpdir(), "kanban-retry-runs-"));
process.env.GARRISON_RUNS_DIR = RUNS_DIR;

// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { createCard, loadCard, saveBoard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

let gateway: http.Server;
let gatewayChatPosts = 0;
let server: http.Server;
let base = "";
let root = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as { port: number }).port;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for recovered card dispatch");
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "kanban-retry-root-"));
  await saveBoard({
    version: 3,
    lists: [
      { id: "todo", title: "To Do", order: 0, kind: "manual", trigger: "manual", validNext: ["implement"] },
      { id: "implement", title: "Implement", order: 1, kind: "agent", trigger: "immediate", phase: "implement", validNext: ["done"] },
      { id: "plan", title: "Plan", order: 2, kind: "agent", trigger: "immediate", phase: "plan", validNext: ["done"] },
      { id: "done", title: "Done", order: 3, kind: "manual", trigger: "manual", terminal: true, validNext: [] },
      // Mirrors the live failure: Plan exists, but the board-wide recovery edges omit it
      // (and contain the pre-dedupe duplicate Implement edge).
      { id: "needs-attention", title: "Needs attention", order: 4, kind: "manual", trigger: "manual", validNext: ["todo", "implement", "implement"] }
    ],
    projects: {}
  }, root);

  gateway = http.createServer((req, res) => {
    if (req.method === "POST") {
      if (req.url === "/chat/stream") gatewayChatPosts += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "done" })}\n\n`);
      return res.end();
    }
    res.writeHead(200);
    res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
  server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl, cap: 10 }, root));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(RUNS_DIR, { recursive: true, force: true });
});

describe("POST /cards/:id/start — needs-attention retry", () => {
  it("restores a valid parkedFrom phase, preserves its audit/runDir, and auto-dispatches", async () => {
    const runId = "01RETRYRUN0000000000000000";
    const runDir = path.join(RUNS_DIR, "demo", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "FLOW_PLAN.md"), "# prior plan context\n", "utf8");

    const created = await createCard(root, {
      title: "retry the same planning phase",
      project: "demo",
      list: "needs-attention"
    });
    const failedAt = "2026-07-16T07:18:15.151Z";
    const legacyCreated = { ...created } as any;
    delete legacyCreated.logIndex;
    const parked = await saveCard(root, {
      ...legacyCreated,
      status: "needs-attention",
      iterations: 1,
      runId,
      runDir,
      parkedFrom: "plan",
      attentionReason: "Plan hit its turn cap",
      lastDispatchError: { at: failedAt, reason: "run-failed", listId: "plan", message: "turn cap" },
      events: [
        ...created.events,
        { at: failedAt, kind: "failed", message: "Run errored on Plan", detail: "turn cap" }
      ]
    });
    // This is deliberately a legacy/current run-failure card with no logIndex:
    // recovery resets iterations to 0, but the prior log must remain immutable.
    const priorLog = "# iteration 1\nrun failed: turn cap\n";
    const priorLogPath = path.join(root, "cards", parked.id, "log-1.md");
    writeFileSync(priorLogPath, priorLog, "utf8");
    const postsBefore = gatewayChatPosts;

    const response = await fetch(`${base}/cards/${parked.id}/start`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.advanced).toBe("plan");
    expect(body.card).toMatchObject({
      id: parked.id,
      list: "plan",
      status: "ok",
      runId,
      runDir,
      parkedFrom: null,
      attentionReason: null
    });

    await waitFor(async () => (await loadCard(root, parked.id)).list === "done");
    const final = await loadCard(root, parked.id);
    expect(gatewayChatPosts).toBe(postsBefore + 1);
    expect(final.runId).toBe(runId);
    expect(final.runDir).toBe(runDir);
    expect(final.iterations).toBe(1); // retry gets a fresh cap window
    expect(final.logIndex).toBe(2); // log chronology does not reset with the cap
    expect(readFileSync(priorLogPath, "utf8")).toBe(priorLog);
    expect(readFileSync(path.join(root, "cards", parked.id, "log-2.md"), "utf8")).toContain("done");
    expect(readFileSync(path.join(runDir, "FLOW_PLAN.md"), "utf8")).toBe("# prior plan context\n");
    expect(final.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "failed", message: "Run errored on Plan" }),
      expect.objectContaining({ kind: "recovered", message: "Recovered: advanced Needs attention → Plan" }),
      expect.objectContaining({ kind: "dispatch", message: expect.stringContaining("on Plan") })
    ]));

    // The existing card-summary projection stays unchanged, while detail links
    // expose both immutable logs and Watch replays the latest ordinal.
    const detail = await (await fetch(`${base}/cards/${parked.id}`)).json() as any;
    expect(detail.card).not.toHaveProperty("logIndex");
    expect(detail.links.logs.map((log: any) => log.n)).toEqual([1, 2]);
    const watch = await (await fetch(`${base}/cards/${parked.id}/watch`)).text();
    expect(watch).toContain(JSON.stringify({ n: 1, text: priorLog }));
    expect(watch).toContain('"n":2');
    expect(watch).toContain("done");
  });

  it("falls back to the first configured edge when parkedFrom no longer exists", async () => {
    const created = await createCard(root, {
      title: "removed parked phase",
      project: "demo",
      list: "needs-attention"
    });
    const parked = await saveCard(root, {
      ...created,
      status: "needs-attention",
      parkedFrom: "removed-phase",
      attentionReason: "phase was removed"
    });
    const postsBefore = gatewayChatPosts;

    const response = await fetch(`${base}/cards/${parked.id}/start`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.advanced).toBe("todo");
    expect(body.card).toMatchObject({ list: "todo", status: "ok", parkedFrom: null, attentionReason: null });
    expect(gatewayChatPosts).toBe(postsBefore); // To Do is manual; no accidental dispatch.
  });
});
