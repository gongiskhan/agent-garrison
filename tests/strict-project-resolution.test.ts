// A card that names a project which does not resolve on this machine used to
// fall back to the composition directory and run there anyway: the stretch
// worked, wrote files, and reported success in a tree nobody asked it to touch.
// Strict mode refuses to start, parks the card, and says why in the ledger.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { runConversation, stretchScopeForCard, strictProjectResolution, projectResolutionFailure, PROJECT_RESOLUTION_RULE } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

const BAD_PROJECT = "no-such-project-9c3f2a";
const CARD = "01M1STRICTPROJECT0000000001";

let tmp: string;
let env: Record<string, string>;
let server: Server;
let patches: any[];
let prevHome: string | undefined;

// A board that hands back one card naming an unresolvable project, and records
// every PATCH so the park is observable.
function startBoard(card: Record<string, unknown>): Promise<number> {
  patches = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "PATCH") patches.push(JSON.parse(body || "{}"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, card }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function fakeGateway(onStretch: (duty: string, brief: string) => void) {
  const LADDER = {
    ladder: "standard",
    rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", params: {} }],
    defaultIndex: 0,
    ceilingIndex: 0,
  };
  return {
    compositionDir: path.join(tmp, "composition"),
    logFn: () => {},
    _laneQueues: new Map(),
    _onLane(key: string, fn: () => Promise<unknown>) {
      const prev = this._laneQueues.get(key) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(fn);
      this._laneQueues.set(key, run.catch(() => {}));
      return run;
    },
    async executionModel() {
      return {
        version: 3,
        selectedDuties: ["triage", "implement"],
        duties: { triage: { description: "open the work" } },
        dutyLadder: { triage: LADDER, implement: LADDER },
      };
    },
    async executionRouteFor({ duty, level }: any) {
      return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
    },
    async runAgentSdkTurn(route: any, brief: string) {
      onStretch(route.duty, brief);
      const handoffPath = /handoffPath: (.+)/.exec(brief)![1].trim();
      const stretchId = /stretchId: (.+)/.exec(brief)![1].trim();
      writeFileSync(handoffPath, JSON.stringify({
        v: 1, stretchId, duty: route.duty, status: "complete", summary: "opened",
        evidenceRefs: [], nextSteps: { next: "needs-input", why: "park", items: [] },
        blocker: { what: "a look", needs: "the user", who: "user" },
        activeConstraints: [], failedApproaches: [], surprises: [],
        forceEscalation: null, synthesized: false,
      }));
      return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
    },
    async releaseConversationSessions() { return 1; },
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "strict-project-"));
  env = { GARRISON_HOME: tmp };
  mkdirSync(path.join(tmp, "composition"), { recursive: true });
  const port = await startBoard({ id: CARD, rev: 1, list: "running", status: "running", conversationId: CARD, project: BAD_PROJECT });
  mkdirSync(path.join(tmp, "ui-fittings"), { recursive: true });
  writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmp;
});

afterEach(() => {
  process.env.GARRISON_HOME = prevHome;
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("strictProjectResolution", () => {
  it("is on unless the revert flag explicitly turns it off", () => {
    expect(strictProjectResolution({})).toBe(true);
    expect(strictProjectResolution({ GARRISON_HTTPGATEWAY_STRICT_PROJECT_RESOLUTION: "true" })).toBe(true);
    for (const off of ["false", "0", "off", "no", "FALSE"]) {
      expect(strictProjectResolution({ GARRISON_HTTPGATEWAY_STRICT_PROJECT_RESOLUTION: off }), off).toBe(false);
    }
  });
});

describe("projectResolutionFailure", () => {
  it("states the requested project, what it resolved to, and the rule", () => {
    const scope = stretchScopeForCard({ project: BAD_PROJECT });
    expect(scope.degraded).toBe(true);
    const f = projectResolutionFailure(scope, { compositionDir: "/comp", devRoot: "/home/u/dev" });
    expect(f.requestedProject).toBe(BAD_PROJECT);
    expect(f.resolvedPath).toBeNull();
    expect(f.fallbackPath).toBe("/comp");
    expect(f.devRoot).toBe("/home/u/dev");
    expect(f.rule).toBe(PROJECT_RESOLUTION_RULE);
    expect(f.message).toContain(BAD_PROJECT);
    expect(f.message).toContain("/comp");
    expect(f.message).toContain("dev-root");
  });
});

describe("runConversation with an unresolvable project", () => {
  it("refuses to start, parks the card, and records the failure in the ledger", async () => {
    const started: string[] = [];
    const gateway = fakeGateway((duty) => started.push(duty));
    const result = await runConversation(gateway as never, { conversationId: CARD, task: "do the thing", env });

    expect(result).toMatchObject({ stretches: 0, terminal: "needs-input" });
    expect(started, "no stretch may run").toEqual([]);

    const store = openConversation(CARD, { env });
    const events = store.tail(50);
    expect(events.map((e: any) => e.kind)).not.toContain("stretch-started");
    const fail = events.find((e: any) => e.kind === "project-unresolved");
    expect(fail, "the ledger carries the failure").toBeTruthy();
    expect(fail.payload.requestedProject).toBe(BAD_PROJECT);
    expect(fail.payload.resolvedPath).toBeNull();
    expect(fail.payload.fallbackPath).toBe(path.join(tmp, "composition"));
    expect(fail.payload.rule).toContain(".git");
    expect(String(fail.payload.message)).toContain(BAD_PROJECT);

    const park = patches.find((p) => p.list === "needs-attention");
    expect(park, "the card is parked on Needs input").toBeTruthy();
    expect(String(park.attentionReason)).toContain(BAD_PROJECT);
  }, 15000);

  it("with the revert flag off, falls back to the composition dir as before", async () => {
    const started: string[] = [];
    const gateway = fakeGateway((duty) => started.push(duty));
    const result = await runConversation(gateway as never, {
      conversationId: CARD,
      task: "do the thing",
      env: { ...env, GARRISON_HTTPGATEWAY_STRICT_PROJECT_RESOLUTION: "false" },
    });

    expect(started.length).toBeGreaterThan(0);
    expect(result.stretches).toBeGreaterThan(0);
    const store = openConversation(CARD, { env });
    const kinds = store.tail(80).map((e: any) => e.kind);
    expect(kinds).toContain("policy-rewrite");
    expect(kinds).not.toContain("project-unresolved");
  }, 15000);
});
