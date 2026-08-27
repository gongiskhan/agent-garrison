// Card-front EXECUTION BADGES — runtime / model / effort / duty / account / project.
//
// The board used to fold all routing attribution into ONE "plan @ opus" chip that
// only appeared AFTER a turn settled. So a queued card — and a card for the whole
// duration of its run, which is exactly when you want to know what is burning —
// showed no runtime, model or effort at all. Two gaps fed that:
//   1. routeFromDone/routeStamp narrowed the gateway's turnAttribution block away,
//      so account/duty/level/project could never reach the card,
//   2. nothing computed the EXPECTED route for a card that had not run yet, even
//      though the runner-projected model.json already knows it for (duty, level).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// @ts-ignore pure mjs
import { routeFromDone, gatewayRunFn } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";
// @ts-ignore pure mjs
import { routeStamp } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore pure mjs
import { expectedRouteFor } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore pure mjs
import { loadResolvedModel } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
import { execBadges } from "../fittings/seed/kanban-loop/ui/exec-badges";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


describe("routeFromDone — the gateway's turnAttribution block reaches the card", () => {
  it("passes through duty, level, skill, via, account, accountSource and project", () => {
    const r: any = routeFromDone({
      route: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet",
      effort: "medium", effortApplied: true, tier: "T1-standard",
      duty: "code", level: 2, skill: null, via: "kanban",
      account: "work", accountSource: "target", project: "ekoa-code", projectPath: "/x/ekoa"
    });
    expect(r).toMatchObject({
      targetId: "cc-sonnet", runtime: "agent-sdk", model: "sonnet", effort: "medium",
      duty: "code", level: 2, via: "kanban", account: "work",
      accountSource: "target", project: "ekoa-code"
    });
  });

  it("keeps `account` TRI-STATE: absent when unreported, null for the machine login", () => {
    const unreported: any = routeFromDone({ route: "t", model: "sonnet" });
    expect("account" in unreported).toBe(false); // no badge — we were told nothing

    const machine: any = routeFromDone({ route: "t", model: "sonnet", account: null });
    expect("account" in machine).toBe(true);
    expect(machine.account).toBeNull(); // a real answer: the machine's own login
  });

  it("still returns null when NOTHING routing-related flowed (souls mode)", () => {
    expect(routeFromDone({ reply: "hi" })).toBeNull();
    expect(routeFromDone(null)).toBeNull();
  });
});

describe("routeStamp — the widened attribution is what actually PERSISTS on the card", () => {
  it("persists the attribution fields alongside the original eight", () => {
    const { route } = routeStamp({
      targetId: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet",
      effort: "medium", effortApplied: true, tier: "T1-standard",
      duty: "code", level: 2, via: "kanban", account: "work", accountSource: "target",
      project: "ekoa-code"
    }, "code");
    expect(route).toMatchObject({
      targetId: "cc-sonnet", runtime: "agent-sdk", model: "sonnet", effort: "medium",
      tier: "T1-standard", phase: "code",
      duty: "code", level: 2, account: "work", project: "ekoa-code"
    });
  });

  it("leaves the human suffix untouched (it is asserted verbatim elsewhere)", () => {
    const { suffix } = routeStamp(
      { targetId: "t", runtime: "claude-code", model: "opus", effort: "high", tier: "T2-deep", duty: "code", level: 2 },
      "code"
    );
    expect(suffix).toBe(" · claude-code/opus (T2-deep · high)");
  });
});

