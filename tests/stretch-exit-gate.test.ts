// The exit gate NEVER silently passes: file → fenced reply → one in-session
// re-ask → one floor-rung repair → a synthetic failed handoff, in that order,
// with identity fields normalized by the launcher.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs
import { runExitGate, parseFencedHandoff } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "gate-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const DUTIES = ["implement", "review", "test"];
const gateway = { compositionDir: "/tmp" } as any;

function goodHandoff(over: any = {}): any {
  return {
    v: 1,
    stretchId: "wrong-id-model-fumbled",
    duty: "also-wrong",
    status: "complete",
    summary: "done the thing",
    evidenceRefs: [],
    nextSteps: { next: "review", why: "unread", items: [] },
    blocker: null,
    activeConstraints: [],
    failedApproaches: [],
    surprises: [],
    forceEscalation: null,
    synthesized: false,
    ...over,
  };
}

describe("parseFencedHandoff", () => {
  it("parses a ```handoff fence and a trailing ```json fence; rejects garbage", () => {
    const h = goodHandoff();
    expect(parseFencedHandoff("text\n```handoff\n" + JSON.stringify(h) + "\n```\n")).toMatchObject({ status: "complete" });
    expect(parseFencedHandoff("text\n```json\n" + JSON.stringify(h) + "\n```")).toMatchObject({ status: "complete" });
    expect(parseFencedHandoff("no fence here")).toBeNull();
    expect(parseFencedHandoff("```handoff\nnot json\n```")).toBeNull();
  });
});

describe("runExitGate", () => {
  it("a valid handoff FILE passes and gets its identity normalized", async () => {
    const store = openConversation("g1", { role: "gateway", env });
    store.writeHandoff(1, goodHandoff());
    const gate = await runExitGate(gateway, {
      store, stretchId: "st_REAL", ordinal: 1, duty: "implement", route: { target: { runtime: "agent-sdk" } },
      reply: "some reply", selectedDuties: DUTIES,
    });
    expect(gate.valid).toBe(true);
    expect(gate.source).toBe("file");
    expect(gate.synthesized).toBe(false);
    const persisted = store.readHandoff(1);
    expect(persisted.stretchId).toBe("st_REAL");
    expect(persisted.duty).toBe("implement");
  });

  it("falls back to a fenced block in the reply and persists it as the file", async () => {
    const store = openConversation("g2", { role: "gateway", env });
    const reply = "I did the work.\n```handoff\n" + JSON.stringify(goodHandoff()) + "\n```";
    const gate = await runExitGate(gateway, {
      store, stretchId: "st_2", ordinal: 1, duty: "implement", route: { target: { runtime: "codex" } },
      reply, selectedDuties: DUTIES,
    });
    expect(gate.valid).toBe(true);
    expect(gate.source).toBe("reply");
    expect(store.readHandoff(1)).toMatchObject({ stretchId: "st_2", status: "complete" });
  });

  it("invalid → ONE in-session re-ask can fix it", async () => {
    const store = openConversation("g3", { role: "gateway", env });
    store.writeHandoff(1, { garbage: true });
    let reAsked = 0;
    const gate = await runExitGate(gateway, {
      store, stretchId: "st_3", ordinal: 1, duty: "implement", route: { target: { runtime: "agent-sdk" } },
      reply: "reply", selectedDuties: DUTIES,
      reAsk: async (prompt: string) => {
        reAsked += 1;
        expect(prompt).toContain("invalid");
        store.writeHandoff(1, goodHandoff());
        return "DONE";
      },
    });
    expect(reAsked).toBe(1);
    expect(gate.valid).toBe(true);
    expect(gate.source).toBe("file");
    expect(gate.repairs).toBe(0);
  });

  it("re-ask fails → ONE repair call parses a fenced handoff", async () => {
    const store = openConversation("g4", { role: "gateway", env });
    let repaired = 0;
    const gate = await runExitGate(gateway, {
      store, stretchId: "st_4", ordinal: 1, duty: "implement", route: { target: { runtime: "agent-sdk" } },
      reply: "raw model text with no handoff", selectedDuties: DUTIES,
      reAsk: async () => "still nothing",
      repair: async (prompt: string) => {
        repaired += 1;
        expect(prompt).toContain("STRETCH REPLY");
        return "```handoff\n" + JSON.stringify(goodHandoff({ status: "partial", failedApproaches: [{ approach: "x", why: "y" }], nextSteps: { next: "implement", why: "unfinished", items: [] } })) + "\n```";
      },
    });
    expect(repaired).toBe(1);
    expect(gate.valid).toBe(true);
    expect(gate.source).toBe("repair");
    expect(gate.repairs).toBe(1);
    expect(store.readHandoff(1).status).toBe("partial");
  });

  it("everything fails → synthetic failed handoff routing needs-input; never a silent pass", async () => {
    const store = openConversation("g5", { role: "gateway", env });
    const gate = await runExitGate(gateway, {
      store, stretchId: "st_5", ordinal: 1, duty: "implement", route: { target: { runtime: "codex" } },
      reply: "", selectedDuties: DUTIES,
      reAsk: null,
      repair: async () => "nope",
    });
    expect(gate.synthesized).toBe(true);
    expect(gate.source).toBe("synthesized");
    const h = store.readHandoff(1);
    expect(h.status).toBe("failed");
    expect(h.synthesized).toBe(true);
    expect(h.nextSteps.next).toBe("needs-input");
    expect(h.blocker.what).toBeTruthy();
  });

  it("a handoff claiming evidence that is not on disk is INVALID and goes through repair", async () => {
    const store = openConversation("g6", { role: "gateway", env });
    store.writeHandoff(1, goodHandoff({ evidenceRefs: [{ kind: "run", ref: path.join(tmp, "fake-evidence.md") }] }));
    const gate = await runExitGate(gateway, {
      store, stretchId: "st_6", ordinal: 1, duty: "implement", route: { target: { runtime: "agent-sdk" } },
      reply: "", selectedDuties: DUTIES,
      reAsk: null, repair: null,
    });
    expect(gate.synthesized).toBe(true);
    expect(store.readHandoff(1).status).toBe("failed");
  });
});
