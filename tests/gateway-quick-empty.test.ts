// S1b (D19, RUN_SPEC assumption 2) — the QUICK path must reject empty output.
//
// A quick card runs inline in the gateway and, before this fix, `completeQuickCard`
// advanced ANY reply that didn't start with "[operative error]" straight to Done —
// so an EMPTY reply lied its way to Done. Now an empty reply is routed to
// needs-attention with the failure contract; only a real reply reaches Done.
//
// The gateway decision is `isEmptyQuickReply(reply) ? parkQuickCard : completeQuickCard`
// (identical in gateway.mjs completeQuickTurnCard and gateway-pty.mjs). These tests
// pin the predicate (which branch) and the two board-client outcomes (where each
// branch lands + the contract copy it carries), against a sandboxed stub board.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");

// A stub board that records the FULL body of every PATCH (list + parkedFrom +
// attentionReason + whether the engine header was present) so a test can assert
// exactly what the gateway sent.
function stubBoard() {
  const state = { rev: 0, list: "implement" };
  const patches: { list: string; parkedFrom?: string; attentionReason?: string; engine: boolean }[] = [];
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url?.startsWith("/cards/")) {
      return send(200, { card: { id: "01STUBCARD00000000000000AA", rev: state.rev, list: state.list } });
    }
    if (req.method === "PATCH" && req.url?.startsWith("/cards/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        patches.push({
          list: body.list,
          parkedFrom: body.parkedFrom,
          attentionReason: body.attentionReason,
          engine: typeof req.headers["x-garrison-engine"] === "string"
        });
        state.list = body.list;
        state.rev += 1;
        send(200, { card: { id: "01STUBCARD00000000000000AA", rev: state.rev, list: state.list } });
      });
      return;
    }
    send(404, { error: "nope" });
  });
  return { server, patches, state };
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
  const gw: any = Object.create(mod.RoutedGateway.prototype);
  gw.logFn = () => {};
  gw._sessionCards = new Map();
  return gw;
}

async function cardsMod() {
  return import(pathToFileURL(path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/autonomous-cards.mjs")).href);
}

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "gw-quick-empty-"));
});
afterAll(() => {
  delete process.env.GARRISON_HOME;
});

describe("isEmptyQuickReply — the branch predicate that selects park-vs-complete", () => {
  it("empty and whitespace-only replies are empty; a real reply is not", async () => {
    const { isEmptyQuickReply } = await cardsMod();
    expect(isEmptyQuickReply("")).toBe(true);
    expect(isEmptyQuickReply("   \n\t")).toBe(true);
    expect(isEmptyQuickReply(null)).toBe(true);
    expect(isEmptyQuickReply(undefined)).toBe(true);
    expect(isEmptyQuickReply("renamed the variable")).toBe(false);
  });

  it("quickEmptyFailureReason never claims success and routes to needs-attention", async () => {
    const { quickEmptyFailureReason } = await cardsMod();
    const r: string = quickEmptyFailureReason();
    expect(r.toLowerCase()).not.toMatch(/\bcompleted\b|\bsuccess\b|\bdone\b/);
    expect(r).toMatch(/FAILURE, not a pass/);
    expect(r).toMatch(/needs-attention/);
    expect(r).toMatch(/no output/);
  });
});

describe("quick-card completion — empty → needs-attention, real → Done (S1b/D19)", () => {
  it("parkQuickCard routes the card to needs-attention (engine-context) carrying the failure contract", async () => {
    const board = stubBoard();
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);
    const { quickEmptyFailureReason } = await cardsMod();

    const ok = await gw.parkQuickCard("01STUBCARD00000000000000AA", quickEmptyFailureReason());
    expect(ok).toBe(true);
    expect(board.state.list).toBe("needs-attention"); // NOT done
    const last = board.patches[board.patches.length - 1];
    expect(last.list).toBe("needs-attention");
    expect(last.engine).toBe(true);
    expect(last.parkedFrom).toBe("implement");
    expect(last.attentionReason).toMatch(/FAILURE, not a pass/);
    board.server.close();
  });

  it("a real (non-empty) reply still advances the quick card to Done", async () => {
    const board = stubBoard();
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const gw = await makeGateway(`http://127.0.0.1:${addr.port}`, home);

    const ok = await gw.completeQuickCard("01STUBCARD00000000000000AA");
    expect(ok).toBe(true);
    expect(board.state.list).toBe("done");
    expect(board.patches[board.patches.length - 1].list).toBe("done");
    board.server.close();
  });
});
