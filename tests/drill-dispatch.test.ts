import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// R10: dispatch pools confirmed findings into ONE batch fix card via
// kanban-loop's POST /cards. A lightweight fake stands in for kanban-loop
// (spinning up the real fitting is unnecessary for proving Drill calls the
// right endpoint with the right body) — the "kanban-loop not running" 502
// path is already covered in drill-run-e2e.test.ts.

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const DRILL_PORT = 7203;
const FAKE_KANBAN_PORT = 7204;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-dispatch-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-dispatch-target-"));

let drillSrv: ChildProcess | null = null;
let fakeKanban: http.Server | null = null;
let receivedBody: any = null;
let receivedBodies: any[] = [];
let receivedMoves: any[] = [];

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
    if (req.url === "/cards" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        receivedBodies.push(receivedBody);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: `01FAKECARD${receivedBodies.length}`, rev: 0, list: "backlog", ...receivedBody } }));
      });
      return;
    }
    const move = req.url?.match(/^\/cards\/([^/]+)$/);
    if (move && req.method === "PATCH") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        receivedMoves.push({
          id: decodeURIComponent(move[1]),
          url: req.url,
          body,
          engine: req.headers["x-garrison-engine"],
          engineHeader: req.headers["x-garrison-engine"] ?? null,
          dispatch: req.headers["x-garrison-dispatch"]
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: decodeURIComponent(move[1]), rev: body.rev + 1, list: body.list } }));
      });
      return;
    }
    res.writeHead(404); res.end();
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
  // These tests exercise dispatch/heartbeat, not the A5/R7 gate — run immediately.
  await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: "auto" }) });
}, 20000);

afterAll(async () => {
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => fakeKanban?.close(() => r(undefined)));
  drillSrv = null; fakeKanban = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("dispatch: one batch fix card carrying the report", () => {
  it("posts exactly ONE card to kanban-loop, body describing every confirmed finding", async () => {
    // Build a run record with two confirmed findings and one dismissed one,
    // via the ordinary run + override + triage endpoints so this exercises
    // the real code path end to end.
    await fetch(`${DRILL_BASE}/api/pages/chat`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Chat", path: "/chat" }) });

    const runRes = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["chat"], viewports: ["desktop"] })
    });
    const runId = (await runRes.json()).run.id;

    const obsRes = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "citation mapping looked off" })
    });
    const { observation } = await obsRes.json();
    const findingRes = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation/${observation.id}/convert-finding`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "chat" })
    });
    const { finding: f1 } = await findingRes.json();

    const obsRes2 = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "focus ring contrast" })
    });
    const { observation: obs2 } = await obsRes2.json();
    const findingRes2 = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation/${obs2.id}/convert-finding`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "chat" })
    });
    const { finding: f2 } = await findingRes2.json();

    await fetch(`${DRILL_BASE}/api/runs/${runId}/findings/${f1.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
    await fetch(`${DRILL_BASE}/api/runs/${runId}/findings/${f2.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "dismissed" }) });

    const dispatchRes = await fetch(`${DRILL_BASE}/api/runs/${runId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    });
    expect(dispatchRes.status).toBe(200);
    const dispatchJson = await dispatchRes.json();
    expect(dispatchJson.dispatched).toBe(true);
    expect(dispatchJson.card.id).toMatch(/^01FAKECARD/);

    expect(receivedBody.description).toContain("citation mapping looked off");
    expect(receivedBody.description).not.toContain("focus ring contrast"); // dismissed finding excluded
    expect(receivedBody.description).toContain(runId);
    expect(receivedBody.origin).toBe("drill");

    // Human-scannable title: page ids + finding count + a date, never the ulid alone.
    expect(receivedBody.title).toMatch(/^Drill fix: chat - 1 finding \(/);

    // The dispatch entered the card at its first phase with an engine move so
    // the loop actually runs it (a backlog-only card reads as "went nowhere").
    expect(receivedMoves.length).toBeGreaterThan(0);
    const move = receivedMoves[receivedMoves.length - 1];
    expect(move.engineHeader).toBe("drill-dispatch");
    expect(move.body.list).toBe("code");
    expect(receivedBody.sequence).toEqual(["code"]);
    expect(move).toMatchObject({
      id: dispatchJson.card.id,
      body: { list: "code", rev: 0 },
      engine: "drill-dispatch",
      dispatch: "auto"
    });

    expect(dispatchJson.card.entered).toBe(true);
    expect(dispatchJson.run.dispatchedAt).toBeTruthy();
    expect(dispatchJson.run.dispatchedCard).toEqual({ id: dispatchJson.card.id, list: "code" });

    const cardsAfterDispatch = receivedBodies.length;
    const duplicate = await fetch(`${DRILL_BASE}/api/runs/${runId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toContain(dispatchJson.card.id);
    expect(receivedBodies.length).toBe(cardsAfterDispatch);
  }, 20000);

  it("dispatch is idempotent: re-dispatch 409s, and a later-confirmed finding goes out alone", async () => {
    await fetch(`${DRILL_BASE}/api/pages/idem`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Idem", path: "/idem" }) });
    const runRes = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["idem"], viewports: ["desktop"] })
    });
    const runId = (await runRes.json()).run.id;

    const mkConfirmed = async (text: string) => {
      const { observation } = await (await fetch(`${DRILL_BASE}/api/runs/${runId}/observation`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text })
      })).json();
      const { finding } = await (await fetch(`${DRILL_BASE}/api/runs/${runId}/observation/${observation.id}/convert-finding`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "idem" })
      })).json();
      await fetch(`${DRILL_BASE}/api/runs/${runId}/findings/${finding.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" })
      });
      return finding;
    };

    const first = await mkConfirmed("first defect");
    const d1 = await (await fetch(`${DRILL_BASE}/api/runs/${runId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    })).json();
    expect(d1.dispatched).toBe(true);
    expect(d1.card.url).toContain(`/#/cards/${d1.card.id}`);
    // The finding now carries its card stamp in the run view.
    const stamped = d1.run.findings.find((f: any) => f.id === first.id);
    expect(stamped.card.id).toBe(d1.card.id);

    // Double-click / re-dispatch: nothing new -> an explicit conflict naming
    // the existing card, and NO extra card hits the board.
    const cardsBefore = receivedBodies.length;
    const again = await fetch(`${DRILL_BASE}/api/runs/${runId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    });
    expect(again.status).toBe(409);
    const againError = (await again.json()).error;
    expect(againError).toContain("already on a fix card");
    expect(againError).toContain(d1.card.id);
    expect(receivedBodies.length).toBe(cardsBefore);

    // A finding confirmed AFTER the dispatch goes out alone on the next one.
    await mkConfirmed("second defect");
    const d2 = await (await fetch(`${DRILL_BASE}/api/runs/${runId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    })).json();
    expect(d2.dispatched).toBe(true);
    const lastBody = receivedBodies[receivedBodies.length - 1];
    expect(lastBody.description).toContain("second defect");
    expect(lastBody.description).not.toContain("first defect");
  }, 30000);
});

