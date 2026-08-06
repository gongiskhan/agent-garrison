import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatchRunKey, verifyDispatchGate, verifyEvidenceManifest } from "@/lib/dispatch-evidence";

let root: string;
let prior: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "dispatch-evidence-"));
  prior = process.env.GARRISON_KANBAN_DIR;
  process.env.GARRISON_KANBAN_DIR = root;
});

afterEach(() => {
  if (prior === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

function put(cardId: string, runId: string, name: string, content: string) {
  const dir = path.join(root, "cards", cardId, "dispatch", "runs", dispatchRunKey(runId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content, { mode: 0o600 });
  return {
    name,
    bytes: Buffer.byteLength(content),
    sha256: crypto.createHash("sha256").update(content).digest("hex")
  };
}

describe("host-authoritative Outpost gate evidence", () => {
  it("rejects a correctly hashed gate whose verdict does not match the requested edge", async () => {
    const cardId = "CARD";
    const runId = "run-one";
    const name = "gate-status.implement.json";
    const entry = put(cardId, runId, name, JSON.stringify({ status: "passed", next_phase: "done" }));
    await expect(verifyEvidenceManifest(cardId, runId, [entry], [name])).resolves.toEqual([entry]);
    await expect(verifyDispatchGate(cardId, runId, "implement", "review")).rejects.toThrow(/not review/);
  });

  it("rejects failed gate content even when its bytes and transition match", async () => {
    const cardId = "CARD";
    const runId = "run-one";
    put(cardId, runId, "gate-status.implement.json", JSON.stringify({ status: "failed", next_phase: "review" }));
    await expect(verifyDispatchGate(cardId, runId, "implement", "review")).rejects.toThrow(/passed\/success/);
  });

  it("accepts only passed/success with the exact next phase", async () => {
    const cardId = "CARD";
    const runId = "run-one";
    put(cardId, runId, "gate-status.implement.json", JSON.stringify({ status: "success", next_phase: "review" }));
    await expect(verifyDispatchGate(cardId, runId, "implement", "review")).resolves.toEqual({
      status: "success",
      nextPhase: "review"
    });
  });

  it("never accepts a prior run's same-named gate for a retry", async () => {
    const cardId = "CARD";
    const name = "gate-status.implement.json";
    const old = put(cardId, "old-run", name, JSON.stringify({ status: "passed", next_phase: "review" }));
    await expect(verifyEvidenceManifest(cardId, "new-run", [old], [name])).rejects.toThrow(/not present/);
    await expect(verifyDispatchGate(cardId, "new-run", "implement", "review")).rejects.toThrow(/not valid JSON/);
  });
});
