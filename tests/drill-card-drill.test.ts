// Card-driven drill: the engine behind Kanban's "Send to Drill" button.
//
// Three layers, each pinned where it can actually be proven:
//   1. the PURE decisions — which pages a card's drill runs, and what verdict a
//      finished run earns. Getting these wrong is silent: a drill that quietly
//      widens to the whole Book, or one that reports a broken test harness as
//      "your change is broken".
//   2. the NOTIFICATION fan-out — every means attempted independently, each
//      reporting delivered / skipped-with-a-reason. A notification that went
//      nowhere while claiming success is the one failure that makes the whole
//      feature untrustworthy.
//   3. the LIVE chain — a real Drill server driving plan → scope → run → notify
//      against a stub plan agent, a fake kanban and a fake web channel. The run
//      itself terminates on a missing engine (no automations in a hermetic
//      sandbox), which is exactly the "could not finish" path that MUST still
//      notify — the layer-1 tests cover the passed/failed verdicts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const REPO = resolve(HERE, "..");
const DRILL_START = join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");

// @ts-ignore — pure ESM .mjs
import { changedPageIds, resolveRunScope, planNeedsAttentionError, verdictOf, outcomeFrom, reapOrphanCardDrills } from "../fittings/seed/drill/lib/card-drill.mjs";
// @ts-ignore
import { outcomeText, summarizeReceipts, broadcastOutcome } from "../fittings/seed/drill/lib/broadcast.mjs";

// ── 1. pure decisions ────────────────────────────────────────────────────────

describe("run scope — what a card's drill actually runs", () => {
  it("detects the pages the plan added or rewrote", () => {
    const before = new Map([["chat", "1:10"], ["kb", "2:20"]]);
    const after = new Map([["chat", "9:11"], ["kb", "2:20"], ["settings", "3:30"]]);
    expect(changedPageIds(before, after)).toEqual(["chat", "settings"]);
  });

  it("runs ONLY the pages the plan touched — the whole point of a card-scoped drill", () => {
    const book = { pages: [{ id: "chat", selected: true }, { id: "kb", selected: true }, { id: "settings", selected: true }] };
    expect(resolveRunScope({ changed: ["settings"], book, allPageIds: ["chat", "kb", "settings"] }))
      .toEqual({ pageIds: ["settings"], scope: "changed-pages" });
  });

  it("falls back to the Book's own selection when the plan changed nothing", () => {
    // "already covered" is a real answer: the change is inside pages the Book
    // already checks. Running nothing would hand back a verdict proving nothing.
    const book = { pages: [{ id: "chat", selected: true }, { id: "kb", selected: false }] };
    expect(resolveRunScope({ changed: [], book, allPageIds: ["chat", "kb"] }))
      .toEqual({ pageIds: ["chat"], scope: "book-selection" });
  });

  it("falls back to every page when the Book has no selection at all", () => {
    expect(resolveRunScope({ changed: [], book: { pages: [] }, allPageIds: ["chat"] }))
      .toEqual({ pageIds: ["chat"], scope: "all-pages" });
  });

  it("stops an autonomous card run when planning required integrity repairs", () => {
    expect(planNeedsAttentionError({ needsAttention: false })).toBeNull();
    expect(planNeedsAttentionError({ needsAttention: true, warnings: ["quarantined", "restored"] }))
      .toBe("planning finished with integrity warnings (2); review the Drill Book before running it");
  });
});

