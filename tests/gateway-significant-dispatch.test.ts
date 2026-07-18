// Regression for the gateway -> real board seam: an engine-context PATCH is
// privileged, but only self-driven callers should suppress board dispatch.
// Significant Web registration hands progression to the board; the garrison
// doorway and quick inline cards retain their no-double-drive behavior.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const KANBAN = path.join(ROOT, "fittings/seed/kanban-loop");
const home = mkdtempSync(path.join(tmpdir(), "gateway-dispatch-home-"));
const boardRoot = mkdtempSync(path.join(tmpdir(), "gateway-dispatch-board-"));
const runsRoot = mkdtempSync(path.join(tmpdir(), "gateway-dispatch-runs-"));

process.env.GARRISON_HOME = home;
process.env.GARRISON_KANBAN_DIR = boardRoot;
process.env.GARRISON_RUNS_DIR = runsRoot;
process.env.GARRISON_POLICY_PATH = "/nonexistent/gateway-dispatch-policy.json";

let boardServer: http.Server;
let gatewayServer: http.Server;
let boardBase = "";
let gatewayChatPosts = 0;
let createAutonomousCard: any;

const buildPayload = ({ brief, project }: { brief: string; project: string | null }) => ({
  description: brief,
  goalMode: true,
  project
});

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function json(response: Response) {
  return response.json() as Promise<any>;
}

async function create(body: Record<string, unknown>) {
  const response = await fetch(`${boardBase}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(201);
  return (await json(response)).card;
}

async function card(id: string) {
  return (await json(await fetch(`${boardBase}/cards/${id}`))).card;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not settle before timeout");
}

beforeAll(async () => {
  mkdirSync(path.join(boardRoot, "cards"), { recursive: true });

  // This test board makes Done the Plan phase's valid next step, so one dispatch
  // reaches a manual terminal list. Count chat turns specifically: the engine
  // also reports the required compaction boundary through a separate POST.
  gatewayServer = http.createServer((req, res) => {
    if (req.method === "POST") {
      if (req.url === "/chat/stream") gatewayChatPosts += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "done" })}\n\n`);
      return res.end();
    }
    res.writeHead(200);
    res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gatewayServer)}`;

  // Dynamic imports keep all env-backed paths inside this test's sandbox.
  const [{ makeRequestHandler }, { seedBoard }, { saveBoard }, cards] = await Promise.all([
    // @ts-expect-error — plain ESM .mjs sibling, no .d.ts
    import("../fittings/seed/kanban-loop/scripts/server.mjs"),
    // @ts-expect-error — plain ESM .mjs sibling, no .d.ts
    import("../fittings/seed/kanban-loop/scripts/kanban.mjs"),
    // @ts-expect-error — plain ESM .mjs sibling, no .d.ts
    import("../fittings/seed/kanban-loop/lib/board.mjs"),
    // @ts-expect-error — plain ESM .mjs sibling, no .d.ts
    import("../fittings/seed/http-gateway/scripts/lib/autonomous-cards.mjs")
  ]);
  createAutonomousCard = cards.createAutonomousCard;
  const testBoard = seedBoard();
  testBoard.lists.find((list: { id: string }) => list.id === "plan").validNext = ["done"];
  await saveBoard(testBoard, boardRoot);

  boardServer = http.createServer(
    makeRequestHandler({ root: boardRoot, cwd: boardRoot, gatewayUrl, cap: 5 }, path.join(KANBAN, "dist"))
  );
  boardBase = `http://127.0.0.1:${await listen(boardServer)}`;
  mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
  writeFileSync(
    path.join(home, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: boardBase, port: Number(new URL(boardBase).port) })
  );
});

afterAll(async () => {
  await close(boardServer);
  await close(gatewayServer);
  rmSync(home, { recursive: true, force: true });
  rmSync(boardRoot, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
});

describe.sequential("gateway registration dispatch ownership", () => {
  it("auto-dispatches a significant Web card exactly once", async () => {
    const registered = await createAutonomousCard({
      message: "Implement a full feature with tests",
      classification: { taskType: "code", tier: "T2-deep" },
      opts: { project: "demo" },
      buildPayload,
      logFn: () => {}
    });

    expect(registered?.id).toBeTruthy();
    await waitFor(async () => gatewayChatPosts >= 1 && (await card(registered.id)).list === "done");
    // Let any accidental second driver reach the stub before asserting the
    // exactly-once property. The card's eventual verdict is outside this seam.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gatewayChatPosts).toBe(1);
  });

  it("keeps the in-session garrison doorway move suppressed", async () => {
    const before = gatewayChatPosts;
    const created = await create({ title: "doorway", project: "demo" });
    const moved = await fetch(`${boardBase}/cards/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "garrison-doorway" },
      body: JSON.stringify({ list: "plan", rev: created.rev })
    });
    expect(moved.status).toBe(200);
    expect((await json(moved)).dispatched).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(gatewayChatPosts).toBe(before);
    expect((await card(created.id)).list).toBe("plan");
  });

  it("keeps a quick gateway card inline instead of double-driving Implement", async () => {
    const before = gatewayChatPosts;
    const registered = await createAutonomousCard({
      message: "rename a local variable",
      classification: { taskType: "code", tier: "T0-trivial" },
      opts: { project: "demo", quick: true, targetList: "implement" },
      buildPayload,
      logFn: () => {}
    });

    expect(registered?.id).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(gatewayChatPosts).toBe(before);
    expect((await card(registered.id)).list).toBe("implement");
  });
});
