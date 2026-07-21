// GARRISON-FLOW-V2 S7 (D19) — the gateway cards every task-shaped turn.
//
// A trivial-plan turn runs inline under a `quick` card (POST + move to Implement,
// carrying quick:true) that the gateway auto-advances Implement→Done at turn
// completion; a significant turn lands in Plan for the engine. A follow-up turn
// about the same task attaches to the live card. These tests drive the real
// RoutedGateway card methods against a sandboxed stub board.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");

// A stub board: POST /cards returns an id at rev 0; PATCH moves the card + bumps
// the rev; GET returns the current rev+list. Records every POST body + PATCH move
// so a test can assert what the gateway sent (quick flag, target list).
function stubBoard() {
  const state: { rev: number; list: string; absent?: boolean; preparedRevert?: unknown } = { rev: 0, list: "backlog" };
  const posts: any[] = [];
  const patches: { list: string; engine: boolean; routeEvidence?: any }[] = [];
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/cards") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posts.push(JSON.parse(raw || "{}"));
        send(201, { card: { id: "01STUBCARD00000000000000AA", rev: 0 } });
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/cards/")) {
      if (state.absent) return send(404, { error: "card not found" });
      return send(200, {
        card: { id: "01STUBCARD00000000000000AA", rev: state.rev, list: state.list, preparedRevert: state.preparedRevert ?? null },
      });
    }
    if (req.method === "PATCH" && req.url?.startsWith("/cards/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        patches.push({
          list: body.list,
          engine: typeof req.headers["x-garrison-engine"] === "string",
          ...(body.routeEvidence ? { routeEvidence: body.routeEvidence } : {})
        });
        state.list = body.list;
        state.rev += 1;
        send(200, { card: { id: "01STUBCARD00000000000000AA", rev: state.rev, list: state.list } });
      });
      return;
    }
    send(404, { error: "nope" });
  });
  return { server, posts, patches, state };
}

async function makeGateway(boardUrl: string, garrisonHome: string) {
  process.env.GARRISON_HOME = garrisonHome;
  mkdirSync(path.join(garrisonHome, "ui-fittings"), { recursive: true });
  writeFileSync(
    path.join(garrisonHome, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: boardUrl, port: 0 })
  );
  const mod = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs")).href
  );
  const core = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/orchestrator/lib/routing-core.mjs")).href
  );
  const gw: any = Object.create(mod.RoutedGateway.prototype);
  gw.core = core;
  gw.logFn = () => {};
  gw._sessionCards = new Map();
  return gw;
}

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "gw-quick-"));
});
afterAll(() => {
  delete process.env.GARRISON_HOME;
});

describe("isTaskShaped — real work is carded, conversation is not (A14)", () => {
  it("code/implement/research/writing/image/video/ops are task-shaped; other and review are not", async () => {
    const gw = await makeGateway("http://127.0.0.1:1", home);
    // `implement` included: the classifier's vocab has the pipeline verbs, and
    // a "build this" ask lands on code OR implement - both must card, or the
    // same message cards one time and runs inline the next (seen live).
    for (const t of ["code", "implement", "research", "writing", "image", "video", "ops"]) {
      expect(gw.isTaskShaped({ taskType: t })).toBe(true);
    }
    expect(gw.isTaskShaped({ taskType: "other" })).toBe(false);
    expect(gw.isTaskShaped({ taskType: "review" })).toBe(false);
    expect(gw.isTaskShaped(null)).toBe(false);
  });
});

describe("createAutonomousCard — quick card lands in Implement with quick:true", () => {
  it("POSTs quick:true and moves the card to implement (engine-context)", async () => {
    const board = stubBoard();
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);
    const out = await gw.createAutonomousCard(
      "rename a local variable",
      { taskType: "code", tier: "T0-trivial" },
      { quick: true, targetList: "implement" }
    );
    expect(out).not.toBeNull();
    expect(out.id).toBe("01STUBCARD00000000000000AA");
    expect(board.posts[0].quick).toBe(true);
    expect(board.patches[board.patches.length - 1].list).toBe("implement");
    expect(board.patches.every((p) => p.engine)).toBe(true); // the move carried the engine header
    board.server.close();
  });

  it("a significant card still lands in Plan and never carries quick", async () => {
    const board = stubBoard();
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);
    const out = await gw.createAutonomousCard("build a feature", { taskType: "code", tier: "T2-deep" }, {});
    expect(out).not.toBeNull();
    expect(board.posts[0].quick).toBeUndefined();
    expect(board.state.list).toBe("plan");
    board.server.close();
  });
});

