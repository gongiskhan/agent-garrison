// S3c — steering (D9): classification, sidecars, board endpoint, engine re-stage,
// gateway flow.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "s3c-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "s3c-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "s3c-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore
import { classifySteering, parseSteering, steeringShortCircuit, steeringEvidence } from "../fittings/seed/dispatcher/lib/steer-core.mjs";
// @ts-ignore
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard, phaseTemplatesFrom } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard, loadCard, saveCard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore
import { processCard, buildCardPrompt } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore
import { readSteeringDirective, writeSteeringDirective, readSteeringMd } from "../fittings/seed/kanban-loop/lib/steering.mjs";
// @ts-ignore
import { readOriginEvents } from "../fittings/seed/kanban-loop/lib/origins.mjs";
// @ts-ignore
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

const CARD = (over: any = {}) => ({ title: "Add login", list: "implement", sequence: ["plan", "implement", "review", "test"], ...over });
const model: any = { version: 2, compositionId: "t", kanbanLists: ["plan", "implement", "review", "test"], sequences: { develop: { "2": ["plan", "implement", "review", "test"] } }, cells: {}, holds: {} };
const board = buildBoard(model, { templates: phaseTemplatesFrom(seedBoard()) });

let server: http.Server;
let base = "";
beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(board, KANBAN_DIR);
  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  // Board discovery for the gateway's getLiveCard / postSteer / cardsByOrigin.
  mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
  writeFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
async function post(path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

describe("steer-core classification", () => {
  it("short-circuits explicit phrasing (fyi -> absorb; re-plan / go back to <earlier> -> revisit)", async () => {
    expect((await classifySteering({ message: "fyi the API changed", card: CARD() })).action).toBe("absorb");
    const rp = await classifySteering({ message: "actually, re-plan this", card: CARD() });
    expect(rp).toMatchObject({ action: "revisit", revisitDuty: "plan", shortCircuit: true });
    expect((await classifySteering({ message: "go back to plan and add caching", card: CARD() })).revisitDuty).toBe("plan");
    // explicit revisit to a NON-earlier phase clamps to absorb
    expect((await classifySteering({ message: "redo review", card: CARD() })).action).toBe("absorb");
  });

  it("defaults to acknowledge with no classifier + no short-circuit", async () => {
    expect((await classifySteering({ message: "what's the status?", card: CARD() })).action).toBe("acknowledge");
  });

  it("uses the model (injected call) and CLAMPS out-of-vocab", async () => {
    const absorb = await classifySteering({ message: "use tabs", card: CARD(), call: async () => ({ ok: true, structured: { action: "absorb", confidence: "high" } }) });
    expect(absorb.action).toBe("absorb");
    const badRevisit = await classifySteering({ message: "x", card: CARD(), call: async () => ({ ok: true, structured: { action: "revisit", revisit_duty: "nope" } }) });
    expect(badRevisit.action).toBe("absorb"); // revisit target not earlier -> absorb
    const unknown = await classifySteering({ message: "x", card: CARD(), call: async () => ({ ok: true, structured: { action: "frobnicate" } }) });
    expect(unknown).toMatchObject({ action: "acknowledge", reason: "unclassifiable" });
    const revisit = await classifySteering({ message: "x", card: CARD(), call: async () => ({ ok: true, structured: { action: "revisit", revisit_duty: "plan" } }) });
    expect(revisit).toMatchObject({ action: "revisit", revisitDuty: "plan" });
  });

  it("routing evidence carries the digest, never the raw message", () => {
    const ev = steeringEvidence({ message: "SECRET user text", action: "absorb", confidence: "high", at: "t" });
    expect(ev.kind).toBe("steering");
    expect(JSON.stringify(ev)).not.toContain("SECRET");
    expect(ev.messageDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("board POST /cards/:id/steer", () => {
  it("absorb writes steering.md + a timeline event (no re-stage)", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ project: "p" }));
    const res = await post(`/cards/${c.id}/steer`, { message: "use the existing util", action: "absorb" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: "absorb", applied: false });
    expect(readSteeringMd(KANBAN_DIR, c.id)).toContain("use the existing util");
    const got = await loadCard(KANBAN_DIR, c.id);
    expect(got.list).toBe("implement"); // unchanged
    expect(got.events.some((e: any) => e.kind === "steering")).toBe(true);
  });

  it("revisit on an IDLE card re-stages immediately (applied:true)", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "review", project: "p" }));
    const res = await post(`/cards/${c.id}/steer`, { message: "go back to plan", action: "revisit", revisitDuty: "plan" });
    expect(res.body).toMatchObject({ action: "revisit", applied: true });
    const got = await loadCard(KANBAN_DIR, c.id);
    expect(got.list).toBe("plan"); // re-staged
    expect(got.events.some((e: any) => e.kind === "steering-restage")).toBe(true);
    expect(readSteeringDirective(KANBAN_DIR, c.id)).toBeNull(); // marked applied
  });

  it("revisit on a RUNNING card DEFERS (directive written, card stays)", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "review", project: "p" }));
    await saveCard(KANBAN_DIR, { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id, status: "running" });
    const res = await post(`/cards/${c.id}/steer`, { message: "go back to plan", action: "revisit", revisitDuty: "plan" });
    expect(res.body).toMatchObject({ action: "revisit", applied: false });
    const got = await loadCard(KANBAN_DIR, c.id);
    expect(got.list).toBe("review"); // NOT moved — deferred to the boundary
    expect(readSteeringDirective(KANBAN_DIR, c.id)).toMatchObject({ action: "revisit", revisitDuty: "plan", applied: false });
  });

  it("rejects an unknown action", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ project: "p" }));
    expect((await post(`/cards/${c.id}/steer`, { message: "x", action: "bogus" })).status).toBe(400);
  });
});

