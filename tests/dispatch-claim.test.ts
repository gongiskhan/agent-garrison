// Outpost Dispatch — claim selection and lease rules.
//
// These are the rules that decide whether two machines can end up running the
// same card, or whether a card can be stranded on a dead one. They are pure
// functions precisely so they can be tested without a board, a worker, or a Mac.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  claimability,
  findExpiredClaims,
  isLeaseExpired,
  parsePlacement,
  selectClaimable,
  buildJob,
  buildDutyPrompt,
  claimRevisionMatches,
  DISPATCH_LEASE_SECONDS,
  type CardDispatch,
  type ClaimableCard
} from "@/lib/dispatch";

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


const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const MACHINE = "goncalos-mac-mini-1";

function card(over: Partial<ClaimableCard> = {}): ClaimableCard {
  return {
    id: "01KY000000000000000000001",
    title: "stub",
    list: "implement",
    level: 2,
    sequence: ["implement", "review", "done"],
    project: "garrison",
    scope: "project",
    rev: 3,
    placement: { target: MACHINE },
    dispatch: null,
    command: "echo hi",
    description: null,
    acceptance: null,
    duty: null,
    goalMode: false,
    ...over
  };
}

function claim(over: Partial<CardDispatch> = {}): CardDispatch {
  return {
    machine: MACHINE,
    workerId: "w1",
    claimedAt: new Date(NOW - 10_000).toISOString(),
    heartbeatAt: new Date(NOW - 10_000).toISOString(),
    state: "running",
    ...over
  };
}

describe("parsePlacement", () => {
  it("defaults to host when absent or malformed", () => {
    // The failure mode of a typo must be "runs here as usual", never "eligible
    // on every machine".
    expect(parsePlacement(undefined).target).toBe("host");
    expect(parsePlacement(null).target).toBe("host");
    expect(parsePlacement({}).target).toBe("host");
    expect(parsePlacement({ target: "" }).target).toBe("host");
    expect(parsePlacement({ target: 42 }).target).toBe("host");
    expect(parsePlacement("mac-mini").target).toBe("host");
  });

  it("keeps a real target and not_before", () => {
    const p = parsePlacement({ target: " mac-mini ", not_before: "2026-07-27T13:00:00Z" });
    expect(p.target).toBe("mac-mini");
    expect(p.not_before).toBe("2026-07-27T13:00:00Z");
  });
});

describe("claimability", () => {
  it("claims a ready card targeted at this machine", () => {
    expect(claimability(card(), MACHINE, NOW).claimable).toBe(true);
  });

  it("never claims a host-targeted card", () => {
    const verdict = claimability(card({ placement: { target: "host" } }), MACHINE, NOW);
    expect(verdict.claimable).toBe(false);
    expect(verdict.reason).toContain("host");
  });

  it("never claims another machine's card", () => {
    expect(claimability(card({ placement: { target: "other-mac" } }), MACHINE, NOW).claimable).toBe(
      false
    );
  });

  it.each(["done", "needs-attention"])("never claims from terminal list %s", (list) => {
    expect(claimability(card({ list }), MACHINE, NOW).claimable).toBe(false);
  });

  it.each(["backlog", "discuss"])("never claims from manual list %s", (list) => {
    // A card a human has not started is not work; pulling it would start runs
    // nobody asked for.
    expect(claimability(card({ list }), MACHINE, NOW).claimable).toBe(false);
  });

  it("holds a card until not_before passes", () => {
    const future = { target: MACHINE, not_before: new Date(NOW + 60_000).toISOString() };
    expect(claimability(card({ placement: future }), MACHINE, NOW).claimable).toBe(false);
    expect(claimability(card({ placement: future }), MACHINE, NOW + 61_000).claimable).toBe(true);
  });

  it("HOLDS rather than releases a card whose not_before is unparseable", () => {
    // Fail closed: a scheduled card running early is worse than one that waits
    // for a human to look at it.
    const bad = { target: MACHINE, not_before: "next tuesday" };
    expect(claimability(card({ placement: bad }), MACHINE, NOW).claimable).toBe(false);
  });

  it("does not claim a card whose claim is alive", () => {
    const verdict = claimability(card({ dispatch: claim() }), MACHINE, NOW);
    expect(verdict.claimable).toBe(false);
    expect(verdict.reason).toContain("held by");
  });

  it("reclaims a card whose lease expired", () => {
    const dead = claim({ heartbeatAt: new Date(NOW - (DISPATCH_LEASE_SECONDS + 5) * 1000).toISOString() });
    const verdict = claimability(card({ dispatch: dead }), MACHINE, NOW);
    expect(verdict.claimable).toBe(true);
    expect(verdict.reason).toContain("lease expired");
  });

  it("re-claims after a terminal dispatch state", () => {
    // A failed card moved back out of needs-attention is a fresh retry.
    expect(claimability(card({ dispatch: claim({ state: "failed" }) }), MACHINE, NOW).claimable).toBe(
      true
    );
  });
});

describe("isLeaseExpired", () => {
  it("treats a missing/garbled heartbeat as expired", () => {
    // Otherwise a malformed claim record would pin a card forever.
    expect(isLeaseExpired(claim({ heartbeatAt: "", claimedAt: "" }), NOW, 180)).toBe(true);
    expect(isLeaseExpired(claim({ heartbeatAt: "nonsense", claimedAt: "" }), NOW, 180)).toBe(true);
  });

  it("falls back to claimedAt when no heartbeat has landed yet", () => {
    const fresh = claim({ heartbeatAt: "", claimedAt: new Date(NOW - 1000).toISOString() });
    expect(isLeaseExpired(fresh, NOW, 180)).toBe(false);
  });
});

