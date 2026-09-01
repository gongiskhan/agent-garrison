// Only a BUILT BRIEF consumes a user message. The old rule - "older than the
// last handoff" - silently ate any message that arrived while a stretch was
// running: the stretch's own handoff outranked it though no brief ever carried
// it. Live: a "hand off to implement" directive posted mid-responder vanished,
// and the conversation settled needs-input with the directive unread.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { runConversation, recordUserMessage } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";

const CARD = "01M1MSGCONSUME000000000001";

let tmp: string;
let env: Record<string, string>;
let server: Server | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "msg-consume-"));
  env = { GARRISON_HOME: tmp };
  mkdirSync(path.join(tmp, "ui-fittings"), { recursive: true });
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmp;
});

afterEach(() => {
  process.env.GARRISON_HOME = prevHome;
  server?.close();
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
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

describe("a message landing mid-stretch is not eaten by that stretch's handoff", () => {
  it("wakes the responder after the stretch instead of settling deaf", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const LADDER = {
      ladder: "standard",
      rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
      defaultIndex: 0,
      ceilingIndex: 0,
    };
    const briefs: string[] = [];
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
        return { version: 3, selectedDuties: ["triage", "responder"], duties: {}, dutyLadder: { triage: LADDER, responder: LADDER } };
      },
      async executionRouteFor({ duty, level }: any) {
        return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
      },
      async runAgentSdkTurn(route: any, b: string) {
        briefs.push(`${route.duty}:${b.includes("MID-FLIGHT-DIRECTIVE") ? "carries" : "blind"}`);
        const handoffPath = /handoffPath: (.+)/.exec(b)![1].trim();
        const stretchId = /stretchId: (.+)/.exec(b)![1].trim();
        if (route.duty === "triage") {
          // The user speaks WHILE this stretch is running - before its handoff.
          const store = openConversation(CARD, { role: "test", env });
          recordUserMessage(store, { text: "MID-FLIGHT-DIRECTIVE: also do the other thing", origin: "web" });
        }
        writeFileSync(handoffPath, JSON.stringify({
          v: 1, stretchId, duty: route.duty, status: "complete", summary: "done",
          evidenceRefs: [], nextSteps: { next: "needs-input", why: "w", items: [] },
          blocker: { what: "a look", needs: "user", who: "user" },
          activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false,
        }));
        return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
      },
      async releaseConversationSessions() { return 1; },
    };
    await runConversation(gateway as never, { conversationId: CARD, task: "open the work", env });
    // The triage handoff said needs-input, but the mid-flight message is
    // UNCONSUMED (no brief carried it) - so a responder runs and its brief
    // carries the directive.
    expect(briefs[0]).toBe("triage:blind");
    expect(briefs).toContain("responder:carries");
  }, 15000);
});
