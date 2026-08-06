import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as uploadEvidence } from "@/app/api/dispatch/evidence/route";
import { dispatchRunKey } from "@/lib/dispatch-evidence";

let root: string;
let board: string;
let priorHome: string | undefined;
let priorBoard: string | undefined;
const CARD = "01KY000000000000000000001";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "dispatch-evidence-route-"));
  board = path.join(root, "board");
  priorHome = process.env.GARRISON_HOME;
  priorBoard = process.env.GARRISON_KANBAN_DIR;
  process.env.GARRISON_HOME = root;
  process.env.GARRISON_KANBAN_DIR = board;
  mkdirSync(path.join(board, "cards", CARD), { recursive: true });
  writeFileSync(path.join(root, "outpost-registry.json"), JSON.stringify([
    { name: "studio", token: "test-token", registeredAt: new Date().toISOString(), pending: false }
  ]));
  writeFileSync(path.join(board, "cards", CARD, "card.json"), JSON.stringify({
    id: CARD,
    title: "remote evidence",
    list: "implement",
    rev: 1,
    placement: { target: "studio" },
    dispatch: {
      machine: "studio",
      workerId: "worker-one",
      runId: "run-one",
      routingToken: "route-one",
      phase: "implement",
      claimedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      state: "running"
    }
  }));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorBoard === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = priorBoard;
  rmSync(root, { recursive: true, force: true });
});

function request(runId: string, name = "transcript.md", content = "evidence\n") {
  return new Request("http://localhost/api/dispatch/evidence", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({
      cardId: CARD,
      workerId: "worker-one",
      runId,
      name,
      contentBase64: Buffer.from(content).toString("base64")
    })
  }) as any;
}

describe("dispatch evidence upload isolation", () => {
  it("writes only inside the active run's immutable evidence bundle", async () => {
    const response = await uploadEvidence(request("run-one"));
    expect(response.status).toBe(200);
    const target = path.join(board, "cards", CARD, "dispatch", "runs", dispatchRunKey("run-one"), "transcript.md");
    expect(readFileSync(target, "utf8")).toBe("evidence\n");
    expect(existsSync(path.join(board, "cards", CARD, "dispatch", "transcript.md"))).toBe(false);
  });

  it("cannot upload a retry artifact under another run identity", async () => {
    const response = await uploadEvidence(request("old-run"));
    expect(response.status).toBe(409);
    expect(existsSync(path.join(board, "cards", CARD, "dispatch", "runs", dispatchRunKey("old-run"), "transcript.md"))).toBe(false);
  });
});