describe("engine boundary steering", () => {
  it("a pending revisit re-stages the card at the pre-dispatch boundary + origin event", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "review", project: "demo", duty: "develop", level: 2 }));
    // a pending revisit directive to an EARLIER phase
    writeSteeringDirective(KANBAN_DIR, c.id, { action: "revisit", revisitDuty: "plan", reason: "add caching", applied: false });
    let runFnCalled = false;
    const runFn = async () => {
      runFnCalled = true;
      return { reply: "review" };
    };
    const { card: next, outcome } = await processCard({ root: KANBAN_DIR, board, card: await loadCard(KANBAN_DIR, c.id).then((x: any) => ({ ...x, id: c.id })), runFn, cap: 10, model, cwd: KANBAN_DIR });
    expect(runFnCalled).toBe(false); // re-staged BEFORE dispatch
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("plan");
    expect(next.list).toBe("plan");
    expect(readSteeringDirective(KANBAN_DIR, c.id)).toBeNull(); // applied
    expect(readOriginEvents(KANBAN_DIR, "board").some((e: any) => e.kind === "steering")).toBe(true);
  });

  it("buildCardPrompt folds the steering guidance in", () => {
    const prompt = buildCardPrompt({
      list: { kind: "agent", title: "Implement", executePrompt: "do it" },
      card: CARD(),
      validNext: ["review"],
      steeringContext: "## 2026 [absorb]\nuse the shared cache helper",
      phase: "implement"
    });
    expect(prompt).toContain("Steering guidance from the origin");
    expect(prompt).toContain("use the shared cache helper");
  });
});

