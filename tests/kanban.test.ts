import { describe, it, expect, beforeAll, afterAll } from "vitest";

// The kanban unit suite. The run engine it used to exercise is gone
// (Conversations): no processCard, no processBatch, no parseNextList, no
// per-phase prompt. What is left here is the substrate that outlived it — the
// card store and its CAS discipline, the five-state board, and the board
// helpers the server still reads — plus the two invariants inherited from the
// suites that were deleted with the engine (policy load state; un-park
// recovery), which have no other home.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// S6 (D19): runDirs mint ABSOLUTE under the evidence home — sandbox it so
// tests never write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { ulid } from "../fittings/seed/kanban-loop/lib/ulid.mjs";
// @ts-ignore — pure .mjs
import {
  createCard,
  loadCard,
  saveCardCAS,
  deriveMembership,
  loadAllCards,
  coherentCardState,
  migrateBoard,
  BOARD_VERSION
  // @ts-ignore
} from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import {
  getList,
  validNextFor,
  triggerFor,
  isInteractive,
  mintRunFields,
  resolveBacklogInference,
  routeStamp
  // @ts-ignore
} from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { routeFromDone } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";
// @ts-ignore — pure .mjs
import { loadPolicy, resetPolicyCache, policyLoadState } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore — pure .mjs
import { unparkRecoveryFields } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

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


const tmp = () => mkdtempSync(join(tmpdir(), "kanban-"));

describe("kanban ulid (s5)", () => {
  it("is 26 chars and sorts by creation time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toHaveLength(26);
    expect(b).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});

describe("kanban board (s5 + v1b pointer fields)", () => {
  it("createCard writes a ULID-id card; loadCard reads it; membership is derived", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo", goalMode: true, acceptance: "ACC" });
    expect(c.id).toHaveLength(26);
    expect(c.list).toBe("todo");
    expect(c.status).toBe("ok");
    expect(c.iterations).toBe(0);
    expect(c.goalMode).toBe(true);
    expect((await loadCard(root, c.id)).title).toBe("T");
    expect(deriveMembership(await loadAllCards(root))).toEqual({ todo: [c.id] });
    expect(JSON.parse(readFileSync(join(root, "cards", c.id, "card.json"), "utf8")).id).toBe(c.id);
  });

  it("createCard seeds the V1b pointer fields as empty pointers (FINDING 10 — no inlined bodies)", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo" });
    expect(c.runId).toBeNull();
    expect(c.runDir).toBeNull();
    expect(c.sliceId).toBeNull();
    expect(c.sessionIds).toEqual([]);
    expect(c.briefPath).toBeNull();
    expect(c.videoUrl).toBeNull();
    // The card holds POINTERS only — no field carries a document body.
    const disk = JSON.parse(readFileSync(join(root, "cards", c.id, "card.json"), "utf8"));
    expect(Object.keys(disk)).toEqual(
      expect.arrayContaining(["runId", "runDir", "sliceId", "sessionIds", "briefPath", "videoUrl"])
    );
  });

  // Conversations: a card materialized from a conversation TAKES that
  // conversation's ULID as its id — one identity, one directory name — and
  // links back to it. Two ids for one piece of work is how the board and the
  // conversation store drift apart.
  it("createCard accepts an explicit id + conversationId (the materialization door)", async () => {
    const root = tmp();
    const conversationId = ulid(3000);
    const c = await createCard(root, { id: conversationId, conversationId, title: "materialized", list: "todo" });
    expect(c.id).toBe(conversationId);
    expect(c.conversationId).toBe(conversationId);
    expect((await loadCard(root, conversationId)).conversationId).toBe(conversationId);
  });

  it("an unlinked card carries conversationId null (it is a link, never a default)", async () => {
    const root = tmp();
    expect((await createCard(root, { title: "bare", list: "todo" })).conversationId).toBeNull();
  });
});