describe("selectClaimable", () => {
  it("is FIFO by card id, so two racing workers pick the same card", () => {
    // Determinism matters: if two workers picked DIFFERENT cards there would be
    // no contention to resolve, but a machine could starve. Picking the same one
    // and letting rev-CAS decide is the behaviour we want.
    const cards = [
      card({ id: "01KY000000000000000000003" }),
      card({ id: "01KY000000000000000000001" }),
      card({ id: "01KY000000000000000000002" })
    ];
    expect(selectClaimable(cards, MACHINE, NOW)?.id).toBe("01KY000000000000000000001");
    expect(selectClaimable([...cards].reverse(), MACHINE, NOW)?.id).toBe("01KY000000000000000000001");
  });

  it("returns null when nothing is claimable", () => {
    expect(selectClaimable([card({ placement: { target: "host" } })], MACHINE, NOW)).toBeNull();
    expect(selectClaimable([], MACHINE, NOW)).toBeNull();
  });

  it("skips a live claim and takes the next card", () => {
    const cards = [
      card({ id: "01KY000000000000000000001", dispatch: claim() }),
      card({ id: "01KY000000000000000000002" })
    ];
    expect(selectClaimable(cards, MACHINE, NOW)?.id).toBe("01KY000000000000000000002");
  });
});

describe("findExpiredClaims", () => {
  it("finds only live-but-silent claims", () => {
    const stale = new Date(NOW - (DISPATCH_LEASE_SECONDS + 5) * 1000).toISOString();
    const cards = [
      card({ id: "01KY000000000000000000001", dispatch: claim({ heartbeatAt: stale }) }),
      card({ id: "01KY000000000000000000002", dispatch: claim() }),
      // Terminal states are not "silent", they are finished.
      card({ id: "01KY000000000000000000003", dispatch: claim({ heartbeatAt: stale, state: "done" }) }),
      card({ id: "01KY000000000000000000004", dispatch: null })
    ];
    expect(findExpiredClaims(cards, NOW).map((c) => c.id)).toEqual(["01KY000000000000000000001"]);
  });
});

describe("buildJob", () => {
  it("carries the command and the lease terms", () => {
    const job = buildJob(card(), { claimRevision: 4 })!;
    expect(job.run).toEqual({ kind: "command", command: "echo hi" });
    expect(job.leaseSeconds).toBe(DISPATCH_LEASE_SECONDS);
    expect(job.heartbeatSeconds).toBeLessThan(job.leaseSeconds);
    expect(job.claimRevision).toBe(4);
    expect(job.scope).toBe("project");
  });

  // A literal command was once the ONLY runnable payload: buildJob returned null
  // for anything else, so an agentic card placed on a machine was skipped
  // forever - the worker polled, saw nothing claimable, and the card sat on the
  // board looking dispatched while nothing intended to run it.
  it("builds a DUTY run for an agentic card (no literal command)", () => {
    const job = buildJob(card({ command: null, duty: "implement" }))!;
    expect(job).not.toBeNull();
    expect(job.run.kind).toBe("duty");
    if (job.run.kind !== "duty") throw new Error("expected a duty run");
    expect(job.run.duty).toBe("implement");
    expect(job.run.prompt).toContain("stub");        // the title
    expect(job.run.prompt).toContain("garrison");    // the project
  });

  it("falls back to the card's list when it names no duty", () => {
    const job = buildJob(card({ command: null, duty: null, list: "review" }))!;
    if (job.run.kind !== "duty") throw new Error("expected a duty run");
    expect(job.run.duty).toBe("review");
  });

  it("prefers an explicit command over the duty lane", () => {
    // The zero-token stub lane stays the cheapest way to smoke test a machine.
    const job = buildJob(card({ command: "echo probe", duty: "implement" }))!;
    expect(job.run).toEqual({ kind: "command", command: "echo probe" });
  });

  it("carries personal scope so the worker selects its managed workspace", () => {
    const job = buildJob(card({ project: null, scope: "personal", command: null, duty: "plan" }))!;
    expect(job.scope).toBe("personal");
    expect(job.project).toBeNull();
  });
});

describe("claim revision identity", () => {
  it("accepts only the revision tracked by the active claim", () => {
    const dispatch = claim({ claimRevision: 7 });
    expect(claimRevisionMatches(7, dispatch)).toBe(true);
    expect(claimRevisionMatches(8, dispatch)).toBe(false);
    expect(claimRevisionMatches(7, claim({ claimRevision: undefined }))).toBe(false);
  });
});

describe("buildDutyPrompt", () => {
  it("states the work item, acceptance, and where the agent is running", () => {
    const p = buildDutyPrompt(card({
      command: null,
      title: "Add a health endpoint",
      description: "Return 200 with a version string.",
      acceptance: "GET /health returns 200."
    }));
    expect(p).toContain("# Work item: Add a health endpoint");
    expect(p).toContain("Return 200 with a version string.");
    expect(p).toContain("# Acceptance");
    expect(p).toContain("GET /health returns 200.");
    expect(p).toContain("OUTPOST");
  });

  it("says the project must be inferred when the card has none", () => {
    const p = buildDutyPrompt(card({ command: null, project: null }));
    expect(p).toMatch(/none assigned/i);
  });

  it("never leaves a goalMode card without a definition of done", () => {
    const p = buildDutyPrompt(card({ command: null, goalMode: true, acceptance: null }));
    expect(p).toContain("# Acceptance");
  });
});