describe("gateway steering (RoutedGateway)", () => {
  it("runSteerClassification uses the injected steer fn", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] }, steer: async ({ card }: any) => ({ action: "revisit", revisitDuty: "plan", reason: "r", confidence: "high", card: card?.id }) });
    const out = await gw.runSteerClassification({ message: "go back to plan", card: CARD({ id: "C1" }) });
    expect(out).toMatchObject({ action: "revisit", revisitDuty: "plan" });
  });

  it("postSteer posts the directive to the board and returns the result", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "review", project: "p" }));
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    const posted = await gw.postSteer(c.id, { message: "go back to plan", action: "revisit", revisitDuty: "plan" });
    expect(posted).toMatchObject({ action: "revisit", applied: true });
    expect((await loadCard(KANBAN_DIR, c.id)).list).toBe("plan");
  });

  // fix1 (HIGH): a same-session follow-up hits the in-RAM attach path (cardId only, no
  // .card). classifyAttachSteering must fetch the live card and REACH classification.
  it("classifyAttachSteering resolves the live card from a cardId-only attach and reaches the classifier", async () => {
    const live = await createCard(KANBAN_DIR, CARD({ list: "implement", project: "p", duty: "develop", level: 2 }));
    // injected steer proves the wiring; the card was fetched from the board by id
    const injected = new RoutedGateway({ config: { taskTypes: [], tiers: [] }, steer: async ({ card }: any) => ({ action: "absorb", reason: "r", confidence: "high", _sawCard: card?.id }) });
    const out1 = await injected.classifyAttachSteering({ attached: { cardId: live.id }, origin: "web", message: "use the util" });
    expect(out1?.card?.id).toBe(live.id);
    expect(out1?.steer).toMatchObject({ action: "absorb", _sawCard: live.id });
    // default steer-core short-circuit on the fetched card's real sequence
    const real = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    const out2 = await real.classifyAttachSteering({ attached: { cardId: live.id }, origin: "web", message: "go back to plan and add caching" });
    expect(out2?.steer).toMatchObject({ action: "revisit", revisitDuty: "plan" });
    // a DONE card is not live -> null (falls through to a one-shot)
    const done = await createCard(KANBAN_DIR, CARD({ list: "done", project: "p" }));
    expect(await real.classifyAttachSteering({ attached: { cardId: done.id }, origin: "web", message: "go back to plan" })).toBeNull();
    // non-web -> null
    expect(await real.classifyAttachSteering({ attached: { cardId: live.id }, origin: "kanban", message: "x" })).toBeNull();
  });
});

describe("hardening", () => {
  it("fix2: the endpoint rejects a FORWARD revisit (revisitDuty:test on a card in plan)", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "plan", project: "p" }));
    const res = await post(`/cards/${c.id}/steer`, { message: "jump ahead", action: "revisit", revisitDuty: "test" });
    expect(res.status).toBe(400);
    expect((await loadCard(KANBAN_DIR, c.id)).list).toBe("plan"); // NOT moved forward
  });

  it("fix2: engine applyPendingRevisit skips a forward directive (marks it applied, no move)", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "plan", project: "demo", duty: "develop", level: 2 }));
    writeSteeringDirective(KANBAN_DIR, c.id, { action: "revisit", revisitDuty: "test", reason: "forward", applied: false });
    let ran = false;
    const runFn = async () => {
      ran = true;
      return { reply: "implement" };
    };
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    const { card: next } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model, cwd: KANBAN_DIR });
    expect(next.list).not.toBe("test"); // never marched forward
    expect(readSteeringDirective(KANBAN_DIR, c.id)).toBeNull(); // cleared (not-earlier)
    expect(ran).toBe(true); // proceeded to dispatch the current phase
  });

  it("fix3: a terminal transition clears a stranded pending directive", async () => {
    const c = await createCard(KANBAN_DIR, CARD({ list: "review", project: "p" }));
    writeSteeringDirective(KANBAN_DIR, c.id, { action: "revisit", revisitDuty: "plan", applied: false });
    expect(readSteeringDirective(KANBAN_DIR, c.id)).not.toBeNull();
    const disk = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    await saveCardCAS(KANBAN_DIR, { ...disk, list: "done" }, disk.rev ?? 0);
    expect(readSteeringDirective(KANBAN_DIR, c.id)).toBeNull(); // obsolete-terminal
    const raw = JSON.parse(readFileSync(join(KANBAN_DIR, "cards", c.id, "steering.json"), "utf8"));
    expect(raw).toMatchObject({ applied: true, appliedReason: "obsolete-terminal" });
  });
});