// list ⟷ status coherence. The lists ARE the states now, `card.list` is
// authoritative, and `status` is derived from it at the one write choke point —
// so the store's re-derivation of promoted columns from body_json agrees by
// construction instead of by everyone remembering to set both.
describe("kanban list ⟷ status coherence (the write choke point)", () => {
  it("running and needs-attention mirror onto status", () => {
    expect(coherentCardState({ list: "running", status: "ok" }).status).toBe("running");
    expect(coherentCardState({ list: "needs-attention", status: "ok" }).status).toBe("needs-attention");
  });

  it("any other list clears a stale running / needs-attention status", () => {
    expect(coherentCardState({ list: "todo", status: "running" }).status).toBe("ok");
    expect(coherentCardState({ list: "done", status: "needs-attention" }).status).toBe("ok");
    expect(coherentCardState({ list: "done", status: "ok" }).status).toBe("ok");
  });

  it("is applied by the CAS write, not left to the caller", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo" });
    // A caller moving the card to Running and forgetting the status must not be
    // able to produce a card the board reads as idle while it sits in Running.
    const saved = await saveCardCAS(root, { ...c, list: "running" }, c.rev);
    expect(saved.ok).toBe(true);
    expect(saved.card.status).toBe("running");
    expect((await loadCard(root, c.id)).status).toBe("running");
  });
});

describe("kanban CAS (s5 cross-model gate — lost-update guard)", () => {
  it("saveCardCAS rejects a stale-rev write so a concurrent tick / manual edit is not clobbered", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo" });
    expect(c.rev).toBe(0);
    const w1 = await saveCardCAS(root, { ...c, title: "A" }, 0);
    expect(w1.ok).toBe(true);
    expect(w1.card.rev).toBe(1);
    const w2 = await saveCardCAS(root, { ...c, title: "B" }, 0);
    expect(w2.ok).toBe(false);
    expect(w2.conflict).toBe(true);
    expect((await loadCard(root, c.id)).title).toBe("A");
  });

  it("CONCURRENT saveCardCAS at the same rev — the per-card O_EXCL lock lets EXACTLY one win (no double-acquire)", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "T", list: "todo" });
    // Fire many racing CAS writes that all read rev 0. The lock serializes the
    // read-compare-write, so exactly one observes rev 0 and commits; the rest see the
    // bumped rev and conflict. This is the double-acquire / double-mint guard.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => saveCardCAS(root, { ...c, title: `w${i}` }, 0))
    );
    const ok = results.filter((r: any) => r.ok);
    const conflicts = results.filter((r: any) => !r.ok && r.conflict);
    expect(ok.length).toBe(1);
    expect(conflicts.length).toBe(7);
    expect((await loadCard(root, c.id)).rev).toBe(1); // bumped exactly once
  });

  // The Done invariant (Conversations). The engine transitions that used to
  // police evidence are gone, so the WRITE polices it: a conversation-linked
  // card entering Done owes a terminal handoff. A card with no conversation
  // (hand-managed, personal, pre-Conversations) owes nothing at this door.
  it("a conversation-linked card cannot be written to Done without a terminal handoff", async () => {
    const root = tmp();
    const conversationId = ulid(4000);
    const c = await createCard(root, { id: conversationId, conversationId, title: "unproven", list: "todo" });
    const refused = await saveCardCAS(root, { ...c, list: "done" }, c.rev);
    expect(refused.ok).toBe(false);
    expect(refused.precondition).toBe(true);
    expect(refused.detail).toMatchObject({ code: "evidence-required" });
    expect((await loadCard(root, c.id)).list).toBe("todo");
  });

  it("an UNLINKED card still moves to Done freely (the door is scoped to conversations)", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "hand-managed", list: "todo" });
    const saved = await saveCardCAS(root, { ...c, list: "done" }, c.rev);
    expect(saved.ok).toBe(true);
    expect(saved.card.list).toBe("done");
  });

  it("a human override passes but is recorded as UNPROVEN, never as a pass", async () => {
    const root = tmp();
    const conversationId = ulid(5000);
    const c = await createCard(root, { id: conversationId, conversationId, title: "overridden", list: "todo" });
    const saved = await saveCardCAS(
      root,
      { ...c, list: "done", completionOverride: { reason: "verified by hand off-board" } },
      c.rev
    );
    expect(saved.ok).toBe(true);
    expect(saved.card.list).toBe("done");
    expect(saved.card.completionOverride.reason).toBe("verified by hand off-board");
  });
});

