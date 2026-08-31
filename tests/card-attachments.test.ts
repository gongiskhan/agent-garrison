// Card-owned uploads reached the model in the duty-list era: buildCardPrompt
// folded the absolute paths into every dispatch prompt, re-listed per dispatch.
// THE CUT (c7475ecf) deleted that engine and the conversation brief never
// picked the fold up - card 01M1BFEN... spent seven stretches being told "this
// card has image attachments" while no stretch ever saw a path or had a tool
// to list one. The fold is back: the card detail read carries `path` on
// uploaded attachments, the brief folds them, and the card is re-read per
// stretch so a file attached mid-conversation reaches the NEXT stretch.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { runConversation, buildStretchBrief, cardAttachmentsEnabled } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

const CARD = "01M1CARDATTACHMENTS0000001";

let tmp: string;
let env: Record<string, string>;
let server: Server | undefined;
let prevHome: string | undefined;

// A board whose card detail grows an attachment when the test flips
// `uploadLanded` - the mid-conversation upload, landed at a moment the test
// controls instead of counting internal reads.
let uploadLanded = false;
let longDescription: string | null = null;
function startBoard(): Promise<number> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && /\/cards\//.test(req.url ?? "")) {
        const attachments = [
          { name: "image-1.png", image: true, url: `/cards/${CARD}/artifact?ref=attachment%3Aimage-1.png`, uploaded: true, path: `/data/cards/${CARD}/attachments/image-1.png` },
        ];
        if (uploadLanded) {
          attachments.push({ name: "image-2.png", image: true, url: `/cards/${CARD}/artifact?ref=attachment%3Aimage-2.png`, uploaded: true, path: `/data/cards/${CARD}/attachments/image-2.png` });
        }
        res.end(JSON.stringify({
          card: { id: CARD, rev: 1, title: "describe the images", list: "running", status: "running", conversationId: CARD, autonomous: true, ...(longDescription ? { description: longDescription } : {}) },
          checklist: [],
          acceptance: null,
          attachments,
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, card: { id: CARD, rev: 1 } }));
    });
  });
  return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port)));
}

