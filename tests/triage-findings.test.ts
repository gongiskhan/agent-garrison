// Triage read eight or nine files in every recorded run and appended zero
// findings. It had the tool (SHARED_MCP_TOOLS gives every duty
// garrison_finding_add), it ran on agent-sdk, and FINDINGS_CONTRACT was in its
// brief. What it did not have was any statement that ORIENTING is itself worth
// recording, so it put the facts in its handoff summary instead - which is prose
// for a human and is not carried forward as claims.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs
import { composeFindings, normalizeFinding } from "../packages/claude-pty/src/findings.mjs";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { buildStretchBrief, findingsExpectationFor, dutyFindingsExpectationEnabled, DUTY_FINDINGS_EXPECTATION, runConversation } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "triage-findings-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("findingsExpectationFor", () => {
  it("gives triage a concrete expectation and other duties none", () => {
    expect(findingsExpectationFor("triage", {})).toBe(DUTY_FINDINGS_EXPECTATION.triage);
    expect(findingsExpectationFor("implement", {})).toBeNull();
    expect(findingsExpectationFor("responder", {})).toBeNull();
  });

  it("asks for anchored fact entries, not summary prose", () => {
    const text = String(DUTY_FINDINGS_EXPECTATION.triage);
    expect(text).toContain("anchorPath");
    expect(text).toContain("fact");
    expect(text).toMatch(/summary is not recording them/i);
  });

  it("is behind the revert flag", () => {
    expect(dutyFindingsExpectationEnabled({})).toBe(true);
    for (const off of ["false", "0", "off", "no"]) {
      expect(dutyFindingsExpectationEnabled({ GARRISON_HTTPGATEWAY_TRIAGE_FINDINGS: off }), off).toBe(false);
      expect(findingsExpectationFor("triage", { GARRISON_HTTPGATEWAY_TRIAGE_FINDINGS: off })).toBeNull();
    }
  });
});

describe("the triage brief", () => {
  const brief = (duty: string, e: Record<string, string> = {}) =>
    buildStretchBrief({
      conversationId: "c1",
      conversationDir: "/x/c1",
      duty,
      handoffPath: "/x/c1/handoffs/0001.json",
      stretchId: "st_1",
      selectedDuties: ["triage", "plan", "implement"],
      findingsExpectation: findingsExpectationFor(duty, e),
    });

  it("names the tool and states what triage should record with it", () => {
    const b = brief("triage");
    expect(b).toContain("mcp__garrison__garrison_finding_add");
    expect(b).toContain("### What to record on this duty");
    // and it sits before the exit contract, so the handoff is not the last word
    expect(b.indexOf("### What to record on this duty")).toBeLessThan(b.indexOf("Exit contract (MANDATORY)"));
  });

  it("leaves every other duty on the shared contract alone", () => {
    const b = brief("implement");
    expect(b).toContain("mcp__garrison__garrison_finding_add");
    expect(b).not.toContain("### What to record on this duty");
  });

  it("drops back to the shared contract with the flag off", () => {
    expect(brief("triage", { GARRISON_HTTPGATEWAY_TRIAGE_FINDINGS: "false" })).not.toContain("### What to record on this duty");
  });
});

describe("what triage records is carried into the next stretch", () => {
  it("composes a triage fact into the following stretch's brief, with its anchor", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "repo-"));
    const file = path.join(repo, "store.js");
    writeFileSync(file, "export function open() {}\n");
    const store = openConversation("conv-carry", { role: "gateway", env });
    store.init({ title: "carry" });
    // Exactly what the MCP tool appends when triage calls it.
    store.append({
      kind: "finding",
      stretch: "st_triage",
      duty: "triage",
      payload: normalizeFinding(
        { kind: "fact", claim: "every write goes through store.js; routes never touch the db", anchorPath: "store.js" },
        { stretchId: "st_triage", duty: "triage", cwd: repo }
      ),
    });
    const composed = composeFindings(store.range({ fromIndex: 0, limit: 1000 }).events, { cwd: repo, conversationId: "conv-carry" });
    expect(composed.entries).toHaveLength(1);
    expect(composed.staleCount).toBe(0);

    const next = buildStretchBrief({
      conversationId: "conv-carry",
      conversationDir: "/x/conv-carry",
      duty: "plan",
      handoffPath: "/x/conv-carry/handoffs/0002.json",
      stretchId: "st_plan",
      selectedDuties: ["triage", "plan"],
      findingsText: composed.text,
      findingsExpectation: findingsExpectationFor("plan", {}),
    });
    expect(next).toContain("What earlier stretches established");
    expect(next).toContain("every write goes through store.js");
    expect(next).toContain("anchor store.js@");
    rmSync(repo, { recursive: true, force: true });
  });

  it("the loop hands the triage expectation to the triage stretch and only to it", async () => {
    const briefs: Record<string, string> = {};
    const LADDER = {
      ladder: "standard",
      rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
      defaultIndex: 0,
      ceilingIndex: 0,
    };
    const nexts: Record<string, string> = { triage: "plan", plan: "needs-input" };
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
        return { version: 3, selectedDuties: ["triage", "plan"], duties: {}, dutyLadder: { triage: LADDER, plan: LADDER } };
      },
      async executionRouteFor({ duty, level }: any) {
        return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
      },
      async runAgentSdkTurn(route: any, b: string) {
        briefs[route.duty] = b;
        const handoffPath = /handoffPath: (.+)/.exec(b)![1].trim();
        const stretchId = /stretchId: (.+)/.exec(b)![1].trim();
        writeFileSync(handoffPath, JSON.stringify({
          v: 1, stretchId, duty: route.duty, status: "complete", summary: "did it",
          evidenceRefs: [], nextSteps: { next: nexts[route.duty], why: "w", items: [] },
          blocker: nexts[route.duty] === "needs-input" ? { what: "a look", needs: "user", who: "user" } : null,
          activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false,
        }));
        return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
      },
      async releaseConversationSessions() { return 1; },
    };
    await runConversation(gateway as never, { conversationId: "conv-expect", task: "build a thing", env });
    expect(briefs.triage).toContain("### What to record on this duty");
    expect(briefs.plan).toBeTruthy();
    expect(briefs.plan).not.toContain("### What to record on this duty");
  }, 15000);
});