// The state-column board. Not a pipeline: a card's LIST is where the work stands,
// and validNext is the human move-affordance (the Move menu / drag targets),
// never a routing edge. Sequencing lives in the stretch handoff's nextSteps.
describe("kanban seed board — the six state columns", () => {
  const seeded = seedBoard();
  const byId = Object.fromEntries(seeded.lists.map((l: any) => [l.id, l]));

  it("is exactly six lists, in order, with the exact ids", () => {
    expect(seeded.lists.map((l: any) => l.id)).toEqual([
      "backlog", "todo", "running", "needs-attention", "scheduled", "done"
    ]);
    expect(seeded.version).toBe(BOARD_VERSION);
  });

  it("Backlog is a purely human shelf — manual, no trigger hooks, no automation", () => {
    // Work parked for later. The engine never picks from it: no onEnter, no
    // notify, not system-owned — a card sits there until a human moves it.
    expect(byId.backlog).toMatchObject({ kind: "manual", trigger: "manual" });
    expect(byId.backlog.onEnter).toBeUndefined();
    expect(byId.backlog.system).toBeUndefined();
    expect(byId.backlog.terminal).toBeUndefined();
    expect(byId.backlog.validNext).toEqual(["todo", "done"]);
  });

  it("carries no duty column, no discuss, no archived — the pipeline is gone", () => {
    const ids = new Set(seeded.lists.map((l: any) => l.id));
    for (const retired of [
      "discuss", "plan", "implement", "review", "adversarial-review",
      "test", "adversarial-test", "walkthrough", "validate", "archived", "ice-box"
    ]) {
      expect(ids.has(retired), `${retired} is still on the board`).toBe(false);
    }
    // …and no list carries a phase pin or a duty title any more.
    for (const l of seeded.lists) {
      expect(l.phase).toBeUndefined();
      expect(l.skill).toBeUndefined();
      expect(String(l.title).startsWith("duty: ")).toBe(false);
    }
  });

  it("Running is a SYSTEM list driven by the launcher, not an agent list", () => {
    // `kind: "system"` is load-bearing: every legacy `kind === "agent"` branch is
    // false for it, so no stray dispatch path can fire on Running by accident.
    expect(byId.running).toMatchObject({ kind: "system", trigger: "launcher", system: true });
    expect(seeded.lists.some((l: any) => l.kind === "agent")).toBe(false);
    // Its edges are rescue exits for a wedged card, not a pipeline.
    expect(byId.running.validNext).toEqual(["needs-attention", "todo"]);
  });

  it("keeps Scheduled a scheduler-beat system column and Done terminal", () => {
    expect(byId.scheduled).toMatchObject({ kind: "scheduled", trigger: "scheduler-beat", system: true });
    expect(byId.scheduled.validNext).toEqual(["todo"]);
    expect(byId.done).toMatchObject({ kind: "manual", terminal: true });
    // Done is not a dead end: reopening a card puts it back on To do or the shelf.
    expect(byId.done.validNext).toEqual(["todo", "backlog"]);
  });

  it("Needs input notifies on entry and hands the card back to a human", () => {
    expect(byId["needs-attention"].title).toBe("Needs input");
    expect(byId["needs-attention"].notifyOnEntry).toBe(true);
    expect(byId["needs-attention"].validNext).toEqual(["todo", "backlog", "done"]);
  });

  it("To do infers title + project on entry and is the default landing list", () => {
    expect(byId.todo).toMatchObject({ kind: "manual", trigger: "manual", onEnter: "infer-title-and-project" });
    expect(byId.todo.validNext).toEqual(["backlog", "done"]);
  });

  it("every validNext token is a real list id", () => {
    const ids = new Set(seeded.lists.map((l: any) => l.id));
    for (const l of seeded.lists) {
      for (const n of l.validNext || []) expect(ids.has(n), `${l.id} → ${n}`).toBe(true);
    }
  });

  it("nothing but the migration script crosses the v10 guard", () => {
    // migrateBoard heals a legacy board on read but leaves it stamped at most 9
    // (the v9→v10 step is a CARD migration, run once by
    // scripts/migrate-conversations.mjs). A fresh seed is already current.
    const healed = migrateBoard({ version: 5, lists: [{ id: "todo", title: "To Do", kind: "manual" }] });
    expect(healed.version).toBe(9);
    expect(seedBoard().version).toBe(BOARD_VERSION);
  });

  it("migrateBoard adds Backlog to a v10 board on read (v10→v11 is additive)", () => {
    const v10 = {
      version: 10,
      lists: [
        { id: "todo", title: "To do", kind: "manual", order: 0, validNext: ["done"] },
        { id: "running", title: "Running", kind: "system", order: 1, validNext: ["needs-attention", "todo"] },
        { id: "needs-attention", title: "Needs input", kind: "manual", order: 2, validNext: ["todo", "done"] },
        { id: "scheduled", title: "Scheduled", kind: "scheduled", order: 3, validNext: ["todo"] },
        { id: "done", title: "Done", kind: "manual", terminal: true, order: 4, validNext: ["todo"] }
      ]
    };
    const migrated = migrateBoard(v10);
    expect(migrated.version).toBe(BOARD_VERSION);
    const ordered = [...migrated.lists].sort((a: any, b: any) => a.order - b.order).map((l: any) => l.id);
    expect(ordered).toEqual(["backlog", "todo", "running", "needs-attention", "scheduled", "done"]);
    const backlog = migrated.lists.find((l: any) => l.id === "backlog");
    expect(backlog).toMatchObject({ kind: "manual", trigger: "manual", validNext: ["todo", "done"] });
    // The five existing columns keep their exact positions; edges gain the shelf.
    const todo = migrated.lists.find((l: any) => l.id === "todo");
    expect(todo.order).toBe(0);
    expect(todo.validNext).toEqual(["backlog", "done"]);
    // Idempotent: a second pass changes nothing.
    expect(migrateBoard(migrated)).toEqual(migrated);
  });
});

