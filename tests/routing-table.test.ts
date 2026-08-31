// Provider-two step 4: per-duty ordered routes. The first entry is the
// default and the router STAYS there - it moves down only on a cooling
// account (a prior rate/usage limit), a missing required capability, or an
// explicit `route: <id>` in the brief. Decisions extend the stretch-routing
// ledger line; a limit-shaped failure cools the account it hit; pins and
// escalations never consult the table.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { pickRoute, applyRouteRow, markCooling, coolingUntil, limitShaped, briefRouteFor, modelFamily, readRoutingTable, routingTableEnabled } from "../fittings/seed/http-gateway/scripts/lib/routing-table.mjs";
// @ts-ignore — pure .mjs
import { runConversation } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

const ROWS = [
  { id: "codex-sub", runtime: "codex", provider: "openai", account: "chatgpt", model: "gpt-5.6-sol", effort: "medium" },
  { id: "anthropic-sub", runtime: "agent-sdk", provider: "anthropic", account: "max", model: "claude-sonnet-5", effort: "medium" },
  { id: "anthropic-api", runtime: "agent-sdk", provider: "anthropic", account: "api", model: "claude-sonnet-5", effort: "medium", paid: true },
];

let tmp: string;
let env: Record<string, string>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "routing-table-"));
  env = { GARRISON_HOME: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pickRoute", () => {
  it("stays on the first entry - the default is the whole point", () => {
    const pick = pickRoute({ rows: ROWS, env })!;
    expect(pick.index).toBe(0);
    expect(pick.reason).toBe("default");
    expect(pick.skipped).toEqual([]);
  });

  it("skips a cooling account and says so", () => {
    markCooling(ROWS[0], 30, { env });
    const pick = pickRoute({ rows: ROWS, env })!;
    expect(pick.index).toBe(1);
    expect(pick.reason).toMatch(/^cooling until /);
    expect(pick.skipped[0].id).toBe("codex-sub");
  });

  it("reaches the paid bottom row when every subscription is cooling", () => {
    markCooling(ROWS[0], 30, { env });
    markCooling(ROWS[1], 30, { env });
    const pick = pickRoute({ rows: ROWS, env })!;
    expect(pick.row.id).toBe("anthropic-api");
    expect(pick.skipped).toHaveLength(2);
  });

  it("returns null when the whole table is cooling - the caller keeps the rung route", () => {
    for (const r of ROWS) markCooling(r, 30, { env });
    expect(pickRoute({ rows: ROWS, env })).toBeNull();
  });

  it("cooling expires", () => {
    markCooling(ROWS[0], 30, { env, now: Date.now() - 31 * 60_000 });
    expect(coolingUntil(ROWS[0], { env })).toBeNull();
    expect(pickRoute({ rows: ROWS, env })!.index).toBe(0);
  });

  it("honours an explicit route directive in the brief", () => {
    const pick = pickRoute({ rows: ROWS, briefText: "do the thing\nroute: anthropic-api\n", env })!;
    expect(pick.row.id).toBe("anthropic-api");
    expect(pick.reason).toBe("brief-route");
  });

  it("skips a row lacking a required capability", () => {
    const rows = [
      { ...ROWS[0], capabilities: ["code"] },
      { ...ROWS[1], capabilities: ["code", "vision"] },
    ];
    const pick = pickRoute({ rows, requiredCapabilities: ["vision"], env })!;
    expect(pick.index).toBe(1);
    expect(pick.skipped[0].reason).toBe("capability:vision");
  });

  it("review prefers another family when the table has one (step 5)", () => {
    const pick = pickRoute({ rows: ROWS, avoidFamily: "gpt", env })!;
    expect(pick.reason).toBe("cross-family");
    expect(modelFamily(pick.row.model)).toBe("claude");
    // Already on another family: stay at the default.
    const stay = pickRoute({ rows: ROWS, avoidFamily: "claude", env })!;
    expect(stay.index).toBe(0);
    expect(stay.reason).toBe("default");
  });
});

describe("limitShaped", () => {
  it("matches real limit shapes and nothing else", () => {
    for (const hit of [
      "codex exec exited 1: You've hit your usage limit",
      "rate_limit_error: Number of requests exceeded",
      "HTTP 429 from provider",
      "quota exhausted for project",
      "overloaded_error",
    ]) {
      expect(limitShaped(hit), hit).toBe(true);
    }
    for (const miss of ["SyntaxError: unexpected token", "auth.json expired", "ECONNREFUSED", "exit 137 oom"]) {
      expect(limitShaped(miss), miss).toBe(false);
    }
  });
});

describe("plumbing", () => {
  it("briefRouteFor reads only a line-anchored directive", () => {
    expect(briefRouteFor("route: codex-sub")).toBe("codex-sub");
    expect(briefRouteFor("the route: is unclear")).toBeNull();
  });

  it("applyRouteRow folds only what the row names", () => {
    const route = { targetId: "t", target: { runtime: "agent-sdk", model: "haiku", effort: "low", skill: "s" } };
    const out = applyRouteRow(route, ROWS[0]);
    expect(out.targetId).toBe("codex-sub");
    expect(out.target.runtime).toBe("codex");
    expect(out.target.model).toBe("gpt-5.6-sol");
    expect(out.target.skill).toBe("s");
    expect(route.target.model).toBe("haiku"); // untouched input
  });

  it("readRoutingTable reads the composition side file and flags garbage", () => {
    const comp = path.join(tmp, "comp", ".garrison");
    mkdirSync(comp, { recursive: true });
    writeFileSync(path.join(comp, "routing-table.json"), JSON.stringify({ cooling_minutes: 5, duties: { implement: ROWS } }));
    const table = readRoutingTable(path.join(tmp, "comp"))!;
    expect(table.coolingMinutes).toBe(5);
    expect(table.duties.implement).toHaveLength(3);
    writeFileSync(path.join(comp, "routing-table.json"), "{nope");
    expect(readRoutingTable(path.join(tmp, "comp"))!.error).toContain("unparseable");
    expect(readRoutingTable(path.join(tmp, "missing"))).toBeNull();
  });

  it("routingTableEnabled is on unless the revert flag turns it off", () => {
    expect(routingTableEnabled({})).toBe(true);
    expect(routingTableEnabled({ GARRISON_HTTPGATEWAY_ROUTING_TABLE: "false" })).toBe(false);
  });
});