describe("completeQuickCard — auto-advance Implement→Done at completion", () => {
  it("moves the card to done with the engine header", async () => {
    const board = stubBoard();
    board.state.list = "implement";
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);
    const ok = await gw.completeQuickCard("01STUBCARD00000000000000AA");
    expect(ok).toBe(true);
    expect(board.state.list).toBe("done");
    expect(board.patches[board.patches.length - 1]).toEqual({ list: "done", engine: true });
    board.server.close();
  });

  it("carries the settled model + requested/applied effort evidence on the Done move", async () => {
    const board = stubBoard();
    board.state.list = "implement";
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);
    const ok = await gw.completeQuickCard("01STUBCARD00000000000000AA", {
      reply: "Changed the bounded file.",
      route: "sdk-haiku",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      effort: "low",
      effortApplied: true,
      tier: "T0-trivial",
      phase: "implement"
    });

    expect(ok).toBe(true);
    expect(board.patches.at(-1)?.routeEvidence).toMatchObject({
      targetId: "sdk-haiku",
      runtime: "agent-sdk",
      model: "claude-haiku-4-5",
      effort: "low",
      effortApplied: true,
      phase: "implement"
    });
    board.server.close();
  });
});

describe("session→card memory — liveness-gated attach (D19 + review F1)", () => {
  const CARD = "01STUBCARD00000000000000AA";

  async function withBoard(list: string, extra: Partial<{ absent: boolean; preparedRevert: unknown }> = {}) {
    const board = stubBoard();
    board.state.list = list;
    if (extra.absent) board.state.absent = true;
    if (extra.preparedRevert) board.state.preparedRevert = extra.preparedRevert;
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);
    return { board, gw };
  }

  it("attaches to a LIVE card of the same task type; a different task type does not", async () => {
    const { board, gw } = await withBoard("implement");
    gw.rememberCard("thread-1", { cardId: CARD, quick: false, taskType: "code" });
    expect((await gw.attachedCard("thread-1", { taskType: "code" }))?.cardId).toBe(CARD);
    expect(await gw.attachedCard("thread-1", { taskType: "research" })).toBeNull();
    board.server.close();
  });

  it("F1: a stale/completed (done) card is forgotten → attach returns null so a new turn registers fresh", async () => {
    const { board, gw } = await withBoard("done");
    gw.rememberCard("thread-2", { cardId: CARD, quick: false, taskType: "code" });
    expect(await gw.attachedCard("thread-2", { taskType: "code" })).toBeNull();
    // and it was forgotten — a second look is still null even if the board went live again
    board.state.list = "implement";
    expect(await gw.attachedCard("thread-2", { taskType: "code" })).toBeNull();
    board.server.close();
  });

  it("F1: parked, abandoned, and absent cards are all treated as non-live (forgotten)", async () => {
    for (const scenario of [
      { list: "needs-attention" },
      { list: "implement", extra: { preparedRevert: { state: "prepared", commits: [] } } },
      { list: "implement", extra: { absent: true } },
    ]) {
      const { board, gw } = await withBoard(scenario.list, (scenario as any).extra || {});
      gw.rememberCard("t", { cardId: CARD, quick: false, taskType: "code" });
      expect(await gw.attachedCard("t", { taskType: "code" })).toBeNull();
      board.server.close();
    }
  });

  it("F1c: a null session key never attaches (no-session-id surface never cross-attaches)", async () => {
    const { board, gw } = await withBoard("implement");
    gw.rememberCard(null, { cardId: CARD, quick: false, taskType: "code" }); // no-op
    expect(await gw.attachedCard(null, { taskType: "code" })).toBeNull();
    board.server.close();
  });
});
