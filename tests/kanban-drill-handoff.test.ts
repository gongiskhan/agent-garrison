// Kanban → Drill handoff: the "Send to Drill" button on a done card.
//
// Two halves, both pinned here:
//   - the PURE brief/eligibility rules (composeChangeBrief, drillEligibility) —
//     the brief is a prompt for Drill's plan agent, so what it carries and what
//     it drops is behaviour, not formatting; and
//   - the REAL board server's POST /cards/:id/drill and /drill-result, against a
//     fake Drill fitting discovered through the status-file URL contract.
//
// The failure this guards against is the quiet one: a button that reports
// success while nothing was ever handed over, or a handoff whose brief is so
// thin the plan agent widens back to the whole Book.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "drillho-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "drillho-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "drillho-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure ESM .mjs, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard, loadCard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore
import { composeChangeBrief, drillEligibility } from "../fittings/seed/kanban-loop/lib/drill-handoff.mjs";

let server: http.Server;
let base = "";
let fakeDrill: http.Server;
let drillBase = "";
let handoffs: any[] = [];
let drillStatusFile = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as any).port;
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve2) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve2(raw ? JSON.parse(raw) : {});
    });
  });
}

/** A done card with the full close-out shape a real run leaves behind. */
async function makeDoneCard(extra: Record<string, unknown> = {}) {
  const card = await createCard(KANBAN_DIR, {
    title: "Turn Rail badges",
    description: "Show runtime/model badges on every web-channel turn.",
    project: "/home/user/dev/garrison",
    list: "backlog"
  });
  const next = {
    ...card,
    list: "done",
    lastReply: "Badges render on every turn; overrides apply per turn.",
    fences: [{ phase: "code", sha: "abcdef1234567890", at: new Date().toISOString() }],
    ...extra
  };
  const res = await saveCardCAS(KANBAN_DIR, next, card.rev ?? 0);
  expect(res.ok).toBe(true);
  return res.card;
}

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);

  // The fake Drill fitting: records every handoff and answers like the real
  // POST /api/card-drill (a registered job, started).
  fakeDrill = http.createServer(async (req, res) => {
    if (req.url === "/api/card-drill" && req.method === "POST") {
      const body = await readJson(req);
      handoffs.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ job: { id: "01JOBDRILL", state: "planning" }, started: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  drillBase = `http://127.0.0.1:${await listen(fakeDrill)}`;

  // Discovery goes through the URL-link contract, never a baked port.
  mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
  drillStatusFile = join(GARRISON_HOME, "ui-fittings", "drill.json");
  writeFileSync(drillStatusFile, JSON.stringify({ fittingId: "drill", url: drillBase }));

  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR }));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(() => r(undefined)));
  await new Promise((r) => fakeDrill?.close(() => r(undefined)));
  for (const d of [KANBAN_DIR, GARRISON_HOME, RUNS_DIR]) rmSync(d, { recursive: true, force: true });
});

describe("composeChangeBrief — the change description Drill's plan agent reads", () => {
  it("carries the ask, the close-out, the decisions, the files, and the commits", () => {
    const brief = composeChangeBrief(
      {
        id: "01CARD",
        title: "Turn Rail badges",
        description: "Show runtime/model badges on every web-channel turn.",
        fences: [{ phase: "code", sha: "abcdef1234567890" }]
      },
      {
        completionSummary: "Badges render on every turn.",
        keyDecisions: ["route the override through the gateway, not the client"],
        filesTouched: ["fittings/seed/web-channel-default/ui/main.tsx"]
      }
    );
    expect(brief).toContain("Turn Rail badges");
    expect(brief).toContain("Show runtime/model badges");
    expect(brief).toContain("Badges render on every turn.");
    expect(brief).toContain("route the override through the gateway");
    expect(brief).toContain("fittings/seed/web-channel-default/ui/main.tsx");
    expect(brief).toContain("abcdef1234"); // short sha
    // The scoping instruction is the whole reason the run stays about this card.
    expect(brief).toContain("Scope the Book update to THIS change");
  });

  it("degrades to the card's own fields when there is no handoff packet", () => {
    const brief = composeChangeBrief({ id: "01CARD", title: "Fix the picker", lastReply: "Picker no longer resets." });
    expect(brief).toContain("Fix the picker");
    expect(brief).toContain("Picker no longer resets.");
  });

  it("bounds a pathological description so it cannot drown the instruction", () => {
    const brief = composeChangeBrief({ id: "01CARD", title: "t", description: "x".repeat(50000) });
    expect(brief.length).toBeLessThan(4000);
    expect(brief).toContain("Scope the Book update to THIS change");
  });
});

