// "use a better model, it is there" moved nothing on a live card: the rung
// ladder honours an explicit pin, a tripwire, or a handoff's forceEscalation -
// and the exit contract documented forceEscalation as a bare schema key, so no
// duty ever knew it was the lever for relaying the user's ask. The machine
// worked; the contract never said when to pull it. Now it does, and this file
// pins both the contract text and the machine it drives.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { runConversation, buildStretchBrief, resolveRung } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

let tmp: string;
let env: Record<string, string>;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "handoff-esc-"));
  env = { GARRISON_HOME: tmp };
  mkdirSync(path.join(tmp, "ui-fittings"), { recursive: true });
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmp;
});

afterEach(() => {
  process.env.GARRISON_HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("the exit contract explains forceEscalation", () => {
  it("names the lever, the user-ask trigger, and the restraint", () => {
    const brief = buildStretchBrief({
      conversationId: "c",
      conversationDir: "/x/c",
      duty: "responder",
      handoffPath: "/x/c/handoffs/0001.json",
      stretchId: "st_1",
      selectedDuties: ["responder"],
    });
    expect(brief).toContain("forceEscalation is the model lever");
    expect(brief).toContain("user asked for a stronger model");
    expect(brief).toContain("Otherwise keep it null");
  });
});

describe("resolveRung honours a forced handoff", () => {
  const LADDER = {
    ladder: "standard",
    rungs: [
      { id: "floor", target: "sdk-haiku", runtime: "agent-sdk", model: "haiku", params: {} },
      { id: "top", target: "cc-opus", runtime: "agent-sdk", model: "opus", params: {} },
    ],
    defaultIndex: 0,
    ceilingIndex: 1,
  };

  it("runs one rung above the floor and keeps the reason", () => {
    const pick = resolveRung({ ladder: LADDER, forced: "user asked for a stronger model" });
    expect(pick.index).toBe(1);
    expect(pick.chosenBy).toBe("escalation-forced");
    expect(pick.chosenWhy).toBe("user asked for a stronger model");
  });
});

describe("a handoff relaying the user's ask escalates the next stretch", () => {
  it("the next stretch runs above the floor and the floor sticks", async () => {
    const TWO_RUNGS = {
      ladder: "standard",
      rungs: [
        { id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} },
        { id: "top", target: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet", params: {} },
      ],
      defaultIndex: 0,
      ceilingIndex: 1,
    };
    const started: any[] = [];
    const events: any[] = [];
    const gateway = {
      compositionDir: tmp,
      logFn: () => {},
      _laneQueues: new Map(),
      _onLane(key: string, fn: () => Promise<unknown>) {
        const prev = this._laneQueues.get(key) ?? Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        this._laneQueues.set(key, run.catch(() => {}));
        return run;
      },
      async executionModel() {
        return { version: 3, selectedDuties: ["triage", "plan"], duties: {}, dutyLadder: { triage: TWO_RUNGS, plan: TWO_RUNGS } };
      },
      async executionRouteFor({ duty, level }: any) {
        return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
      },
      async runAgentSdkTurn(route: any, b: string) {
        const handoffPath = /handoffPath: (.+)/.exec(b)![1].trim();
        const stretchId = /stretchId: (.+)/.exec(b)![1].trim();
        const duty = route.duty;
        writeFileSync(handoffPath, JSON.stringify({
          v: 1, stretchId, duty, status: "complete", summary: "did it",
          evidenceRefs: [], nextSteps: { next: duty === "triage" ? "plan" : "needs-input", why: "w", items: [] },
          blocker: duty === "plan" ? { what: "a look", needs: "user", who: "user" } : null,
          activeConstraints: [], failedApproaches: [], surprises: [],
          // The triage stretch read "use a better model" and relays it.
          forceEscalation: duty === "triage" ? "user asked for a stronger model" : null,
          synthesized: false,
        }));
        return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
      },
      async releaseConversationSessions() { return 1; },
    };
    await runConversation(gateway as never, {
      conversationId: "conv-force",
      task: "do the thing",
      env,
      onFrame: (kind: string, payload: any) => {
        if (kind === "stretch-started") started.push(payload);
        events.push([kind, payload]);
      },
    });
    expect(started).toHaveLength(2);
    expect(started[0].duty).toBe("triage");
    expect(started[0].rung.id).toBe("floor");
    expect(started[1].duty).toBe("plan");
    expect(started[1].rung.id).toBe("top");
    expect(started[1].chosenBy).toBe("escalation-forced");
    expect(started[1].chosenWhy).toBe("user asked for a stronger model");
    // The floor is sticky: raised for the duty that escalated INTO.
    expect(started[1].floorAfter).toBe("top");
  }, 15000);
});
