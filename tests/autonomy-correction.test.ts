// The hold's correction branch (§7.1, 2026-08-13).
//
// The router held a card and asked "I would run this as the image flow, duty
// image, level 2 - reply go to proceed, or correct me." The user replied
// "what?!? no! I was asking a question! should be discuss duty level 1 or level
// 2!" - and that correction was not affirmative, so it fell straight through the
// interception and was routed as a BRAND-NEW turn, which answered "I don't have
// context for what you're referring to". The ask had invited an answer it had no
// branch to receive.
//
// These tests are that branch: a non-affirmative reply on a held card is the
// correction, it re-dispatches over the card's original brief, it re-stamps the
// card, the card STAYS HELD, both learning records are written, and a failure
// says so rather than falling back to an ordinary turn.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — plain .mjs fitting module
import { resolveDiscussInterception } from "../fittings/seed/http-gateway/scripts/lib/discuss-intercept.mjs";
// @ts-ignore — pure .mjs routing layer, no .d.ts
import { RoutedGateway, heldCardRoute, patchHeldCardRouting, raisableDutyLevels } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs dispatch core (wired as the gateway wires it)
import * as dispatchCore from "../fittings/seed/orchestrator/lib/dispatch-core.mjs";
// @ts-ignore — pure .mjs consult module, no .d.ts
import { buildCorrectionRecord, evidenceFromVerdict, routePhrase, askQuestion } from "../fittings/seed/orchestrator/lib/autonomy-consult.mjs";

const CHANNELS = ["web", "omi", "slack", "voice"] as const;
const CORRECTION = "what?!? no! I was asking a question! should be discuss duty level 1 or level 2!";

const HELD = {
  id: "01HELD",
  list: "backlog",
  autonomyHeld: true,
  description: "i use garrison mostly as a pwa and keep getting this error. how do i get rid of it?",
  duty: "image",
  level: 2,
  flow: "image",
  tier: "T1-standard",
  dutyLevels: { image: 2 },
  autonomyAsk: { flow: "image", duty: "image", level: 2, tier: "T1-standard", decisionId: "dec-1", resumeList: "image" }
};

const resolverFor = (expectedOriginId: string, card: unknown) => {
  const seen: string[] = [];
  const fn = async (originId: string) => {
    seen.push(originId);
    return originId === expectedOriginId ? { attach: card } : null;
  };
  return Object.assign(fn, { seen });
};

// ── The interception decision ───────────────────────────────────────────────

describe("a non-affirmative reply on a HELD card is the correction", () => {
  for (const channel of CHANNELS) {
    it(`intercepts the correction on ${channel}`, async () => {
      const out = await resolveDiscussInterception({
        text: CORRECTION,
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolverFor(`${channel}:t1`, HELD)
      });
      expect(out, channel).toMatchObject({ action: "autonomy-correct", correction: CORRECTION });
      expect((out as { card: { id: string } }).card.id).toBe("01HELD");
    });
  }

  it("an affirmative on the same card still RELEASES it - the go branch is untouched", async () => {
    for (const yes of ["go", "GO", "go.", "proceed", "ship it"]) {
      const out = await resolveDiscussInterception({
        text: yes,
        channel: "web",
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolverFor("web:t1", HELD)
      });
      expect(out, yes).toMatchObject({ action: "autonomy-go" });
    }
  });

  it("a reply on a NON-held thread is still an ordinary turn (regression)", async () => {
    for (const card of [
      { id: "C", list: "implement" },
      { id: "C", list: "discuss", discussHeld: false },
      { id: "C", list: "backlog", autonomyHeld: false }
    ]) {
      const out = await resolveDiscussInterception({
        text: CORRECTION,
        channel: "web",
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolverFor("web:t1", card)
      });
      expect(out, JSON.stringify(card)).toBeNull();
    }
  });

  it("an empty message, or one with no origin, interprets nothing", async () => {
    const resolve = resolverFor("web:t1", HELD);
    expect(await resolveDiscussInterception({ text: "   ", channel: "web", sessionId: "t1", pendingQuestions: new Map(), resolveThreadCard: resolve })).toBeNull();
    expect(resolve.seen).toEqual([]); // nothing to interpret -> no board round-trip
    expect(
      await resolveDiscussInterception({ text: CORRECTION, channel: "web", sessionId: null, pendingQuestions: new Map(), resolveThreadCard: resolve })
    ).toBeNull();
  });

  it("a board that throws never throws through - the turn runs ordinarily", async () => {
    const out = await resolveDiscussInterception({
      text: CORRECTION,
      channel: "web",
      sessionId: "t1",
      pendingQuestions: new Map(),
      resolveThreadCard: async () => {
        throw new Error("board unavailable");
      }
    });
    expect(out).toBeNull();
  });
});