describe("expectedRouteFor — a card carries badges BEFORE it has ever run", () => {
  // A v2 execution manifest shaped exactly like the runner's projection.
  function writeModel(root: string) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "model.json"), JSON.stringify({
      version: 2,
      compositionId: "test",
      kanbanLists: ["code"],
      selectedDuties: ["code"],
      duties: { code: { id: "code" } },
      sequences: { code: { "2": ["code"] } },
      steps: {
        code: {
          "2": [{
            duty: "code", level: 2, skill: null, targetId: "cc-sonnet",
            runtime: "agent-sdk", provider: "anthropic", model: "sonnet", effort: "medium",
            params: { promptMode: "coding", maxTurns: 100 }
          }]
        }
      }
    }), "utf8");
  }

  it("resolves runtime/model/effort from the card's (duty, level) — the incident card's real cell", () => {
    const root = mkdtempSync(join(tmpdir(), "exec-badge-"));
    writeModel(root);
    const model = loadResolvedModel(root);
    const route = expectedRouteFor(
      { duty: "code", level: 2, list: "code", sequence: ["code"] },
      model
    );
    expect(route).toMatchObject({
      targetId: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic",
      model: "sonnet", effort: "medium", phase: "code", duty: "code", level: 2
    });
  });

  it("uses the FIRST phase of the sequence for a card not yet on a phase list", () => {
    const root = mkdtempSync(join(tmpdir(), "exec-badge-"));
    writeModel(root);
    const model = loadResolvedModel(root);
    const route = expectedRouteFor({ duty: "code", level: 2, list: "todo", sequence: ["code"] }, model);
    expect(route?.phase).toBe("code");
    expect(route?.model).toBe("sonnet");
  });

  it("returns null (no invented badges) for a card with no duty, or with no model on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "exec-badge-"));
    writeModel(root);
    const model = loadResolvedModel(root);
    expect(expectedRouteFor({ list: "todo" }, model)).toBeNull();
    expect(expectedRouteFor({ duty: "code", level: 2, list: "code" }, null)).toBeNull();
  });
});