function fakeGateway(briefs: Record<string, string>, nexts: Record<string, string>) {
  const LADDER = {
    ladder: "standard",
    rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
    defaultIndex: 0,
    ceilingIndex: 0,
  };
  return {
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
      if (route.duty === "triage") uploadLanded = true; // the upload lands while triage runs
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
}

beforeEach(() => {
  uploadLanded = false;
  tmp = mkdtempSync(path.join(os.tmpdir(), "card-attach-"));
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

function wireBoard(port: number) {
  writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
}

describe("cardAttachmentsEnabled", () => {
  it("is on unless the revert flag explicitly turns it off", () => {
    expect(cardAttachmentsEnabled({})).toBe(true);
    expect(cardAttachmentsEnabled({ GARRISON_HTTPGATEWAY_CARD_ATTACHMENTS: "true" })).toBe(true);
    for (const off of ["false", "0", "off", "no", "FALSE"]) {
      expect(cardAttachmentsEnabled({ GARRISON_HTTPGATEWAY_CARD_ATTACHMENTS: off }), off).toBe(false);
    }
  });
});

describe("buildStretchBrief attachments", () => {
  const base = {
    conversationId: "conv-a",
    conversationDir: "/x/conv-a",
    duty: "implement",
    handoffPath: "/x/conv-a/handoffs/0001.json",
    stretchId: "st_1",
    selectedDuties: ["implement"],
  };

  it("folds uploaded attachment paths into the card section", () => {
    const brief = buildStretchBrief({
      ...base,
      card: {
        id: CARD,
        title: "t",
        checklist: [{ text: "describe the attachments", done: false }],
        attachments: [
          { name: "a.png", path: "/abs/a.png", uploaded: true },
          { name: "legacy.png", url: "/cards/x/attachment?i=0" }, // description-block entry: no path, already in the description text
        ],
      },
    });
    expect(brief).toContain("Attached files (context for this card");
    expect(brief).toContain("- /abs/a.png");
    expect(brief).not.toContain("legacy.png");
    // Inside the card section, ahead of the checklist - the reading order the
    // old engine established.
    expect(brief.indexOf("Attached files")).toBeGreaterThan(brief.indexOf("## The card"));
    expect(brief.indexOf("Attached files")).toBeLessThan(brief.indexOf("describe the attachments"));
  });

  it("says nothing when the card has no path-bearing attachments", () => {
    const brief = buildStretchBrief({ ...base, card: { id: CARD, title: "t", attachments: [{ name: "legacy.png" }] } });
    expect(brief).not.toContain("Attached files");
  });
});

describe("an over-cap description says so and points at the whole text", () => {
  it("buildStretchBrief marks the truncation and names the path", () => {
    const long = "x".repeat(9000);
    const brief = buildStretchBrief({
      conversationId: "conv-t",
      conversationDir: "/x/conv-t",
      duty: "implement",
      handoffPath: "/x/conv-t/handoffs/0001.json",
      stretchId: "st_1",
      selectedDuties: ["implement"],
      card: { id: CARD, title: "t", description: long, descriptionPath: "/x/conv-t/card-description.md" },
    });
    expect(brief).toContain("TRUNCATED at 8000 of 9000 characters");
    expect(brief).toContain("/x/conv-t/card-description.md");
    // A short description stays unadorned.
    const short = buildStretchBrief({
      conversationId: "conv-t",
      conversationDir: "/x/conv-t",
      duty: "implement",
      handoffPath: "/x/conv-t/handoffs/0001.json",
      stretchId: "st_1",
      selectedDuties: ["implement"],
      card: { id: CARD, title: "t", description: "small ask" },
    });
    expect(short).not.toContain("TRUNCATED");
  });

  it("the loop writes card-description.md beside the ledger", async () => {
    const port = await startBoard();
    wireBoard(port);
    longDescription = "Part A. " + "a".repeat(9000) + " Part B ends with THE-TAIL-MARKER";
    const briefs: Record<string, string> = {};
    const gateway = fakeGateway(briefs, { triage: "needs-input" });
    await runConversation(gateway as never, { conversationId: CARD, task: "do the long thing", env });
    const full = path.join(tmp, "conversations", CARD, "card-description.md");
    const written = readFileSync(full, "utf8");
    expect(written).toContain("THE-TAIL-MARKER");
    expect(briefs.triage).toContain("TRUNCATED at 8000");
    expect(briefs.triage).toContain(full);
    longDescription = null;
  }, 15000);
});

describe("the loop re-reads the card per stretch", () => {
  it("a file attached mid-conversation reaches the next stretch", async () => {
    // The upload lands while the triage stretch runs (after its brief was
    // built); only the plan stretch's re-read can see it.
    const port = await startBoard();
    wireBoard(port);
    const briefs: Record<string, string> = {};
    const gateway = fakeGateway(briefs, { triage: "plan", plan: "needs-input" });
    await runConversation(gateway as never, { conversationId: CARD, task: "describe the images", env });
    expect(briefs.triage).toContain("- /data/cards/" + CARD + "/attachments/image-1.png");
    expect(briefs.triage).not.toContain("image-2.png");
    expect(briefs.plan).toContain("- /data/cards/" + CARD + "/attachments/image-2.png");
  }, 15000);

  it("the flag off restores the attachment-blind brief", async () => {
    const port = await startBoard();
    wireBoard(port);
    const briefs: Record<string, string> = {};
    const gateway = fakeGateway(briefs, { triage: "needs-input" });
    await runConversation(gateway as never, {
      conversationId: CARD,
      task: "describe the images",
      env: { ...env, GARRISON_HTTPGATEWAY_CARD_ATTACHMENTS: "false" },
    });
    expect(briefs.triage).toBeTruthy();
    expect(briefs.triage).not.toContain("Attached files");
    expect(briefs.triage).not.toContain("image-1.png");
  }, 15000);
});
