// The escalation loop end to end, over HTTP, through the real server child
// process: recurring escalations in a composition's decision log become a review
// -queue proposal, and approving it PUTs the pins edit at the shell's policy API
// — not a markdown append with a `PUT /routing` label on it, which is what the
// apply path did before.
//
// The shell is a stub HTTP server here. That is the point of the test: the
// contract between the Improver and the shell (GET config+baselineSha, PUT
// {composition, baseline, config}) is asserted from the outside, on the wire.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO_ROOT, "fittings", "seed", "improver", "scripts", "server.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("improver server did not become healthy");
}

async function api(port: number, method: string, p: string, body?: any) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

const FLOWS = {
  fix: {
    defaultLevel: 1,
    levels: {
      "1": { duties: ["implement", "test"] },
      "2": { duties: ["implement", "test", "review"] },
    },
  },
};

describe("escalation proposals apply through the shell's policy API", () => {
  let proc: ChildProcess | undefined;
  let shell: http.Server;
  let tmp: string;
  let compositionDir: string;
  let port: number;
  let shellPort: number;
  // What the stub shell currently holds, and what it was asked to write.
  let stored: any;
  let baselineSha = "sha-1";
  const puts: any[] = [];
  let nextPutStatus: number | null = null;

  beforeAll(async () => {
    port = await freePort();
    shellPort = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-improver-flow-"));
    compositionDir = path.join(tmp, "default");
    fs.mkdirSync(path.join(compositionDir, ".garrison"), { recursive: true });
    const data = path.join(tmp, "improver-data");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(tmp, "MEMORY.md"), "- [a](a.md) — hook\n", "utf8");
    fs.writeFileSync(path.join(tmp, "target.md"), "# notes\n", "utf8");

    // Three identical applied escalations: the default threshold is 3.
    const rows = [1, 2, 3].map((n) =>
      JSON.stringify({
        kind: "escalation",
        applied: true,
        flow: "fix",
        flowLevel: 1,
        duty: "review",
        to: 2,
        reason: "touched auth",
        cardId: `0${n}J`,
        at: `2026-08-1${n}T09:00:00.000Z`,
      })
    );
    fs.writeFileSync(path.join(compositionDir, ".garrison", "decisions.jsonl"), rows.join("\n") + "\n");
    fs.writeFileSync(path.join(compositionDir, ".garrison", "routing.json"), JSON.stringify({ flows: FLOWS }));

    stored = { flows: structuredClone(FLOWS) };
    shell = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/api/orchestrator/policy") {
        res.writeHead(404).end("{}");
        return;
      }
      if (req.method === "GET") {
        const body = JSON.stringify({ composition: url.searchParams.get("composition"), config: stored, baselineSha });
        res.writeHead(200, { "content-type": "application/json" }).end(body);
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw || "{}");
        puts.push(parsed);
        if (nextPutStatus === 422) {
          nextPutStatus = null;
          res.writeHead(422, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "invalid-config", errors: ["flows.fix.levels.1.pins.review: not a known duty"] }));
          return;
        }
        if (parsed.baseline !== baselineSha) {
          res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "conflict", currentSha: baselineSha }));
          return;
        }
        stored = parsed.config;
        baselineSha = "sha-2";
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, baselineSha }));
      });
    });
    await new Promise<void>((r) => shell.listen(shellPort, "127.0.0.1", r));

    proc = spawn("node", [SERVER], {
      env: {
        ...process.env,
        IMPROVER_PORT: String(port),
        IMPROVER_HOST: "127.0.0.1",
        IMPROVER_DATA: data,
        IMPROVER_MEMORY: path.join(tmp, "MEMORY.md"),
        IMPROVER_TARGET: path.join(tmp, "target.md"),
        GARRISON_HOME: tmp,
        GARRISON_COMPOSITION_DIR: compositionDir,
        GARRISON_APP_URL: `http://127.0.0.1:${shellPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitHealth(port);
  }, 30_000);

  afterAll(async () => {
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => shell.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("run-now queues both readings of the recurring escalation, pending", async () => {
    await api(port, "POST", "/api/run-now");
    const q = await api(port, "GET", "/api/queue");
    const esc = q.json.queue.filter((p: any) => p.rule === "escalation");
    expect(esc).toHaveLength(2);
    expect(esc.every((p: any) => p.status === "pending")).toBe(true);
    const pin = esc.find((p: any) => p.id.startsWith("escalation-pin-"));
    // The machine-readable edit has to survive enqueue, or apply would be left
    // re-parsing the claim text.
    expect(pin.pinEdit).toEqual({ flow: "fix", flowLevel: "1", duty: "review", level: 2 });
    expect(pin.appliable).toBe(true);
  }, 30_000);

  it("the split reading is manual-only and the server refuses to apply it", async () => {
    const q = await api(port, "GET", "/api/queue");
    const split = q.json.queue.find((p: any) => p.id.startsWith("escalation-split-"));
    expect(split.appliable).toBe(false);
    const res = await api(port, "POST", `/api/proposals/${encodeURIComponent(split.id)}/apply`);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("not-appliable");
    // and it did NOT fall through to the markdown-append default
    expect(fs.readFileSync(path.join(tmp, "target.md"), "utf8")).not.toContain(split.id);
  });

  it("a 422 from the shell is a hard reject carrying the reason", async () => {
    const q = await api(port, "GET", "/api/queue");
    const pin = q.json.queue.find((p: any) => p.id.startsWith("escalation-pin-"));
    nextPutStatus = 422;
    const res = await api(port, "POST", `/api/proposals/${encodeURIComponent(pin.id)}/apply`);
    expect(res.status).toBe(422);
    expect(res.json.reason).toContain("not a known duty");
    const after = await api(port, "GET", "/api/queue");
    const entry = after.json.queue.find((p: any) => p.id === pin.id);
    expect(entry.status).toBe("rejected");
    expect(entry.rejectionReason).toContain("not a known duty");
  });

  it("approving the pin PUTs the edit into the live routing config", async () => {
    // Re-run to bring the rejected proposal back as a fresh pending one, the way
    // the nightly pass would after the config was fixed.
    const q0 = await api(port, "GET", "/api/queue");
    const pinId = q0.json.queue.find((p: any) => p.id.startsWith("escalation-pin-")).id;
    // Drop the rejected entry so the rule can re-enqueue it (enqueue is
    // idempotent by id and deliberately never resurrects a resolved proposal).
    const queueFile = path.join(tmp, "improver-data", "review-queue.json");
    const queue = JSON.parse(fs.readFileSync(queueFile, "utf8")).filter((p: any) => p.id !== pinId);
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
    await api(port, "POST", "/api/run-now");

    const before = puts.length;
    const res = await api(port, "POST", `/api/proposals/${encodeURIComponent(pinId)}/apply`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(puts.length).toBe(before + 1);
    const put = puts[puts.length - 1];
    expect(put.composition).toBe("default");
    expect(put.config.flows.fix.levels["1"].pins).toEqual({ review: 2 });
    // The stub shell's document really changed — the pin is live config now, not
    // a note about a pin.
    expect(stored.flows.fix.levels["1"].pins).toEqual({ review: 2 });
    // and the markdown target was never touched by this apply
    expect(fs.readFileSync(path.join(tmp, "target.md"), "utf8")).not.toContain(pinId);

    const q = await api(port, "GET", "/api/queue");
    const entry = q.json.queue.find((p: any) => p.id === pinId);
    expect(entry.status).toBe("applied");
    expect(entry.evidence.targetFile).toContain("routing.json");
  }, 30_000);
});

describe("the Signals API over HTTP", () => {
  let proc: ChildProcess | undefined;
  let tmp: string;
  let port: number;
  let queueFile: string;

  beforeAll(async () => {
    port = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-improver-signals-"));
    const data = path.join(tmp, "improver");
    fs.mkdirSync(data, { recursive: true });
    queueFile = path.join(data, "feedback-queue.jsonl");
    fs.writeFileSync(
      queueFile,
      [
        JSON.stringify({ id: "fq-000000001-aaaaaaaa", provenance: "override", answer: "full pipeline", applied: { plan: "full", flow: "fix" }, timestamp: "2026-08-13T09:00:00.000Z" }),
        JSON.stringify({ provenance: "probe", question: "How did that go?", answer: "Needed rework", classification: { kind: "fix", tier: null, plan: null }, timestamp: "2026-08-13T10:00:00.000Z" }),
      ].join("\n") + "\n"
    );
    fs.writeFileSync(path.join(data, "probe-pending-s1.json"), JSON.stringify({ id: "p-9", session_id: "s1", mode: "probe", askedAt: "2026-08-13T11:00:00.000Z", questions: [{ area: "went-well", question: "How did that go?", options: ["Went well", "Needed rework"] }] }));

    proc = spawn("node", [SERVER], {
      env: { ...process.env, IMPROVER_PORT: String(port), IMPROVER_HOST: "127.0.0.1", IMPROVER_DATA: data, GARRISON_HOME: tmp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitHealth(port);
  }, 20_000);

  afterAll(() => {
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lists every record newest-first with what it feeds, plus the pending question", async () => {
    const res = await api(port, "GET", "/api/signals");
    expect(res.status).toBe(200);
    expect(res.json.signals).toHaveLength(2);
    expect(res.json.signals[0].answer).toBe("Needed rework"); // newest first
    expect(res.json.signals[0].feedsRule.category).toBe("poor");
    expect(res.json.signals[1].feedsRule.category).toBe("deeper");
    expect(res.json.pendingProbes[0].id).toBe("p-9");
    // Delivered only through the relay, so the view can say nobody may see it.
    expect(res.json.pendingProbes[0].deliveredVia).toBeNull();
  });

  it("DELETE appends a tombstone and the record stops being counted", async () => {
    const before = await api(port, "GET", "/api/signals");
    const target = before.json.signals.find((s: any) => s.answer === "full pipeline");
    const del = await api(port, "DELETE", `/api/signals/${encodeURIComponent(target.key)}`, { reason: "test noise" });
    expect(del.status).toBe(200);
    const after = await api(port, "GET", "/api/signals");
    const row = after.json.signals.find((s: any) => s.key === target.key);
    expect(row.tombstoned).toBe(true);
    expect(row.tombstoneReason).toBe("test noise");
    expect(after.json.counts.live).toBe(1);
    // append-only: the original line is untouched on disk
    const lines = fs.readFileSync(queueFile, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).kind).toBe("tombstone");
  });

  it("deleting something that is not there is a 404, not a silent tombstone", async () => {
    const res = await api(port, "DELETE", "/api/signals/fq-000000000-ffffffff");
    expect(res.status).toBe(404);
  });

  it("an out-of-band answer is recorded through the GET route a notification button uses", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/probe/p-9/answer?question=0&answer=${encodeURIComponent("Needed rework")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const lines = fs.readFileSync(queueFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const answer = lines[lines.length - 1];
    expect(answer).toMatchObject({ session_id: "s1", answer: "Needed rework", provenance: "probe", delivered_via: "out-of-band" });
    // the pending is gone, so a second tap records nothing
    const again = await fetch(`http://127.0.0.1:${port}/api/probe/p-9/answer?question=0&answer=x`);
    expect(again.status).toBe(404);
  });
});