// ── The pure readers ────────────────────────────────────────────────────────

describe("heldCardRoute", () => {
  it("reads the ask when no correction has landed (the go branch's old behaviour)", () => {
    expect(heldCardRoute(HELD)).toMatchObject({
      corrected: false,
      flow: "image",
      duty: "image",
      level: 2,
      tier: "T1-standard",
      decisionId: "dec-1",
      resumeList: "image"
    });
  });

  it("prefers the run spec once a correction re-stamped it", () => {
    const corrected = { ...HELD, routing: { flow: "discussion", duty: "discuss", level: 1, tier: "T0-trivial" } };
    expect(heldCardRoute(corrected)).toMatchObject({
      corrected: true,
      flow: "discussion",
      duty: "discuss",
      level: 1,
      tier: "T0-trivial"
    });
  });

  it("a run spec with no duty is not a correction", () => {
    const pinned = { ...HELD, routing: { target: "cc-opus" } };
    expect(heldCardRoute(pinned).corrected).toBe(false);
    expect(heldCardRoute(pinned).duty).toBe("image");
  });

  it("survives a bare card", () => {
    expect(heldCardRoute(null)).toMatchObject({ corrected: false, duty: null, level: null });
  });
});

describe("raisableDutyLevels", () => {
  it("drops an entry that would LOWER a level the card already holds", () => {
    // The board refuses a lower with a 400 that would take the whole re-stamp
    // with it, and a correction that re-routes DOWN is the common case.
    expect(raisableDutyLevels({ image: 1 }, { image: 2 })).toBeNull();
    expect(raisableDutyLevels({ discuss: 1, image: 1 }, { image: 2 })).toEqual({ discuss: 1 });
  });

  it("keeps an add and a raise", () => {
    expect(raisableDutyLevels({ discuss: 1 }, { image: 2 })).toEqual({ discuss: 1 });
    expect(raisableDutyLevels({ image: 3 }, { image: 2 })).toEqual({ image: 3 });
    expect(raisableDutyLevels({ image: 2 }, null)).toEqual({ image: 2 });
  });

  it("is null for nothing usable", () => {
    expect(raisableDutyLevels(null, {})).toBeNull();
    expect(raisableDutyLevels({ image: "2" as unknown as number }, {})).toBeNull();
  });
});