describe("the loop consults the table and cools a limited account", () => {
  const CARD = "01M1ROUTINGTABLE0000000001";
  let server: Server | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    mkdirSync(path.join(tmp, "ui-fittings"), { recursive: true });
    prevHome = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = tmp;
  });

  afterEach(() => {
    process.env.GARRISON_HOME = prevHome;
    server?.close();
    server = undefined;
  });

  function startBoard(): Promise<number> {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          card: { id: CARD, rev: 1, title: "t", list: "running", status: "running", conversationId: CARD, autonomous: true },
          checklist: [],
          attachments: [],
        }));
      });
    });
    return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port)));
  }

  function gatewayWith(behaviour: (duty: string) => "ok" | "limit") {
    const LADDER = {
      ladder: "standard",
      rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
      defaultIndex: 0,
      ceilingIndex: 0,
    };
    const compositionDir = path.join(tmp, "comp");
    return {
      compositionDir,
      logFn: () => {},
      _laneQueues: new Map(),
      _onLane(key: string, fn: () => Promise<unknown>) {
        const prev = this._laneQueues.get(key) ?? Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        this._laneQueues.set(key, run.catch(() => {}));
        return run;
      },
      async executionModel() {
        return { version: 3, selectedDuties: ["triage"], duties: {}, dutyLadder: { triage: LADDER } };
      },
      async executionRouteFor({ duty, level }: any) {
        return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
      },
      async runAgentSdkTurn(route: any, b: string) {
        if (behaviour(route.duty) === "limit") throw new Error("rate_limit_error: too many requests");
        const handoffPath = /handoffPath: (.+)/.exec(b)![1].trim();
        const stretchId = /stretchId: (.+)/.exec(b)![1].trim();
        writeFileSync(handoffPath, JSON.stringify({
          v: 1, stretchId, duty: route.duty, status: "complete", summary: "done",
          evidenceRefs: [], nextSteps: { next: "needs-input", why: "w", items: [] },
          blocker: { what: "a look", needs: "user", who: "user" },
          activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false,
        }));
        return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
      },
      async runSecondaryTurn(route: any, _b: string, _opts: any) {
        if (behaviour(route.duty) === "limit") throw new Error("codex exec exited 1: You've hit your usage limit");
        return { reply: "ok", usage: [] };
      },
      async releaseConversationSessions() { return 1; },
    };
  }

  function writeTable() {
    const comp = path.join(tmp, "comp", ".garrison");
    mkdirSync(comp, { recursive: true });
    writeFileSync(path.join(comp, "routing-table.json"), JSON.stringify({ cooling_minutes: 30, duties: { triage: ROWS } }));
  }

  it("routes on the table, logs the reason, and cools the account a limit hit", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    writeTable();
    // Row 0 is codex and the codex lane answers with a usage limit.
    await runConversation(gatewayWith(() => "limit") as never, { conversationId: CARD, task: "go", env });
    // @ts-ignore — pure .mjs
    const { openConversation } = await import("../packages/claude-pty/src/conversation-store.mjs");
    const store = openConversation(CARD, { role: "test", env });
    const routing = store.tail(5, { kinds: ["stretch-routing"] }).map((e: any) => e.payload);
    expect(routing[0].target).toBe("codex-sub");
    expect(routing[0].reason).toBe("default");
    expect(routing[0].runtime).toBe("codex");
    const cooling = store.tail(5, { kinds: ["route-cooling"] }).map((e: any) => e.payload);
    expect(cooling).toHaveLength(1);
    expect(cooling[0].provider).toBe("openai");
    const doc = JSON.parse(readFileSync(path.join(tmp, "routing-cooling.json"), "utf8"));
    expect(doc["openai/chatgpt"]).toBeTruthy();

    // The NEXT conversation walks past the cooling account with the reason on
    // the routing line.
    const second = "01M1ROUTINGTABLE0000000002";
    await runConversation(gatewayWith(() => "ok") as never, { conversationId: second, task: "go again", env });
    const store2 = openConversation(second, { role: "test", env });
    const routed = store2.tail(5, { kinds: ["stretch-routing"] }).map((e: any) => e.payload);
    expect(routed[0].target).toBe("anthropic-sub");
    expect(routed[0].reason).toMatch(/^cooling until /);
    expect(routed[0].table.skipped[0].id).toBe("codex-sub");
  }, 15000);

  it("with the flag off the table is ignored entirely", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    writeTable();
    await runConversation(gatewayWith(() => "ok") as never, {
      conversationId: CARD,
      task: "go",
      env: { ...env, GARRISON_HTTPGATEWAY_ROUTING_TABLE: "false" },
    });
    // @ts-ignore — pure .mjs
    const { openConversation } = await import("../packages/claude-pty/src/conversation-store.mjs");
    const store = openConversation(CARD, { role: "test", env });
    const routing = store.tail(5, { kinds: ["stretch-routing"] }).map((e: any) => e.payload);
    expect(routing[0].target).toBe("sdk-haiku");
    expect(routing[0].reason).toBe("default");
    expect(routing[0].table).toBeUndefined();
  }, 15000);
});