describe("kanban board helpers the server still reads", () => {
  const seeded = seedBoard();

  it("getList / validNextFor resolve a list and its move affordances", () => {
    expect(getList(seeded, "running").id).toBe("running");
    expect(getList(seeded, "nope")).toBeNull();
    expect(validNextFor(seeded, "needs-attention")).toEqual(["todo", "backlog", "done"]);
    expect(validNextFor(seeded, "nope")).toEqual([]); // unknown list = no affordances, never a throw
  });

  it("triggerFor reports each list's trigger, defaulting by kind", () => {
    expect(triggerFor(getList(seeded, "running"))).toBe("launcher");
    expect(triggerFor(getList(seeded, "todo"))).toBe("manual");
    expect(triggerFor(getList(seeded, "scheduled"))).toBe("scheduler-beat");
    expect(triggerFor({ kind: "agent" })).toBe("immediate"); // no trigger field → immediate
    expect(triggerFor({ kind: "manual" })).toBe("manual");
  });

  it("isInteractive is false for every list on the five-state board", () => {
    // It survives because the D16 lock still reads it (an interactive list is
    // never engine-owned). No five-state list is interactive, so it only ever
    // answers for a legacy board.
    for (const l of seeded.lists) expect(isInteractive(l)).toBe(false);
    expect(isInteractive({ kind: "agent-interactive", interactive: true })).toBe(true);
  });
});