describe("execBadges — what the card front actually renders", () => {
  it("emits one badge per reported dimension, marked NOT expected, when a turn has settled", () => {
    const { badges, expected } = execBadges(
      { targetId: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet", effort: "medium", effortApplied: true, tier: "T1-standard", duty: "code", level: 2, account: "work" } as any,
      null
    );
    expect(expected).toBe(false);
    const byKey = Object.fromEntries(badges.map((b) => [b.key, b.value]));
    expect(byKey).toMatchObject({ runtime: "agent-sdk", model: "sonnet", effort: "medium", duty: "code L2", account: "work" });
  });

  it("falls back to the EXPECTED route and flags it, so it reads as 'will run on'", () => {
    const { badges, expected } = execBadges(null, { runtime: "agent-sdk", model: "sonnet", effort: "medium", duty: "code", level: 2 } as any);
    expect(expected).toBe(true);
    expect(badges.map((b) => b.key)).toEqual(["runtime", "model", "effort", "duty"]);
  });

  it("never invents a dimension the gateway did not report", () => {
    const { badges } = execBadges({ runtime: "agent-sdk", model: null, effort: null, targetId: null, provider: null, tier: null } as any, null);
    expect(badges.map((b) => b.key)).toEqual(["runtime"]); // no empty model/effort placeholders
  });

  it("renders effort's application truth — 'not applied' can never look like a clean setting", () => {
    const applied = execBadges({ model: "opus", effort: "high", effortApplied: true } as any, null).badges.find((b) => b.key === "effort");
    const refused = execBadges({ model: "opus", effort: "high", effortApplied: false } as any, null).badges.find((b) => b.key === "effort");
    expect(applied?.value).toBe("high");
    expect(refused?.value).toBe("high (not applied)");
    expect(refused?.title).toMatch(/did NOT apply/);
  });

  it("shows the machine login as a real account answer, and omits the badge when unreported", () => {
    const machine = execBadges({ model: "opus", account: null } as any, null).badges.find((b) => b.key === "account");
    expect(machine?.value).toBe("machine login");
    const unreported = execBadges({ model: "opus" } as any, null).badges.find((b) => b.key === "account");
    expect(unreported).toBeUndefined();
  });

  it("renders nothing at all when there is no attribution from either source", () => {
    expect(execBadges(null, null).badges).toEqual([]);
  });
});

// ── the streaming turn must have a client-side bound ─────────────────────────
//
// gatewayRunFn sent `timeoutMs` to the gateway but armed no deadline of its own,
// and the gateway drops that hint on the agent-sdk lane — the lane kanban cards
// actually run on. So a turn whose `done` frame never arrived left the caller
// awaiting the stream forever, and the card "running" forever with it. The idle
// deadline must key on CONTENT frames: the gateway heartbeats a `: keepalive`
// comment every 15s, which would otherwise keep a wedged turn alive indefinitely.
describe("gatewayRunFn — client-side turn deadlines", () => {
  it("aborts a stream that goes silent (keepalive comments do NOT count as progress) and classifies it transport", async () => {
    process.env.KANBAN_TURN_IDLE_MS = "150";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: open\ndata: {}\n\n");
      // Heartbeat forever, never send a content frame — the exact wedge shape.
      setInterval(() => { try { res.write(": keepalive\n\n"); } catch { /* closed */ } }, 20).unref();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    try {
      const err: any = await gatewayRunFn(`http://127.0.0.1:${port}`)({ prompt: "x", list: {} }).then(
        () => null,
        (e: any) => e
      );
      expect(err).toBeTruthy();
      expect(err.transport).toBe(true); // retriable — the card reverts, never parks
      expect(String(err.message)).toMatch(/abandoned|no output/i);
    } finally {
      server.close();
      delete process.env.KANBAN_TURN_IDLE_MS;
    }
  }, 20000);

  it("counts tool work as output: activity + session_event keep a silent turn alive", async () => {
    // A phase that reads twenty files before it says anything emits no prose for
    // minutes. Its progress arrives as `activity` (tool/thinking) and
    // `session_event` (canonical events) - and while those did not re-arm the
    // deadline, a WORKING turn was abandoned as "no output" and its card bounced
    // back to Implement, repeatedly. Raising the per-target turn budget made the
    // silent stretches long enough to hit it every time.
    process.env.KANBAN_TURN_IDLE_MS = "300";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: open\ndata: {}\n\n");
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        // Alternate the two frames a tool-only stretch actually produces. No
        // `chunk`, no `route`, no prose - just work.
        res.write(n % 2
          ? `event: activity\ndata: ${JSON.stringify({ kind: "tool", name: "Read" })}\n\n`
          : `event: session_event\ndata: ${JSON.stringify({ id: `e${n}`, role: "assistant", ts: n, order: n, revision: 1, blocks: [{ type: "tool_use", name: "Read", toolUseId: `t${n}`, input: "{}" }] })}\n\n`);
        if (n >= 6) { // twice the idle window with never a word of prose
          clearInterval(t);
          res.write(`event: done\ndata: ${JSON.stringify({ reply: "read them all\nreview" })}\n\n`);
          res.end();
        }
      }, 100);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    try {
      const out: any = await gatewayRunFn(`http://127.0.0.1:${port}`)({ prompt: "x", list: {} });
      expect(out.reply).toMatch(/review/);
    } finally {
      server.close();
      delete process.env.KANBAN_TURN_IDLE_MS;
    }
  }, 20000);

  it("a stream that keeps sending CONTENT is not aborted by the idle deadline", async () => {
    process.env.KANBAN_TURN_IDLE_MS = "300";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`event: chunk\ndata: ${JSON.stringify({ text: "tick " })}\n\n`);
        if (n >= 6) { // ~600ms of work, twice the idle window
          clearInterval(t);
          res.write(`event: done\ndata: ${JSON.stringify({ reply: "all good\nreview" })}\n\n`);
          res.end();
        }
      }, 100);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    try {
      const out: any = await gatewayRunFn(`http://127.0.0.1:${port}`)({ prompt: "x", list: {} });
      expect(out.reply).toMatch(/review/);
    } finally {
      server.close();
      delete process.env.KANBAN_TURN_IDLE_MS;
    }
  }, 20000);
});