describe("patchHeldCardRouting", () => {
  it("PATCHes the run spec in engine context and never moves the card", async () => {
    const calls: { url: string; init?: any }[] = [];
    const fetchImpl = async (url: string, init?: any) => {
      calls.push({ url, init });
      if (!init) return { ok: true, json: async () => ({ card: { rev: 7 } }) };
      return { ok: true, status: 200, json: async () => ({ card: { id: "01HELD", rev: 8 } }) };
    };
    const out = await patchHeldCardRouting({
      base: "http://127.0.0.1:8081",
      id: "01HELD",
      routing: { flow: "discussion", duty: "discuss", level: 1, tier: "T0-trivial" },
      dutyLevels: { discuss: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.ok).toBe(true);
    const write = calls.find((c) => c.init?.method === "PATCH")!;
    expect(write.init.headers["x-garrison-engine"]).toBe("gateway");
    const body = JSON.parse(write.init.body);
    expect(body).toMatchObject({ routing: { duty: "discuss", level: 1 }, dutyLevels: { discuss: 1 }, rev: 7 });
    // Moving the card is what RELEASES the hold - a correction must not.
    expect(body.list).toBeUndefined();
    expect(body.autonomyHeld).toBeUndefined();
  });

  it("reports a refusal instead of retrying into it", async () => {
    let patches = 0;
    const fetchImpl = async (_url: string, init?: any) => {
      if (!init) return { ok: true, json: async () => ({ card: { rev: 1 } }) };
      patches += 1;
      return { ok: false, status: 400, json: async () => ({ error: "duty-level-lowered", message: "would lower" }) };
    };
    const out = await patchHeldCardRouting({
      base: "http://127.0.0.1:8081",
      id: "01HELD",
      routing: { duty: "discuss", level: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out).toMatchObject({ ok: false, error: "would lower" });
    expect(patches).toBe(1);
  });

  it("a board that is not there is a real answer, not a throw", async () => {
    await expect(patchHeldCardRouting({ base: null, id: "x", routing: { duty: "d" } })).resolves.toMatchObject({ ok: false });
  });
});

// ── The learning signal ─────────────────────────────────────────────────────

describe("buildCorrectionRecord", () => {
  it("is an explicit-negative on the shape the ROUTER proposed", () => {
    const rec = buildCorrectionRecord({
      original: { flow: "image", duty: "image", level: 2, tier: "T1-standard" },
      applied: { flow: "discussion", duty: "discuss", level: 1, tier: "T0-trivial" },
      decisionId: "dec-1",
      sessionId: "t1",
      at: "2026-08-13T10:00:00.000Z"
    });
    expect(rec).toMatchObject({
      area: "orchestrator",
      question: "decision-verdict",
      answer: "wrong",
      decision_id: "dec-1",
      session_id: "t1",
      provenance: "decision-verdict",
      original: { flow: "image", duty: "image", level: 2 },
      applied: { flow: "discussion", duty: "discuss", level: 1 }
    });
    // The fold reads it, keys the track on the ORIGINAL shape, and counts both
    // halves as corrected because the correction named a new flow AND a new duty.
    const evidence = evidenceFromVerdict(rec);
    expect(evidence).toEqual([
      { category: "flow", shape: "image", signal: "explicit-negative", at: "2026-08-13T10:00:00.000Z" },
      { category: "level", shape: "image", signal: "explicit-negative", at: "2026-08-13T10:00:00.000Z" }
    ]);
  });

  it("names the route in the SAME words the first ask used", () => {
    const route = { flow: "discussion", duty: "discuss", level: 1 };
    expect(askQuestion({ ...route, band: "ask", reason: "cold-start" })).toContain(routePhrase(route));
    expect(routePhrase(route)).toBe("the discussion flow, duty discuss, level 1");
  });
});

// ── The whole correction, through the gateway ───────────────────────────────

const levels = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ description: `level ${i + 1}`, cell: { target: "cc-sonnet", effort: "medium" } }));

function dispatchModel() {
  const ids = ["develop", "image", "discuss", "other"];
  const duties: Record<string, unknown> = {};
  for (const id of ids) duties[id] = { id, title: id, description: `${id} work`, levels: levels(3) };
  return { duties, selectedDuties: ids };
}

describe("RoutedGateway.correctHeldCard", () => {
  let home: string;
  let compositionDir: string;
  const savedHome = process.env.GARRISON_HOME;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gar-correct-home-"));
    compositionDir = mkdtempSync(join(tmpdir(), "gar-correct-comp-"));
    // The dispatch's own routing-evidence line lands here too; without the dir the
    // append is swallowed as best-effort and the test would be asserting on a file
    // only its own fake writer ever created.
    mkdirSync(join(compositionDir, ".garrison"), { recursive: true });
    process.env.GARRISON_HOME = home;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = savedHome;
    for (const dir of [home, compositionDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  /** A gateway wired with a dispatcher whose single-shot call returns `pick`, and
   *  a fake board that records every write. */
  function boot(pick: Record<string, unknown>, boardOk = true) {
    const writes: any[] = [];
    const fetchImpl = async (url: string, init?: any) => {
      if (!init) return { ok: true, json: async () => ({ card: { rev: 3 } }) };
      writes.push({ url, body: JSON.parse(init.body), headers: init.headers });
      if (!boardOk) return { ok: false, status: 400, json: async () => ({ error: "engine-owned" }) };
      return { ok: true, status: 200, json: async () => ({ card: { id: "01HELD", rev: 4 } }) };
    };
    const gw = new RoutedGateway({
      // routing-core's appendDecision is the only core member this path uses.
      core: {
        appendDecision: async (file: string, record: unknown) => {
          const { appendFile, mkdir } = await import("node:fs/promises");
          await mkdir(join(compositionDir, ".garrison"), { recursive: true });
          await appendFile(file, JSON.stringify(record) + "\n", "utf8");
        }
      },
      config: {},
      compositionDir,
      compositionId: "fixture",
      decisionsFile: join(compositionDir, ".garrison", "decisions.jsonl"),
      nowFn: () => "2026-08-13T10:00:00.000Z",
      boardBase: "http://127.0.0.1:8081",
      dispatcher: { core: dispatchCore, model: dispatchModel(), call: async () => ({ ok: true, structured: pick }) }
    });
    (globalThis as any).fetch = fetchImpl;
    return { gw, writes };
  }

  it("re-dispatches over the ORIGINAL brief plus the correction, re-stamps, and keeps the hold", async () => {
    const { gw, writes } = boot({ duty: "discuss", level: 1, confidence: "high", reason: "the user is asking a question" });
    const out = await gw.correctHeldCard({ card: HELD, correction: CORRECTION, sessionId: "t1" });

    expect(out.ok).toBe(true);
    expect(out.applied).toMatchObject({ duty: "discuss", level: 1, tier: "T0-trivial" });
    expect(out.original).toMatchObject({ duty: "image", level: 2 });
    expect(out.unchanged).toBe(false);
    expect(out.phrase).toContain("duty discuss");

    const patch = writes.find((w) => w.headers?.["x-garrison-engine"] === "gateway")!;
    expect(patch.body.routing).toMatchObject({ duty: "discuss", level: 1, tier: "T0-trivial" });
    // The hold survives: no list move, no autonomyHeld write.
    expect(patch.body.list).toBeUndefined();
    expect(patch.body.autonomyHeld).toBeUndefined();
  });

  it("writes BOTH records - the decisions audit line and the explicit-negative signal", async () => {
    const { gw } = boot({ duty: "discuss", level: 1, confidence: "high" });
    await gw.correctHeldCard({ card: HELD, correction: CORRECTION, sessionId: "t1" });

    const decisions = readFileSync(join(compositionDir, ".garrison", "decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const audit = decisions.find((d) => d.kind === "autonomy-ask")!;
    expect(audit).toMatchObject({
      kind: "autonomy-ask",
      resolution: "corrected",
      cardId: "01HELD",
      duty: "discuss",
      level: 1,
      from: { duty: "image", level: 2 },
      decisionId: "dec-1"
    });
    // The raw correction never reaches the durable log; only the dispatch
    // evidence's digest does.
    expect(decisions.some((d) => JSON.stringify(d).includes("I was asking a question"))).toBe(false);

    const queue = join(home, "improver", "feedback-queue.jsonl");
    expect(existsSync(queue)).toBe(true);
    const signal = JSON.parse(readFileSync(queue, "utf8").trim());
    expect(signal).toMatchObject({ question: "decision-verdict", answer: "wrong", original: { duty: "image" }, applied: { duty: "discuss" } });
    expect(evidenceFromVerdict(signal).every((e: any) => e.signal === "explicit-negative" && e.shape === "image")).toBe(true);
  });

  it("says so honestly when the re-stamp is refused - and never re-stamps on a failed dispatch", async () => {
    const refused = boot({ duty: "discuss", level: 1 }, false);
    await expect(refused.gw.correctHeldCard({ card: HELD, correction: CORRECTION })).resolves.toMatchObject({
      ok: false,
      reason: "restamp-failed"
    });
    // Nothing was recorded as applied.
    expect(existsSync(join(compositionDir, ".garrison", "decisions.jsonl"))).toBe(true);
    const kinds = readFileSync(join(compositionDir, ".garrison", "decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).kind);
    expect(kinds).not.toContain("autonomy-ask");
  });

  it("a gateway with no routing inference wired fails honestly rather than guessing", async () => {
    const gw = new RoutedGateway({ config: {}, compositionDir, boardBase: "http://127.0.0.1:8081" });
    await expect(gw.correctHeldCard({ card: HELD, correction: CORRECTION })).resolves.toMatchObject({
      ok: false,
      reason: "dispatch-unavailable"
    });
  });

  it("an empty correction is not a correction", async () => {
    const { gw } = boot({ duty: "discuss", level: 1 });
    await expect(gw.correctHeldCard({ card: HELD, correction: "   " })).resolves.toMatchObject({ ok: false, reason: "no-correction" });
  });

  it("a correction that lands on the same route says so instead of announcing a change", async () => {
    const { gw } = boot({ duty: "image", level: 2, confidence: "high" });
    const out = await gw.correctHeldCard({ card: HELD, correction: "no, it really is an image task" });
    expect(out.ok).toBe(true);
    expect(out.unchanged).toBe(true);
  });
});