describe("verdict — what the notification actually claims", () => {
  it("passes a run with no failures and no findings", () => {
    expect(verdictOf({ summary: { failed: 0 }, findings: [] })).toBe("passed");
  });

  it("fails a run with a failed check", () => {
    expect(verdictOf({ summary: { failed: 2 }, findings: [] })).toBe("failed");
  });

  it("fails a run that produced findings even when the summary counted none", () => {
    expect(verdictOf({ summary: { failed: 0 }, findings: [{ id: "f1" }] })).toBe("failed");
  });

  it("never rounds an unproven check up to a pass", () => {
    // Caught on the first LIVE run: 11 passed, 1 unproven, reported as
    // "Every check passed". `unproven` is the engine's "I could not tell either
    // way" — folding it into a pass makes the notification claim the change was
    // verified when part of it was not.
    expect(verdictOf({ summary: { failed: 0, unproven: 1 }, findings: [] })).toBe("partial");
    expect(verdictOf({ summary: { failed: 0, unproven: 0 }, findings: [] })).toBe("passed");
    // A real failure still outranks an unproven check.
    expect(verdictOf({ summary: { failed: 1, unproven: 2 }, findings: [] })).toBe("failed");
  });

  it("names the unproven checks instead of implying the change is verified", () => {
    const outcome = outcomeFrom({
      id: "01RUN",
      summary: { failed: 0, unproven: 1 },
      executedChecks: 12,
      findings: [],
      pages: [
        { pageId: "home", stepId: "hero-copy", terminal: { kind: "pass" } },
        { pageId: "home", stepId: "hero-cta-opens-info", terminal: { kind: "unproven" } }
      ]
    });
    expect(outcome.state).toBe("partial");
    expect(outcome.headline).toContain("could not be proven either way");
    expect(outcome.headline).toContain("home#hero-cta-opens-info");
    expect(outcome.headline).toContain("not fully verified");
    expect(outcome.headline).not.toContain("Every check");
  });

  it("never reports a broken harness as a broken product", () => {
    // A circuit means the test rig fell over. Calling that "your change is
    // broken" sends you debugging code that was never exercised.
    expect(verdictOf({ summary: { failed: 0 }, findings: [], circuit: { message: "automations fitting not running" } })).toBe("error");
    expect(verdictOf({ canceled: { at: "now" } })).toBe("error");
    expect(verdictOf(null)).toBe("error");
  });

  it("leads a failing outcome with the actual findings, not a bare count", () => {
    const outcome = outcomeFrom({
      id: "01RUN",
      summary: { failed: 1 },
      executedChecks: 12,
      pages: [{ pageId: "chat" }, { pageId: "chat" }],
      findings: [{ pageId: "chat", stepId: "send", text: "the composer stays disabled after send" }]
    });
    expect(outcome.state).toBe("failed");
    expect(outcome.headline).toContain("the composer stays disabled after send");
    expect(outcome.checks).toBe(12);
    expect(outcome.pages).toBe(1);
    expect(outcome.findings).toBe(1);
  });

  it("says a passing card-scoped drill only proved the pages it ran", () => {
    const outcome = outcomeFrom({ id: "01RUN", summary: { failed: 0 }, findings: [], executedChecks: 4, pages: [{ pageId: "chat" }] }, { scope: "changed-pages" });
    expect(outcome.state).toBe("passed");
    expect(outcome.headline).toContain("pages this card changed");
  });
});

describe("outcomeText — the message every means renders", () => {
  it("never announces a partial result as a pass", () => {
    const text = outcomeText({
      card: { id: "01CARD", title: "Site copy" },
      outcome: { state: "partial", findings: 0, checks: 12, failed: 0, unproven: 1, headline: "Nothing failed, but 1 check could not be proven either way." },
      links: {}
    });
    expect(text).toContain("Drill passed what it could prove");
    expect(text).not.toMatch(/^Drill passed —/);
    expect(text).toContain("1 unproven");
  });

  it("carries the verdict, the numbers, and the links", () => {
    const text = outcomeText({
      card: { id: "01CARD", title: "Turn Rail badges" },
      outcome: { state: "failed", findings: 2, checks: 12, failed: 2, headline: "- chat#send: broken" },
      links: { run: "http://box:8096/?view=results&run=01RUN", card: "http://box:8089/#/cards/01CARD" }
    });
    expect(text).toContain("Drill found 2 issues — Turn Rail badges");
    expect(text).toContain("- chat#send: broken");
    expect(text).toContain("12 checks");
    expect(text).toContain("?view=results&run=01RUN");
    expect(text).toContain("#/cards/01CARD");
  });
});

