import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { POST as claim } from "@/app/api/dispatch/claim/route";
import { recordWorkerPulse, DISPATCH_PROTOCOL_VERSION } from "@/lib/mesh/node-workers";
// @ts-ignore — fitting server and board are source ESM.
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — fitting board is source ESM.
import { createCard, loadCard, saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


let root: string;
let priorHome: string | undefined;
let priorBoard: string | undefined;
const servers: http.Server[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "dispatch-claim-route-"));
  priorHome = process.env.GARRISON_HOME;
  priorBoard = process.env.GARRISON_KANBAN_DIR;
  process.env.GARRISON_HOME = root;
  process.env.GARRISON_KANBAN_DIR = path.join(root, "board");
  mkdirSync(process.env.GARRISON_KANBAN_DIR, { recursive: true });
  writeFileSync(path.join(root, "outpost-registry.json"), JSON.stringify([
    { name: "studio", token: "test-token", registeredAt: new Date().toISOString(), pending: false }
  ]));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorBoard === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = priorBoard;
  rmSync(root, { recursive: true, force: true });
});

function request(workerId: string) {
  return new Request("http://localhost/api/dispatch/claim", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ workerId })
  }) as any;
}

describe("dispatch claim readiness gate", () => {
  it("refuses a valid machine token when no fresh task-runner pulse exists", async () => {
    const response = await claim(request("worker-one"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ job: null, error: "worker-offline" });
  });

  it("refuses a replaced worker id and accepts the process owning the pulse", async () => {
    await recordWorkerPulse("studio", {
      workerId: "worker-new",
      protocolVersion: DISPATCH_PROTOCOL_VERSION,
      workerVersion: "0.2.0",
      activity: "idle",
      currentCardId: null,
      runtimes: ["agent-sdk:anthropic"],
      ready: true,
      detail: "ready"
    });
    let response = await claim(request("worker-old"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "worker-replaced" });

    response = await claim(request("worker-new"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: null });
  });

  it("durably parks a selected card when claim preflight fails", async () => {
    await recordWorkerPulse("studio", {
      workerId: "worker-one",
      protocolVersion: DISPATCH_PROTOCOL_VERSION,
      workerVersion: "0.2.0",
      activity: "idle",
      currentCardId: null,
      runtimes: ["agent-sdk:anthropic"],
      ready: true,
      detail: "ready"
    });
    const board = process.env.GARRISON_KANBAN_DIR!;
    await saveBoard({
      version: 3,
      lists: [
        { id: "plan", title: "Plan", order: 0, kind: "agent", trigger: "immediate", validNext: ["done"] },
        { id: "needs-attention", title: "Needs attention", order: 1, kind: "manual", trigger: "manual", validNext: ["plan"] },
        { id: "done", title: "Done", order: 2, kind: "manual", trigger: "manual", terminal: true, validNext: [] }
      ]
    }, board);
    const card = await createCard(board, {
      title: "missing remote environment",
      project: "project-without-loadout",
      scope: "project",
      list: "plan",
      placement: { target: "studio" },
      sequence: ["plan", "done"],
      duty: "code",
      level: 2
    });
    const server = http.createServer(makeRequestHandler({ root: board, cwd: board, gatewayUrl: null, cap: 10 }, board));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mkdirSync(path.join(root, "ui-fittings"), { recursive: true });
    writeFileSync(path.join(root, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));

    const response = await claim(request("worker-one"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "loadout-missing",
      cardId: card.id,
      parked: true
    });
    expect(await loadCard(board, card.id)).toMatchObject({
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "plan",
      retryKeepsContext: true,
      lastDispatchError: { reason: "loadout-missing", listId: "plan" }
    });
  });

  it("claims a non-project personal card with managed-workspace scope and no Loadout", async () => {
    await recordWorkerPulse("studio", {
      workerId: "worker-one",
      protocolVersion: DISPATCH_PROTOCOL_VERSION,
      workerVersion: "0.2.0",
      activity: "idle",
      currentCardId: null,
      runtimes: ["agent-sdk:anthropic"],
      ready: true,
      detail: "ready"
    });
    const board = process.env.GARRISON_KANBAN_DIR!;
    await saveBoard({
      version: 3,
      lists: [
        { id: "plan", title: "Plan", order: 0, kind: "agent", trigger: "immediate", validNext: ["done"] },
        { id: "needs-attention", title: "Needs attention", order: 1, kind: "manual", trigger: "manual", validNext: ["plan"] },
        { id: "done", title: "Done", order: 2, kind: "manual", trigger: "manual", terminal: true, validNext: [] }
      ]
    }, board);
    writeFileSync(path.join(board, "model.json"), JSON.stringify({
      steps: {
        code: {
          "2": [{
            duty: "plan",
            targetId: "cc-sonnet-low",
            runtime: "agent-sdk",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            effort: "low",
            params: { promptMode: "coding", maxTurns: 12 }
          }]
        }
      }
    }));
    const card = await createCard(board, {
      title: "personal planning",
      project: null,
      scope: "personal",
      list: "plan",
      placement: { target: "studio" },
      sequence: ["plan", "done"],
      duty: "code",
      level: 2
    });
    const server = http.createServer(makeRequestHandler({ root: board, cwd: board, gatewayUrl: null, cap: 10 }, board));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mkdirSync(path.join(root, "ui-fittings"), { recursive: true });
    writeFileSync(path.join(root, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));

    const response = await claim(request("worker-one"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).toMatchObject({
      cardId: card.id,
      project: null,
      scope: "personal",
      runtimeTarget: { runtime: "agent-sdk", provider: "anthropic" }
    });
    expect(body.job.loadout).toBeUndefined();
    expect(body.job.envContent).toBeUndefined();
    // The claim descriptor is what survives the Conversations cut. `status` is no
    // longer the claimer's to set: coherentCardState at the write choke point
    // mirrors status off the LIST (running <=> the running list), so the route's
    // `status: "running"` PATCH lands as "ok" on a card that sits elsewhere.
    expect(await loadCard(board, card.id)).toMatchObject({ status: "ok", dispatch: { machine: "studio", state: "claimed" } });
  });
});

// The Conversations cut retired the outpost-era completion seam: phase
// advancement died with the duty-list engine and remote work now rides the
// remote-shell runtime inside a conversation stretch. The endpoint stays
// mounted so an old worker gets a definitive answer rather than a 404.
describe("retired remote-dispatch completion seam", () => {
  it("answers POST /cards/:id/dispatch-complete with 410 instead of advancing a phase", async () => {
    const board = process.env.GARRISON_KANBAN_DIR!;
    await saveBoard({
      version: 3,
      lists: [
        { id: "plan", title: "Plan", order: 0, kind: "agent", trigger: "immediate", validNext: ["done"] },
        { id: "done", title: "Done", order: 1, kind: "manual", trigger: "manual", terminal: true, validNext: [] }
      ]
    }, board);
    const card = await createCard(board, { title: "remote work", project: null, list: "plan" });
    const server = http.createServer(makeRequestHandler({ root: board, cwd: board, gatewayUrl: null, cap: 10 }, board));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const response = await fetch(`${base}/cards/${card.id}/dispatch-complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine: "studio", workerId: "worker-one", verdict: "done" })
    });
    expect(response.status).toBe(410);
    expect((await response.json()).error).toMatch(/retired/i);
    // and the card was not advanced by it
    expect(await loadCard(board, card.id)).toMatchObject({ list: "plan" });
  });
});