describe("heartbeat dispatch pickup — no button (D10/S29, self-test item 7)", () => {
  it("a run created with dispatch:heartbeat, once its finding is confirmed, gets picked up by a sweep with NO call to /dispatch", async () => {
    await fetch(`${DRILL_BASE}/api/pages/kb`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "KB", path: "/kb" }) });
    await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispatch: "heartbeat" }) });

    const runRes = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["kb"], viewports: ["desktop"] })
    });
    const { run } = await runRes.json();
    expect(run.dispatch).toBe("heartbeat"); // inherited from the Drill Book default, no explicit dispatch param given

    const obsRes = await fetch(`${DRILL_BASE}/api/runs/${run.id}/observation`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "kb entry stale" })
    });
    const { observation } = await obsRes.json();
    const findingRes = await fetch(`${DRILL_BASE}/api/runs/${run.id}/observation/${observation.id}/convert-finding`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "kb" })
    });
    const { finding } = await findingRes.json();
    await fetch(`${DRILL_BASE}/api/runs/${run.id}/findings/${finding.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });

    const cardsBefore = receivedBodies.length;
    const sweepRes = await fetch(`${DRILL_BASE}/api/heartbeat/run-once`, { method: "POST" });
    expect(sweepRes.status).toBe(200);
    const { results } = await sweepRes.json();
    expect(results.some((r: any) => r.runId === run.id && r.dispatched)).toBe(true);
    expect(receivedBodies.length).toBe(cardsBefore + 1); // the sweep itself created the card — /dispatch was never called

    // Re-sweeping does not double-dispatch the same run.
    const secondSweep = await (await fetch(`${DRILL_BASE}/api/heartbeat/run-once`, { method: "POST" })).json();
    expect(secondSweep.results.some((r: any) => r.runId === run.id)).toBe(false);
    expect(receivedBodies.length).toBe(cardsBefore + 1);
  }, 20000);

  it("a manual-mode run is never picked up by the heartbeat sweep", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispatch: "manual" }) });
    const runRes = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["kb"], viewports: ["desktop"] })
    });
    const { run } = await runRes.json();
    expect(run.dispatch).toBe("manual");
    const obsRes = await fetch(`${DRILL_BASE}/api/runs/${run.id}/observation`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" })
    });
    const { observation } = await obsRes.json();
    const { finding } = await (
      await fetch(`${DRILL_BASE}/api/runs/${run.id}/observation/${observation.id}/convert-finding`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "kb" }) })
    ).json();
    await fetch(`${DRILL_BASE}/api/runs/${run.id}/findings/${finding.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });

    const sweep = await (await fetch(`${DRILL_BASE}/api/heartbeat/run-once`, { method: "POST" })).json();
    expect(sweep.results.some((r: any) => r.runId === run.id)).toBe(false);
  }, 20000);

  it("persists a Results-view heartbeat choice so the next sweep can pick it up", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dispatch: "manual" }) });
    const runRes = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["kb"], viewports: ["desktop"] })
    });
    const { run } = await runRes.json();
    expect(run.dispatch).toBe("manual");

    const obsRes = await fetch(`${DRILL_BASE}/api/runs/${run.id}/observation`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "queue this finding later" })
    });
    const { observation } = await obsRes.json();
    const { finding } = await (
      await fetch(`${DRILL_BASE}/api/runs/${run.id}/observation/${observation.id}/convert-finding`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "kb" })
      })
    ).json();
    await fetch(`${DRILL_BASE}/api/runs/${run.id}/findings/${finding.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" })
    });

    const queuedRes = await fetch(`${DRILL_BASE}/api/runs/${run.id}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "heartbeat" })
    });
    expect(queuedRes.status).toBe(200);
    const queued = await queuedRes.json();
    expect(queued.dispatched).toBe(false);
    expect(queued.run.dispatch).toBe("heartbeat");

    const cardsBefore = receivedBodies.length;
    const sweep = await (await fetch(`${DRILL_BASE}/api/heartbeat/run-once`, { method: "POST" })).json();
    expect(sweep.results.some((result: any) => result.runId === run.id && result.dispatched)).toBe(true);
    expect(receivedBodies.length).toBe(cardsBefore + 1);

    const stored = await (await fetch(`${DRILL_BASE}/api/runs/${run.id}`)).json();
    expect(stored.run.dispatchedAt).toBeTruthy();
    expect(stored.run.dispatchedCard?.id).toMatch(/^01FAKECARD/);
  }, 20000);
});