describe("summarizeReceipts", () => {
  it("names what got through AND what did not", () => {
    const line = summarizeReceipts([
      { means: "web-channel", ok: true },
      { means: "kanban-card", ok: true },
      { means: "slack", ok: false, skipped: "slack connector is not connected" },
      { means: "webhook", ok: false, error: "HTTP 500" }
    ]);
    expect(line).toContain("notified via web-channel, kanban-card");
    expect(line).toContain("slack (slack connector is not connected)");
    expect(line).toContain("webhook (HTTP 500)");
  });

  it("says so plainly when nothing was delivered", () => {
    expect(summarizeReceipts([{ means: "web-channel", ok: false, skipped: "down" }])).toContain("notified via nothing");
  });
});

// ── 2. the notification fan-out ──────────────────────────────────────────────

describe("broadcastOutcome — every means, independently", () => {
  const home = mkdtempSync(join(tmpdir(), "drill-bcast-home-"));
  const savedHome = process.env.GARRISON_HOME;
  const savedWebhook = process.env.GARRISON_DRILL_NOTIFY_WEBHOOK;
  const savedChannel = process.env.GARRISON_DRILL_NOTIFY_SLACK_CHANNEL;
  const savedBase = process.env.GARRISON_BASE_URL;

  beforeAll(() => {
    process.env.GARRISON_HOME = home;
    mkdirSync(join(home, "ui-fittings"), { recursive: true });
    writeFileSync(join(home, "ui-fittings", "web-channel-default.json"), JSON.stringify({ url: "http://web.test" }));
    writeFileSync(join(home, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: "http://board.test" }));
    delete process.env.GARRISON_DRILL_NOTIFY_WEBHOOK;
    delete process.env.GARRISON_DRILL_NOTIFY_SLACK_CHANNEL;
    delete process.env.GARRISON_BASE_URL;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.GARRISON_HOME; else process.env.GARRISON_HOME = savedHome;
    if (savedWebhook === undefined) delete process.env.GARRISON_DRILL_NOTIFY_WEBHOOK; else process.env.GARRISON_DRILL_NOTIFY_WEBHOOK = savedWebhook;
    if (savedChannel === undefined) delete process.env.GARRISON_DRILL_NOTIFY_SLACK_CHANNEL; else process.env.GARRISON_DRILL_NOTIFY_SLACK_CHANNEL = savedChannel;
    if (savedBase === undefined) delete process.env.GARRISON_BASE_URL; else process.env.GARRISON_BASE_URL = savedBase;
    rmSync(home, { recursive: true, force: true });
  });

  function recorder() {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = async (u: string, init: any = {}) => {
      calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    };
    return { calls, fetchImpl };
  }

  it("delivers to the web channel and the card, and names the means it cannot use", async () => {
    const { calls, fetchImpl } = recorder();
    const receipts = await broadcastOutcome({
      card: { id: "01CARD", title: "Turn Rail badges" },
      outcome: { state: "passed", findings: 0, checks: 4 },
      links: { run: "http://box/run" },
      jobId: "01JOB",
      fetchImpl
    });
    const by = Object.fromEntries(receipts.map((r: any) => [r.means, r]));
    expect(by["web-channel"].ok).toBe(true);
    expect(by["kanban-card"].ok).toBe(true);
    // Unconfigured means are SKIPPED WITH A REASON, never a silent no-op.
    expect(by.slack.ok).toBe(false);
    expect(by.slack.skipped).toMatch(/notify_slack_channel/);
    expect(by.webhook.skipped).toMatch(/notify_webhook/);

    const board = calls.find((c) => c.url.includes("/drill-result"));
    expect(board?.url).toContain("/cards/01CARD/drill-result");
    expect(board?.body.state).toBe("passed");
    expect(board?.body.jobId).toBe("01JOB");
    const thread = calls.find((c) => c.url.includes("/messages"));
    expect(thread?.url).toContain("/api/threads/drill-reports/messages");
    expect(thread?.body.messages[0].text).toContain("Drill passed");
  });

  it("answers in the thread that ASKED for the work when the card came from one", async () => {
    const { calls, fetchImpl } = recorder();
    await broadcastOutcome({
      card: { id: "01CARD", title: "t", originChannel: { channel: "web", threadId: "thr-42" } },
      outcome: { state: "failed", findings: 1 },
      fetchImpl
    });
    expect(calls.some((c) => c.url.includes("/api/threads/thr-42/messages"))).toBe(true);
    // An existing thread is never re-created (that would clobber its routing).
    expect(calls.some((c) => c.url.endsWith("/api/threads"))).toBe(false);
  });

  it("posts to a configured webhook with both prose and structured fields", async () => {
    process.env.GARRISON_DRILL_NOTIFY_WEBHOOK = "https://ntfy.test/garrison";
    try {
      const { calls, fetchImpl } = recorder();
      const receipts = await broadcastOutcome({
        card: { id: "01CARD", title: "Turn Rail badges" },
        outcome: { state: "failed", findings: 2, runId: "01RUN" },
        fetchImpl
      });
      expect(receipts.find((r: any) => r.means === "webhook").ok).toBe(true);
      const hook = calls.find((c) => c.url === "https://ntfy.test/garrison");
      expect(hook?.body.event).toBe("card-drill-finished");
      expect(hook?.body.state).toBe("failed");
      expect(hook?.body.cardId).toBe("01CARD");
      expect(hook?.body.runId).toBe("01RUN");
      expect(hook?.body.text).toContain("Drill found 2 issues");
    } finally {
      delete process.env.GARRISON_DRILL_NOTIFY_WEBHOOK;
    }
  });

  it("keeps delivering when one means throws", async () => {
    const fetchImpl = async (u: string, init: any = {}) => {
      if (u.includes("web-channel") || u.includes("web.test")) throw new Error("connection refused");
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    };
    const receipts = await broadcastOutcome({
      card: { id: "01CARD", title: "t" },
      outcome: { state: "passed", findings: 0 },
      fetchImpl: fetchImpl as any
    });
    const by = Object.fromEntries(receipts.map((r: any) => [r.means, r]));
    expect(by["web-channel"].ok).toBe(false);
    expect(by["web-channel"].error).toContain("connection refused");
    expect(by["kanban-card"].ok).toBe(true); // the dead channel cost nobody else
  });
});

