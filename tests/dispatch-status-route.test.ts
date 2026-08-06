import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as status } from "@/app/api/dispatch/status/route";
import { dispatchRunKey } from "@/lib/dispatch-evidence";

let root: string;
let board: string;
let priorHome: string | undefined;
let priorBoard: string | undefined;
const CARD = "01KY000000000000000000001";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "dispatch-status-route-"));
  board = path.join(root, "board");
  priorHome = process.env.GARRISON_HOME;
  priorBoard = process.env.GARRISON_KANBAN_DIR;
  process.env.GARRISON_HOME = root;
  process.env.GARRISON_KANBAN_DIR = board;
  mkdirSync(path.join(board, "cards", CARD, "dispatch", "runs", dispatchRunKey("run-one")), { recursive: true });
  writeFileSync(path.join(root, "outpost-registry.json"), JSON.stringify([
    { name: "studio", token: "test-token", registeredAt: new Date().toISOString(), pending: false }
  ]));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorBoard === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = priorBoard;
  rmSync(root, { recursive: true, force: true });
});

function putCard(rev: number, claimRevision: number) {
  writeFileSync(path.join(board, "cards", CARD, "card.json"), JSON.stringify({
    id: CARD,
    title: "remote phase",
    list: "implement",
    project: null,
    rev,
    placement: { target: "studio" },
    sequence: ["implement", "review", "done"],
    level: 2,
    dispatch: {
      machine: "studio",
      workerId: "worker-one",
      runId: "run-one",
      routingToken: "route-one",
      phase: "implement",
      logIndex: 1,
      claimedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      state: "running",
      claimRevision
    }
  }));
}

function evidence(name: string, content: string) {
  writeFileSync(path.join(board, "cards", CARD, "dispatch", "runs", dispatchRunKey("run-one"), name), content, { mode: 0o600 });
  return {
    name,
    bytes: Buffer.byteLength(content),
    sha256: crypto.createHash("sha256").update(content).digest("hex")
  };
}

function request(manifest: unknown[] = []) {
  return new Request("http://localhost/api/dispatch/status", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({
      cardId: CARD,
      workerId: "worker-one",
      runId: "run-one",
      routingToken: "route-one",
      phase: "implement",
      state: "done",
      requestedTransition: "review",
      evidenceManifest: manifest
    })
  }) as any;
}

describe("dispatch completion authority", () => {
  it("stops completion after revision drift outside tracked heartbeats", async () => {
    putCard(8, 7);
    const response = await status(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ stop: true });
  });

  it("rejects a correctly hashed gate that does not authorize the requested transition", async () => {
    putCard(7, 7);
    const transcript = evidence("transcript.md", "phase transcript\n");
    const gate = evidence("gate-status.implement.json", JSON.stringify({ status: "passed", next_phase: "done" }));
    const response = await status(request([transcript, gate]));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not review/);
  });
});