// Corrupt policy must FAIL SAFE. loadPolicy() returning null looks identical to
// policy-less mode from the outside, and the difference decides whether a caller
// degrades deliberately or degrades because a file got truncated — which is why
// the load STATE is a first-class read, not an inference from a null.
describe("policy load state (fail-safe distinction)", () => {
  it("distinguishes ok / absent / corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-policy-"));
    const valid = join(dir, "policy.json");
    writeFileSync(valid, JSON.stringify({ version: 4, targets: {} }), "utf8");
    process.env.GARRISON_POLICY_PATH = valid;
    resetPolicyCache();
    expect(policyLoadState()).toBe("ok");

    process.env.GARRISON_POLICY_PATH = join(dir, "does-not-exist.json");
    resetPolicyCache();
    expect(policyLoadState()).toBe("absent");

    const corrupt = join(dir, "corrupt-policy.json");
    writeFileSync(corrupt, "{ this is : not json ]", "utf8");
    process.env.GARRISON_POLICY_PATH = corrupt;
    resetPolicyCache();
    expect(policyLoadState()).toBe("corrupt");
    // Both non-ok states read as a null policy — the state is the only signal.
    expect(loadPolicy()).toBeNull();

    process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
    resetPolicyCache();
  });
});

// Un-parking is a fresh retry, and the one thing it must decide is whether the
// previous attempt's context comes with it. `retryKeepsContext` is set when a
// run parked with work worth resuming; every OTHER recovery path (a manual move
// out of Needs input, Start, the API) must stay marker-free — fail closed, so a
// retry never silently inherits a run directory nobody asked it to reuse.
describe("un-park recovery fields", () => {
  it("preserves the phase runDir + clears the flag when retryKeepsContext is set", () => {
    const patch = unparkRecoveryFields({
      retryKeepsContext: true,
      runDir: "/home/x/.garrison/runs/no-project/ABC",
      iterations: 5
    });
    expect(patch.runDir).toBe("/home/x/.garrison/runs/no-project/ABC");
    expect(patch.retryKeepsContext).toBe(false); // consumed
    expect(patch.iterations).toBe(0); // counter still resets (re-cap avoidance)
    expect(patch.attentionReason).toBeNull();
    expect(patch).not.toHaveProperty("coordinationRecoveryPending");
  });

  it("a normal un-park (no flag) does not touch runDir/retryKeepsContext", () => {
    const patch = unparkRecoveryFields({ iterations: 3 });
    expect(patch).not.toHaveProperty("runDir");
    expect(patch).not.toHaveProperty("retryKeepsContext");
    expect(patch).not.toHaveProperty("coordinationRecoveryPending");
    expect(patch.iterations).toBe(0);
  });

  it("keeps PATCH/Start/manual-list recovery marker-free under the fail-closed contract", () => {
    const patch = unparkRecoveryFields({
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "implement",
      iterations: 2
    });
    expect(patch).not.toHaveProperty("coordinationRecoveryPending");
    expect(patch).toMatchObject({ attentionReason: null, parkedFrom: null, iterations: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exported engine helpers with NO caller left in production after the cut.
// They still exist, are still exported from engine.mjs, and still behave as
// specified — so the tests stay honest and green — but nothing in the fitting
// invokes them. Reported to the Conversations cut as dead-surface candidates:
// mintRunFields, routeStamp, resolveBacklogInference, buildContinuationContext.
// If a sweep removes them, delete this block with them; do NOT quietly re-wire
// something to keep it alive.
// ─────────────────────────────────────────────────────────────────────────────
describe("orphaned engine helpers (behaviour pinned, callers gone)", () => {
  it("mintRunFields mints once, absolute, under the evidence home", () => {
    const m = mintRunFields({ runId: null, runDir: null }, () => 1234);
    expect(m.runId).toHaveLength(26);
    expect(m.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "no-project", m.runId)); // S6: absolute
    // already minted → null (no re-mint)
    expect(mintRunFields({ runId: "X", runDir: "docs/autothing/runs/X" })).toBeNull();
  });

  it("mintRunFields puts personal evidence under runs/personal while a real project still wins", () => {
    const personal = mintRunFields({ scope: "personal", project: null, runId: null, runDir: null }, () => 1235);
    expect(personal.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "personal", personal.runId));

    const project = mintRunFields({ scope: "personal", project: "garrison", runId: null, runDir: null }, () => 1236);
    expect(project.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "garrison", project.runId));

    const routedProject = mintRunFields({
      scope: "personal",
      project: null,
      routing: { project: "ekoa-code" },
      runId: null,
      runDir: null
    }, () => 1237);
    expect(routedProject.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "ekoa-code", routedProject.runId));

    const refusedProject = mintRunFields({
      scope: "personal",
      project: "/",
      runId: null,
      runDir: null
    }, () => 1238);
    expect(refusedProject.runDir).toBe(join(process.env.GARRISON_RUNS_DIR!, "no-project", refusedProject.runId));
  });

  it("routeStamp builds the compact stamp + human suffix, and no-ops on empty metadata", () => {
    const { route, suffix } = routeStamp({ targetId: "claude-code", runtime: "claude-code", provider: "anthropic", model: "opus", effort: "high", effortApplied: true, tier: "T2-deep" }, "plan");
    expect(route).toMatchObject({ targetId: "claude-code", runtime: "claude-code", model: "opus", effort: "high", effortApplied: true, tier: "T2-deep", phase: "plan" });
    expect(suffix).toBe(" · claude-code/opus (T2-deep · high)");
    expect(routeStamp({ targetId: "gemini", runtime: "gemini", effort: "high", effortApplied: false }, "image").route).toMatchObject({
      effort: "high",
      effortApplied: false,
      phase: "image",
    });
    // No metadata → no stamp, no suffix (never fail a run for want of attribution).
    expect(routeStamp(null, "plan")).toEqual({ route: null, suffix: "" });
    expect(routeStamp({ targetId: null, runtime: null, provider: null, model: null, tier: null }, "plan")).toEqual({ route: null, suffix: "" });
  });

  it("resolveBacklogInference applies an inferred project only at >=70% confidence", () => {
    const card = { title: "(untitled)", project: null, status: "ok" };
    const confident = resolveBacklogInference(card, { title: "Add login", project: "garrison", projectConfidence: 0.82 });
    expect(confident.park).toBe(false);
    expect(confident.card.title).toBe("Add login");
    expect(confident.card.project).toBe("garrison");

    const lowConf = resolveBacklogInference(card, { title: "Add login", project: "garrison", projectConfidence: 0.4 });
    expect(lowConf.park).toBe(true);
    expect(lowConf.reason).toBe("low-confidence-project");
    expect(lowConf.card.title).toBe("Add login"); // title still inferred eagerly
    expect(lowConf.card.project).toBeNull();
    expect(lowConf.card.status).toBe("needs-attention");

    // No project inferred at all parks even at full confidence.
    expect(resolveBacklogInference({ title: "x", project: null }, { title: "T", project: null, projectConfidence: 0.99 }).park).toBe(true);
  });
});

// routeFromDone is NOT orphaned: the gateway's `done` payload is still the only
// place a card learns which model actually served it, and the card is the only
// durable record of it.
describe("kanban route attribution — routeFromDone", () => {
  it("folds a routed `done` payload; null when the payload carries no route", () => {
    expect(routeFromDone({ reply: "x" })).toBeNull();
    expect(routeFromDone(null)).toBeNull();
    const r = routeFromDone({ reply: "x", route: "claude-code", runtime: "claude-code", model: "opus", effort: "high", effortApplied: true, tier: "T2-deep", honored: true });
    expect(r).toMatchObject({ targetId: "claude-code", runtime: "claude-code", model: "opus", effort: "high", effortApplied: true, tier: "T2-deep", honored: true });
    // Requested-vs-applied truth must retain false (unsupported), never coerce it
    // to null/true while crossing the SSE boundary.
    expect(routeFromDone({ route: "gemini", effort: "high", effortApplied: false })).toMatchObject({
      targetId: "gemini",
      effort: "high",
      effortApplied: false,
    });
  });
});