describe("reapOrphanCardDrills — a restart must not wedge a card at 'planning'", () => {
  const home = mkdtempSync(join(tmpdir(), "drill-reap-home-"));
  const savedHome = process.env.GARRISON_HOME;
  const savedDrillHome = process.env.GARRISON_DRILL_HOME;

  beforeAll(() => {
    process.env.GARRISON_HOME = home;
    process.env.GARRISON_DRILL_HOME = join(home, "drill");
    mkdirSync(join(home, "drill", "card-drills"), { recursive: true });
    mkdirSync(join(home, "ui-fittings"), { recursive: true });
    writeFileSync(join(home, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: "http://board.test" }));
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.GARRISON_HOME; else process.env.GARRISON_HOME = savedHome;
    if (savedDrillHome === undefined) delete process.env.GARRISON_DRILL_HOME; else process.env.GARRISON_DRILL_HOME = savedDrillHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("closes an in-flight job left by a dead process and tells the card", async () => {
    const dir = join(home, "drill", "card-drills");
    writeFileSync(join(dir, "01ORPHAN.json"), JSON.stringify({ id: "01ORPHAN", state: "running", card: { id: "01CARDO" }, startedAt: "2026-07-29T10:00:00.000Z" }));
    writeFileSync(join(dir, "01DONE.json"), JSON.stringify({ id: "01DONE", state: "passed", card: { id: "01CARDD" }, startedAt: "2026-07-29T09:00:00.000Z" }));

    const posts: any[] = [];
    const fetchImpl = async (u: string, init: any = {}) => {
      posts.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    };
    const closed = await reapOrphanCardDrills({ fetchImpl });
    expect(closed).toEqual(["01ORPHAN"]); // the already-terminal job is left alone

    const rec = JSON.parse(await readFile(join(dir, "01ORPHAN.json"), "utf8"));
    expect(rec.state).toBe("error");
    expect(rec.error).toMatch(/restarted/);
    // The card hears about it — otherwise the board sits at "planning" forever.
    expect(posts.some((p) => p.url.includes("/cards/01CARDO/drill-result") && p.body.state === "error")).toBe(true);
  });
});

// ── 3. the live chain ────────────────────────────────────────────────────────

describe("POST /api/card-drill — plan, scope, run, notify", () => {
  const ghome = mkdtempSync(join(tmpdir(), "drill-carddrill-home-"));
  const target = mkdtempSync(join(tmpdir(), "drill-carddrill-target-"));
  const bin = mkdtempSync(join(tmpdir(), "drill-carddrill-bin-"));
  let drillSrv: ChildProcess | null = null;
  let fakeKanban: http.Server | null = null;
  let fakeWeb: http.Server | null = null;
  let drillBase = "";
  const drillResults: any[] = [];
  const webMessages: any[] = [];

  async function listen(s: http.Server): Promise<number> {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as any).port;
  }

  function collect(req: http.IncomingMessage): Promise<any> {
    return new Promise((res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        res(raw ? JSON.parse(raw) : {});
      });
    });
  }

  beforeAll(async () => {
    // A stub plan agent: authors one page file (so the plan is BACKED by a real
    // change under drills/, which the planner verifies) and prints the sentinel.
    // Standing in for `claude` keeps the chain hermetic without faking the
    // planner's own contract.
    const stub = join(bin, "stub-plan.sh");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "mkdir -p drills/pages",
        "cat > drills/pages/stubpage.yml <<'YML'",
        "id: stubpage",
        "title: Stub page",
        "path: /stub",
        "mode: steps",
        "areas: []",
        "steps:",
        "  - id: renders",
        "    area: 0",
        "    mode: vision",
        "    enabled: true",
        "    viewports: [desktop]",
        "    state: default",
        "    description: the stub page renders",
        "    tags: []",
        "    judgment: false",
        "YML",
        "echo DRILL_PLAN_OK=1"
      ].join("\n")
    );
    chmodSync(stub, 0o755);

    fakeKanban = http.createServer(async (req, res) => {
      const m = req.url?.match(/^\/cards\/([^/]+)\/drill-result$/);
      if (m && req.method === "POST") {
        drillResults.push({ cardId: m[1], body: await collect(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: m[1] } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const kanbanPort = await listen(fakeKanban);

    fakeWeb = http.createServer(async (req, res) => {
      if (req.url?.includes("/messages") && req.method === "POST") {
        webMessages.push({ url: req.url, body: await collect(req) });
      } else {
        await collect(req);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const webPort = await listen(fakeWeb);

    mkdirSync(join(ghome, "ui-fittings"), { recursive: true });
    writeFileSync(join(ghome, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${kanbanPort}` }));
    writeFileSync(join(ghome, "ui-fittings", "web-channel-default.json"), JSON.stringify({ url: `http://127.0.0.1:${webPort}` }));

    const port = 7191; // unique across the suite - 7241 is drill-gate.test.ts's
    drillBase = `http://127.0.0.1:${port}`;
    drillSrv = spawn("node", [DRILL_START], {
      stdio: "ignore",
      env: {
        ...process.env,
        GARRISON_HOME: ghome,
        GARRISON_DRILL_TARGET_REPO: target,
        DRILL_UI_PORT: String(port),
        DRILL_UI_HOST: "127.0.0.1",
        DRILL_AGENT_CMD: stub,
        DRILL_CARD_POLL_MS: "200",
        // No Garrison shell + no automations status file: the run terminates on
        // a missing engine, which is the "could not finish" path this asserts
        // still notifies.
        GARRISON_BASE_URL: "",
        GARRISON_AUTOMATIONS_URL: ""
      }
    });
    const end = Date.now() + 10000;
    let up = false;
    while (Date.now() < end && !up) {
      try { up = (await fetch(`${drillBase}/health`)).ok; } catch { /* not up */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    expect(up).toBe(true);
  }, 30000);

  afterAll(async () => {
    if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
    await new Promise((r) => fakeKanban?.close(() => r(undefined)));
    await new Promise((r) => fakeWeb?.close(() => r(undefined)));
    for (const d of [ghome, target, bin]) rmSync(d, { recursive: true, force: true });
  });

  it("400s without a brief — Drill cannot scope a plan to a change it was not told about", async () => {
    const res = await fetch(`${drillBase}/api/card-drill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: { id: "01CARDX", project: target } })
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/brief/);
  });

  it("400s without a card id", async () => {
    const res = await fetch(`${drillBase}/api/card-drill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "something changed" })
    });
    expect(res.status).toBe(400);
  });

  it("plans the change, scopes the run to the pages the plan touched, and notifies when it ends", async () => {
    const res = await fetch(`${drillBase}/api/card-drill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        card: { id: "01CARDX", title: "Stub change", project: target },
        brief: "The stub page gained a heading.",
        project: target,
        boardUrl: "http://board.test"
      })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { job, started } = await res.json();
    expect(started).toBe(true);
    expect(job.state).toBe("planning");
    // The brief is a prompt, not payload — it never rides the wire back.
    expect(job.brief).toBeUndefined();
    expect(job.briefChars).toBeGreaterThan(0);

    // Poll to terminal.
    const end = Date.now() + 60000;
    let finalJob: any = null;
    while (Date.now() < end) {
      const j = await (await fetch(`${drillBase}/api/card-drill/${job.id}`)).json();
      finalJob = j.job;
      if (["passed", "failed", "error"].includes(finalJob.state)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(["passed", "failed", "error"]).toContain(finalJob.state);

    // The plan agent authored a page, so the run was scoped to exactly that page.
    expect(finalJob.scope).toBe("changed-pages");
    expect(finalJob.pageIds).toEqual(["stubpage"]);
    expect(finalJob.runId).toBeTruthy();
    // Hermetic sandbox: no automations engine, so the run cannot complete — and
    // that must surface as a harness failure, never as a product verdict.
    expect(finalJob.state).toBe("error");

    // …and it still told everyone. Both live means delivered.
    const receipts = Object.fromEntries((finalJob.notified ?? []).map((r: any) => [r.means, r]));
    expect(receipts["kanban-card"].ok).toBe(true);
    expect(receipts["web-channel"].ok).toBe(true);

    expect(drillResults.some((r) => r.cardId === "01CARDX" && r.body.state === "error")).toBe(true);
    expect(webMessages.some((m) => String(m.body?.messages?.[0]?.text).includes("Drill could not finish"))).toBe(true);

    // The job record is durable — a restart or a second device can still read it.
    const durable = JSON.parse(await readFile(join(ghome, "drill", "card-drills", `${job.id}.json`), "utf8"));
    expect(durable.state).toBe("error");
    expect(durable.card.id).toBe("01CARDX");
  }, 90000);

  it("lists a card's jobs", async () => {
    const { jobs } = await (await fetch(`${drillBase}/api/card-drill?cardId=01CARDX`)).json();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0].card.id).toBe("01CARDX");
  });

  it("404s an unknown job", async () => {
    expect((await fetch(`${drillBase}/api/card-drill/01NOSUCHJOB`)).status).toBe(404);
  });
});