describe("drillEligibility", () => {
  it("accepts a done card with a project", () => {
    expect(drillEligibility({ list: "done", project: "/repo" })).toEqual({ ok: true });
  });
  it("rejects a card that has not landed", () => {
    expect(drillEligibility({ list: "code", project: "/repo" }).ok).toBe(false);
  });
  it("rejects a done card with no project to test in", () => {
    expect(drillEligibility({ list: "done", project: null }).ok).toBe(false);
  });
});

describe("POST /cards/:id/drill", () => {
  it("hands the card's change to Drill and stamps the card", async () => {
    handoffs = [];
    const card = await makeDoneCard();
    const res = await fetch(`${base}/cards/${card.id}/drill`, { method: "POST" });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(true);
    expect(body.card.drill.state).toBe("planning");
    expect(body.card.drill.jobId).toBe("01JOBDRILL");

    // Drill got a real brief scoped to this card's repo.
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].card.id).toBe(card.id);
    expect(handoffs[0].project).toBe("/home/user/dev/garrison");
    expect(handoffs[0].brief).toContain("Turn Rail badges");
    expect(handoffs[0].brief).toContain("Badges render on every turn");

    // …and the card carries the dispatch durably, with a visible event.
    const onDisk = await loadCard(KANBAN_DIR, card.id);
    expect(onDisk.drill.state).toBe("planning");
    expect(onDisk.events.some((e: any) => e.message.startsWith("Sent to Drill"))).toBe(true);
  });

  it("refuses a card that has not reached done", async () => {
    handoffs = [];
    const card = await createCard(KANBAN_DIR, { title: "mid-flight", project: "/repo", list: "code" });
    const res = await fetch(`${base}/cards/${card.id}/drill`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/done/);
    expect(handoffs).toHaveLength(0); // nothing was handed over
  });

  it("refuses a done card with no project", async () => {
    const card = await makeDoneCard({ project: null });
    const res = await fetch(`${base}/cards/${card.id}/drill`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/project/);
  });

  it("404s an unknown card", async () => {
    const res = await fetch(`${base}/cards/01HZX5K3QABCDEFGHJKMNPQRS0/drill`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("reports a down Drill fitting on the CARD, not just in the response", async () => {
    const card = await makeDoneCard();
    const saved = drillStatusFile;
    rmSync(saved, { force: true });
    try {
      const res = await fetch(`${base}/cards/${card.id}/drill`, { method: "POST" });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/not running/);
      // The user pressed a button and walked away — the board has to show the miss.
      const onDisk = await loadCard(KANBAN_DIR, card.id);
      expect(onDisk.drill.state).toBe("error");
      expect(onDisk.events.some((e: any) => e.message.startsWith("Send to Drill failed"))).toBe(true);
    } finally {
      writeFileSync(saved, JSON.stringify({ fittingId: "drill", url: drillBase }));
      expect(existsSync(saved)).toBe(true);
    }
  });
});

describe("POST /cards/:id/drill-result — Drill's completion callback", () => {
  it("stamps a passing verdict and an event", async () => {
    const card = await makeDoneCard();
    await fetch(`${base}/cards/${card.id}/drill`, { method: "POST" });
    const res = await fetch(`${base}/cards/${card.id}/drill-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "01JOBDRILL", state: "passed", runId: "01RUN", runUrl: "http://127.0.0.1:9/?view=results&run=01RUN", checks: 12, findings: 0 })
    });
    expect(res.status).toBe(200);
    const { card: updated } = await res.json();
    expect(updated.drill.state).toBe("passed");
    expect(updated.drill.runId).toBe("01RUN");
    expect(updated.drill.checks).toBe(12);
    const onDisk = await loadCard(KANBAN_DIR, card.id);
    expect(onDisk.events.some((e: any) => e.message === "Drill passed — every check on this change's pages passed")).toBe(true);
  });

  it("stamps a failing verdict with the finding count", async () => {
    const card = await makeDoneCard();
    const res = await fetch(`${base}/cards/${card.id}/drill-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "failed", findings: 3, failed: 2, headline: "- chat#send: the composer stays disabled" })
    });
    expect(res.status).toBe(200);
    const onDisk = await loadCard(KANBAN_DIR, card.id);
    expect(onDisk.drill.state).toBe("failed");
    expect(onDisk.drill.findings).toBe(3);
    const ev = onDisk.events.find((e: any) => e.message.includes("Drill found 3 issues"));
    expect(ev).toBeTruthy();
    expect(ev.detail).toContain("the composer stays disabled");
  });

  it("rejects a state it does not understand", async () => {
    const card = await makeDoneCard();
    const res = await fetch(`${base}/cards/${card.id}/drill-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "probably-fine" })
    });
    expect(res.status).toBe(400);
  });
});
