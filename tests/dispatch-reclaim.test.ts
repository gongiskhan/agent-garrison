// Outpost Dispatch: reclaiming a card from a machine that went silent, and the
// interaction with the board's own orphan sweep.
//
// Two failure modes are covered here, and they pull in OPPOSITE directions:
//
//   • Under-reclaiming — a machine sleeps or dies mid-run and its card stays
//     claimed forever. claimability() refuses a held card, so the work becomes
//     invisible to every machine including the one that owns it.
//
//   • Over-reclaiming — the board's local orphan sweep decides a perfectly
//     healthy REMOTE run is lost. isOrphanedRun falls back to run AGE for "a run
//     driven from another host", and its other check (runOwner pid +
//     isPidAlive) is meaningless across machines: that pid either does not exist
//     locally or matches an unrelated local process. Either way it would reclaim
//     a card a worker is actively heartbeating on, and then two machines run it.

import { describe, expect, it } from "vitest";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-home-reclaim-"));

import {
  // @ts-ignore — pure .mjs
  DISPATCH_LEASE_SECONDS as FITTING_LEASE,
  // @ts-ignore — pure .mjs
  isDispatchClaimLive,
  // @ts-ignore — pure .mjs
  isDispatchClaimExpired
  // @ts-ignore — pure .mjs
} from "../fittings/seed/kanban-loop/lib/dispatch-lease.mjs";
// @ts-ignore — pure .mjs
import { sweepExpiredDispatchClaims, isOrphanedRun } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
import { DISPATCH_LEASE_SECONDS as APP_LEASE } from "@/lib/dispatch";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const MACHINE = "goncalos-mac-mini-1";
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-reclaim-"));

function claim(over: Record<string, unknown> = {}) {
  return {
    machine: MACHINE,
    workerId: "w1",
    claimedAt: new Date(NOW - 5_000).toISOString(),
    heartbeatAt: new Date(NOW - 5_000).toISOString(),
    state: "running",
    ...over
  };
}
const expiredBeat = new Date(NOW - (FITTING_LEASE + 30) * 1000).toISOString();

describe("lease constant parity", () => {
  it("the fitting and the app agree on the lease", () => {
    // A Fitting cannot import the app's TypeScript, so the constant is
    // duplicated. If these drift, a worker heartbeats on one schedule while the
    // host reclaims on another — the card is stolen out from under a live run.
    expect(FITTING_LEASE).toBe(APP_LEASE);
  });
});

describe("isDispatchClaimLive / isDispatchClaimExpired", () => {
  it("a fresh claim is live and not expired", () => {
    const card = { dispatch: claim() };
    expect(isDispatchClaimLive(card, { at: NOW })).toBe(true);
    expect(isDispatchClaimExpired(card, { at: NOW })).toBe(false);
  });

  it("a silent claim is expired", () => {
    const card = { dispatch: claim({ heartbeatAt: expiredBeat }) };
    expect(isDispatchClaimLive(card, { at: NOW })).toBe(false);
    expect(isDispatchClaimExpired(card, { at: NOW })).toBe(true);
  });

  it.each(["done", "failed"])("a %s claim is neither live nor reclaimable", (state) => {
    const card = { dispatch: claim({ heartbeatAt: expiredBeat, state }) };
    expect(isDispatchClaimLive(card, { at: NOW })).toBe(false);
    expect(isDispatchClaimExpired(card, { at: NOW })).toBe(false);
  });

  it("a malformed timestamp is NOT live", () => {
    // Treating it as live would let one bad record pin a card forever.
    const card = { dispatch: claim({ heartbeatAt: "nonsense", claimedAt: "" }) };
    expect(isDispatchClaimLive(card, { at: NOW })).toBe(false);
    expect(isDispatchClaimExpired(card, { at: NOW })).toBe(true);
  });

  it("a card with no claim is neither", () => {
    expect(isDispatchClaimLive({ dispatch: null }, { at: NOW })).toBe(false);
    expect(isDispatchClaimExpired({ dispatch: null }, { at: NOW })).toBe(false);
  });
});

describe("isOrphanedRun vs a live remote claim", () => {
  it("does NOT reclaim a running card whose worker is heartbeating", () => {
    // The card is well past the single-turn age ceiling and carries a runOwner
    // pid from another host — both of the local checks would fire.
    const card = {
      status: "running",
      runningSince: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(),
      runOwner: { host: "some-other-host", pid: 999999 },
      dispatch: claim()
    };
    expect(isOrphanedRun(card, { at: NOW })).toBeNull();
  });

  it("still reclaims a running card once its claim goes silent", () => {
    const card = {
      status: "running",
      runningSince: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(),
      runOwner: { host: "some-other-host", pid: 999999 },
      dispatch: claim({ heartbeatAt: expiredBeat })
    };
    expect(isOrphanedRun(card, { at: NOW })).toBeTruthy();
  });

  it("leaves ordinary local cards alone", () => {
    // No dispatch claim at all — the pre-existing behaviour must be untouched.
    expect(isOrphanedRun({ status: "ok" }, { at: NOW })).toBeNull();
  });
});

describe("sweepExpiredDispatchClaims", () => {
  it("parks a silent card untargeted, naming the machine", async () => {
    const root = tmp();
    const created = await createCard(root, {
      title: "remote work",
      list: "implement",
      placement: { target: MACHINE }
    });
    await saveCardCAS(
      root,
      { ...created, status: "running", dispatch: claim({ heartbeatAt: expiredBeat }) },
      created.rev
    );

    const swept = await sweepExpiredDispatchClaims(root, { at: () => NOW });
    expect(swept).toEqual([created.id]);

    const after = await loadCard(root, created.id);
    expect(after.list).toBe("needs-attention");
    expect(after.attentionReason).toContain(MACHINE);
    expect(after.attentionKind).toBe("failed");
    // Untargeted, per the reclaim decision — so it can go to ANY machine next.
    expect(after.placement).toEqual({ target: "host" });
    // The claim is kept as evidence of where it ran, but marked terminal so the
    // sweep cannot pick it up again.
    expect(after.dispatch.machine).toBe(MACHINE);
    expect(after.dispatch.state).toBe("failed");
    expect(after.runningSince).toBeNull();
  });

  it("is idempotent — a second sweep does nothing", async () => {
    const root = tmp();
    const created = await createCard(root, {
      title: "remote work",
      list: "implement",
      placement: { target: MACHINE }
    });
    await saveCardCAS(
      root,
      { ...created, status: "running", dispatch: claim({ heartbeatAt: expiredBeat }) },
      created.rev
    );

    expect(await sweepExpiredDispatchClaims(root, { at: () => NOW })).toEqual([created.id]);
    expect(await sweepExpiredDispatchClaims(root, { at: () => NOW })).toEqual([]);
  });

  it("does not touch a card whose worker is still heartbeating", async () => {
    const root = tmp();
    const created = await createCard(root, {
      title: "healthy remote work",
      list: "implement",
      placement: { target: MACHINE }
    });
    await saveCardCAS(root, { ...created, status: "running", dispatch: claim() }, created.rev);

    expect(await sweepExpiredDispatchClaims(root, { at: () => NOW })).toEqual([]);
    const after = await loadCard(root, created.id);
    expect(after.list).toBe("implement");
    expect(after.placement).toEqual({ target: MACHINE });
  });

  it("ignores cards that were never dispatched", async () => {
    const root = tmp();
    const created = await createCard(root, { title: "local work", list: "implement" });
    await saveCardCAS(root, { ...created, status: "running" }, created.rev);
    expect(await sweepExpiredDispatchClaims(root, { at: () => NOW })).toEqual([]);
  });
});
