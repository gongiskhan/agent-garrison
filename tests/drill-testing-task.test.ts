import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// R14/S27 — testing-only task: a card carrying a drill block, entering the
// roster directly at "drill". A fake kanban-loop stands in (accepts any
// PATCH to a list name) — Drill's job is to FORM the create+move sequence
// correctly; whether the live board actually has "drill" registered is the
// composition's concern, not this fitting's.

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const DRILL_PORT = 7236;
const FAKE_KANBAN_PORT = 7237;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-testtask-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-testtask-target-"));

let drillSrv: ChildProcess | null = null;
let fakeKanban: http.Server | null = null;
let createdBody: any = null;
let movedBody: any = null;
let movedId: string | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  fakeKanban = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8") ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (req.url === "/cards" && req.method === "POST") {
        createdBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: "01TESTTASK", list: "backlog", rev: 0, ...body } }));
        return;
      }
      const moveMatch = req.url?.match(/^\/cards\/([^/]+)$/);
      if (moveMatch && req.method === "PATCH") {
        movedId = moveMatch[1];
        movedBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: movedId, list: body.list, rev: 1 } }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((resolve) => fakeKanban!.listen(FAKE_KANBAN_PORT, "127.0.0.1", () => resolve()));

  const uiFittingsDir = path.join(ghome, "ui-fittings");
  mkdirSync(uiFittingsDir, { recursive: true });
  writeFileSync(path.join(uiFittingsDir, "kanban-loop.json"), JSON.stringify({ fittingId: "kanban-loop", url: `http://127.0.0.1:${FAKE_KANBAN_PORT}` }));

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "ekoa" } })
  });
}, 20000);

afterAll(async () => {
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => fakeKanban?.close(() => r(undefined)));
  drillSrv = null; fakeKanban = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("POST /api/testing-task (R14)", () => {
  it("creates a card with the drill block, then moves it directly to the drill list", async () => {
    const res = await fetch(`${DRILL_BASE}/api/testing-task`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["chat"], tags: ["regression"], viewports: ["desktop", "mobile"], autonomy: "auto", dispatch: "immediate", description: "Test: KB citations regression" })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { card } = await res.json();
    expect(card.id).toBe("01TESTTASK");
    expect(card.list).toBe("drill");

    expect(createdBody.description).toBe("Test: KB citations regression");
    expect(createdBody.origin).toBe("drill");
    expect(createdBody.drill).toEqual({
      book: "ekoa",
      select: { pages: ["chat"], "steps-or-tags": ["regression"], states: [] },
      viewports: ["desktop", "mobile"],
      autonomy: "auto",
      dispatch: "immediate"
    });

    expect(movedId).toBe("01TESTTASK");
    expect(movedBody.list).toBe("drill");
  });

  it("defaults autonomy/dispatch from the Drill Book, and description from the page list, when not given", async () => {
    const res = await fetch(`${DRILL_BASE}/api/testing-task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["kb"] })
    });
    expect(res.status).toBe(200);
    expect(createdBody.description).toBe("Test: kb");
    expect(createdBody.drill.autonomy).toBe("gated"); // book default
    expect(createdBody.drill.dispatch).toBe("manual"); // book default
  });

  it("400s without pageIds", async () => {
    const res = await fetch(`${DRILL_BASE}/api/testing-task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
  });

  it("502s clearly when kanban-loop is not running", async () => {
    const home2 = mkdtempSync(path.join(tmpdir(), "garrison-testtask-nohome-"));
    const target2 = mkdtempSync(path.join(tmpdir(), "garrison-testtask-notarget-"));
    const port2 = 7238;
    const srv2 = spawn("node", [DRILL_START], {
      stdio: "ignore",
      env: { ...process.env, GARRISON_HOME: home2, GARRISON_DRILL_TARGET_REPO: target2, DRILL_UI_PORT: String(port2), DRILL_UI_HOST: "127.0.0.1" }
    });
    try {
      expect(await waitHealthy(`http://127.0.0.1:${port2}`, 8000)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port2}/api/testing-task`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["chat"] })
      });
      expect(res.status).toBe(502);
    } finally {
      srv2.kill("SIGKILL");
      rmSync(home2, { recursive: true, force: true });
      rmSync(target2, { recursive: true, force: true });
    }
  }, 15000);
});
