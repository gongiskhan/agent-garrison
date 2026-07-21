// Regression for "Kanban fitting view route opening raw JSON": the status file
// kanban-loop writes to ~/.garrison/ui-fittings/kanban-loop.json advertised
// route "/board" for both the top-level route and views[0].route, but GET
// /board is the JSON board API while the visual Workflow Board SPA is served
// at "/". Garrison's board-summary panel builds its "open board" link from
// status.url + status.route (src/lib/board-summary.ts), so the wrong route
// sent users straight to raw JSON. This boots the REAL kanban-loop server
// (the same startServer() path a live composition runs) against a sandboxed
// GARRISON_HOME + kanban dir, and asserts the advertised route resolves to the
// visual board while /board keeps serving JSON, unchanged.
//
// server.mjs computes its status-file path as a top-level const from
// process.env.GARRISON_HOME at module-evaluation time, and static imports are
// hoisted ahead of this file's own top-level statements — so the env var must
// be set, then the module dynamically imported (mirrors the pattern in
// tests/autonomous-card-retry.test.ts / tests/kanban-list-config.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";

const ROOT = path.resolve(__dirname, "..");
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "kvr-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "kvr-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "kvr-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

let handle: { server: http.Server };

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  const { startServer } = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/kanban-loop/scripts/server.mjs")).href
  );
  const { seedBoard } = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/kanban-loop/scripts/kanban.mjs")).href
  );
  const { saveBoard } = await import(
    pathToFileURL(path.join(ROOT, "fittings/seed/kanban-loop/lib/board.mjs")).href
  );
  await saveBoard(seedBoard(), KANBAN_DIR);
  const port = await freePort();
  handle = await startServer({ port, host: "127.0.0.1", root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 });
});

afterAll(async () => {
  await new Promise<void>((r) => handle.server.close(() => r()));
});

describe("kanban-loop status-file view route", () => {
  it('advertises route "/" (the visual board), not the JSON /board API', () => {
    const raw = readFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), "utf8");
    const status = JSON.parse(raw);
    expect(status.route).toBe("/");
    expect(status.views).toEqual([{ id: "board", title: "Kanban", route: "/" }]);
  });

  it("following the advertised route serves the board UI (HTML), while /board still returns JSON", async () => {
    const raw = readFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), "utf8");
    const status = JSON.parse(raw);

    const viewRes = await fetch(status.url + status.route);
    expect(viewRes.status).toBe(200);
    expect(viewRes.headers.get("content-type") ?? "").toContain("text/html");
    const viewBody = await viewRes.text();
    expect(() => JSON.parse(viewBody)).toThrow();

    const boardRes = await fetch(status.url + "/board");
    expect(boardRes.status).toBe(200);
    expect(boardRes.headers.get("content-type") ?? "").toContain("application/json");
    const boardBody = await boardRes.json();
    expect(Array.isArray(boardBody.lists)).toBe(true);
  });
});
