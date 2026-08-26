// The gateway → board REGISTRATION seam, against the real five-list board.
//
// This file used to pin dispatch OWNERSHIP: a significant Web registration
// handed progression to the board, which drove the card exactly once, while the
// garrison doorway and quick inline cards suppressed that drive. The
// Conversations cut removed board dispatch entirely, and the surviving half of
// that invariant — "a move never dispatches" — now lives in
// tests/kanban-dispatch.test.ts, which covers the human move, the engine move,
// the Running door and the requestsAutoDispatch predicate. None of it is
// repeated here.
//
// What is left, and what this file now pins, is the half nothing else covers:
// createAutonomousCard is still the door every channel's significant work walks
// through, and it finishes by MOVING the new card onto `opts.targetList`. The
// board validates that list. So the registration lane and the board's column
// set have to agree, and the cut changed one of them.
//
// The stub-board suites (tests/gateway-quick-card.test.ts,
// tests/autonomous-card-retry.test.ts) exercise the same function against a
// fake that accepts any list, which is right for what they assert (payload
// shape, rev-race retry) and is exactly why they cannot see this. Here the
// board is the real makeRequestHandler over the real seedBoard().
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;

const ROOT = path.resolve(__dirname, "..");
const KANBAN = path.join(ROOT, "fittings/seed/kanban-loop");
const home = mkdtempSync(path.join(tmpdir(), "gateway-registration-home-"));
const boardRoot = mkdtempSync(path.join(tmpdir(), "gateway-registration-board-"));
const runsRoot = mkdtempSync(path.join(tmpdir(), "gateway-registration-runs-"));

process.env.GARRISON_HOME = home;
process.env.GARRISON_KANBAN_DIR = boardRoot;
process.env.GARRISON_RUNS_DIR = runsRoot;
process.env.GARRISON_POLICY_PATH = "/nonexistent/gateway-registration-policy.json";

let boardServer: http.Server;
let gatewayServer: http.Server;
let boardBase = "";
let gatewayChatPosts = 0;
let createAutonomousCard: (args: Record<string, unknown>) => Promise<{ id: string; url: string } | null>;
let BOARD_LIST_IDS: string[] = [];

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

async function card(id: string) {
  return (await (await fetch(`${boardBase}/cards/${id}`)).json()).card;
}

// Register through the real door and report where the card ended up. `null`
// means createAutonomousCard gave up — the gateway's caller then falls through
// to an inline turn, and whatever card it managed to create is orphaned.
async function register(opts: Record<string, unknown>) {
  const registered = await createAutonomousCard({
    message: "Implement a full feature with tests",
    classification: { taskType: "code", tier: "T2-deep" },
    opts: { project: "demo", ...opts },
    buildPayload,
    logFn: () => {}
  });
  return { registered, landedOn: registered ? (await card(registered.id)).list : null };
}

beforeAll(async () => {
  __kanbanState = await setupKanbanState();
  mkdirSync(path.join(boardRoot, "cards"), { recursive: true });

  // A gateway stub that counts turns, so "registration never opens a turn"
  // stays observable here even though the drive itself is gone.
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

  // The board the fitting actually installs — no fixture edits. The previous
  // version of this file rewrote a `plan` list's validNext to reach Done; there
  // is no `plan` list to rewrite any more, and that line is what turned this
  // suite's collection error into "Cannot set properties of undefined".
  const board = seedBoard();
  BOARD_LIST_IDS = board.lists.map((list: { id: string }) => list.id);
  await saveBoard(board, boardRoot);

  boardServer = http.createServer(
    makeRequestHandler({ root: boardRoot, cwd: boardRoot, gatewayUrl, cap: 5 }, path.join(KANBAN, "dist"))
  );
  boardBase = `http://127.0.0.1:${await listen(boardServer)}`;
  mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
  writeFileSync(
    path.join(home, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: boardBase, port: Number(new URL(boardBase).port) })
  );
}, 40_000);

afterAll(async () => {
  await close(boardServer);
  await close(gatewayServer);
  await __kanbanState?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(boardRoot, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
});

describe.sequential("gateway registration lands on the real board", () => {
  it("the board under test is the five-column one, with no pipeline lists left", () => {
    expect(BOARD_LIST_IDS).toEqual(["todo", "running", "needs-attention", "scheduled", "done"]);
  });

  it("registration never opens a model turn — the board does not drive any more", async () => {
    const before = gatewayChatPosts;
    await register({ targetList: "todo" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gatewayChatPosts).toBe(before);
  });

  it("a registration onto a real column succeeds and reports the card", async () => {
    const { registered, landedOn } = await register({ targetList: "todo" });
    expect(registered?.id).toBeTruthy();
    expect(landedOn).toBe("todo");
  });

  // The bug these pinned (every lane targeting a deleted list; one orphan per
  // attempt) is fixed at both ends: the lanes land on To do, and a move that
  // still cannot land withdraws the card it created — a caller passing an
  // unknown list gets null and a clean board, never a silent inline downgrade
  // WITH a stranded card.
  it("an unknown target list fails CLEAN — null result, no stranded card", async () => {
    const countCards = async () => ((await (await fetch(`${boardBase}/cards`)).json()).cards ?? []).length;
    const before = await countCards();

    const { registered } = await register({ targetList: "plan" });

    expect(registered).toBeNull();
    expect(
      await countCards(),
      "the create half is withdrawn when the move cannot land — no orphan per attempt"
    ).toBe(before);
  });
});
