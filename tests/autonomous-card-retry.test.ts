// rev-s2 residual — a COMMITTED regression test for the createAutonomousCard
// rev-race retry (finding #1): the move-to-Plan 409s on a stale rev (project
// inference bumps it right after create); the retry re-fetches the rev and
// succeeds; exhaustion returns null (never a false "registered" success).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");

// A scripted mock board: POST /cards returns rev 0; the on-disk rev is
// already 1 (the inference bump); PATCH with a stale rev → 409; GET returns
// the fresh rev; PATCH with the fresh rev → 200.
function mockBoard(opts: { always409?: boolean } = {}) {
  let diskRev = 1; // inference already bumped it
  let list = "backlog";
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/cards") {
      return send(201, { card: { id: "01MOCKCARD0000000000000000", rev: 0 } });
    }
    if (req.method === "GET" && req.url?.startsWith("/cards/")) {
      return send(200, { card: { id: "01MOCKCARD0000000000000000", rev: diskRev, list } });
    }
    if (req.method === "PATCH" && req.url?.startsWith("/cards/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (opts.always409 || body.rev !== diskRev) return send(409, { error: "card changed under you" });
        diskRev += 1;
        list = body.list;
        return send(200, { card: { id: "01MOCKCARD0000000000000000", rev: diskRev, list } });
      });
      return;
    }
    send(404, { error: "nope" });
  });
  return { server, calls, getList: () => list };
}

async function makeRouter(boardUrl: string, garrisonHome: string) {
  // Point the status-file discovery at a sandbox home carrying the mock board.
  process.env.GARRISON_HOME = garrisonHome;
  mkdirSync(path.join(garrisonHome, "ui-fittings"), { recursive: true });
  writeFileSync(
    path.join(garrisonHome, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: boardUrl, port: 0 })
  );
  const mod = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs")).href
  );
  // Minimal RoutedGateway-shaped receiver: createAutonomousCard only touches
  // this.core + this.logFn, so borrow the prototype method.
  const core = await import(pathToFileURL(path.join(ROOT, "fittings/seed/orchestrator/lib/routing-core.mjs")).href);
  const logs: unknown[] = [];
  const self = { core, logFn: (e: unknown) => logs.push(e) };
  const fn = mod.RoutedGateway.prototype.createAutonomousCard.bind(self);
  return { fn, logs };
}

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "gh-"));
});
afterAll(() => {
  delete process.env.GARRISON_HOME;
});

describe("createAutonomousCard rev-race retry (rev-s2 finding #1)", () => {
  it("retries the move with a re-fetched rev and lands the card in plan", async () => {
    const board = mockBoard();
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const { fn } = await makeRouter(`http://127.0.0.1:${addr.port}`, home);
    const out = await fn("build X", { taskType: "code", tier: "T1-standard" }, {});
    expect(out).not.toBeNull();
    expect(out.id).toBe("01MOCKCARD0000000000000000");
    expect(board.getList()).toBe("plan"); // the retry moved it
    board.server.close();
  });

  it("returns null on exhaustion — never a false success", async () => {
    const board = mockBoard({ always409: true });
    await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
    const addr = board.server.address() as { port: number };
    const { fn, logs } = await makeRouter(`http://127.0.0.1:${addr.port}`, home);
    const out = await fn("build X", { taskType: "code", tier: "T1-standard" }, {});
    expect(out).toBeNull();
    expect(JSON.stringify(logs)).toContain("autonomous-card-failed");
    board.server.close();
  });
});
