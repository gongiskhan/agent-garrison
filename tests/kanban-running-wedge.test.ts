// THE "card stuck in Code forever" regression (2026-07-29).
//
// Observed: card 01KYP7Q584BP7F8AMFMJPCAWQS ("on ekoa-code move the Pedidos into
// a tab in the settings area") was dispatched at 06:06:48.327Z, the operative did
// the whole job and replied "done" at 06:13Z, and its runDir held a valid
// gate-status.json ({"code":{"status":"passed","next_phase":"done"}}). The card
// nonetheless sat at status "running" indefinitely — the board showed a live
// elapsed timer that just counted up, and nothing ever cleared it.
//
// Cause: processCard CAS-acquires the card (capturing `runRev`), then awaits a
// minutes-long gateway turn, then writes the terminal state with that ORIGINAL
// rev. Anything that touches the card meanwhile bumps its rev, so the terminal
// saveCardCAS fails the compare and the engine returns
// `{status:"needs-attention", reason:"conflict-during-run"}` WITHOUT ever writing
// — leaving status:"running" on disk with no owner and no recovery.
//
// The concurrent writer in the real incident was the board's own fire-and-forget
// project inference (server.mjs runProjectInference), which landed
// "Inferred the project: ekoa-code" 4.4s AFTER the dispatch acquire. So the race
// fires on the most ordinary path there is: a card created with no project and
// dispatched immediately.
//
// The contract these tests pin: a finished run ALWAYS lands its terminal state.
// A benign concurrent write may not strand the card in "running".
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";

// @ts-ignore pure mjs
import { processCard, sweepOrphanedRuns, orphanRunThresholdMs } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore pure mjs
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore pure mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore pure mjs
import { atomicWriteJSON, loadCard, updateCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore pure mjs
import { compilePolicy, stableStringify } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const ROOT = path.resolve(__dirname, "..");
const SEED_CONFIG = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");

let tmp: string;

function writePolicy(file: string) {
  const cfg = JSON.parse(readFileSync(SEED_CONFIG, "utf8"));
  writeFileSync(file, stableStringify(compilePolicy(cfg)), "utf8");
  resetPolicyCache();
}

async function makeCard(root: string, overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) || "01WEDGECARD000000000000000";
  const card = {
    id,
    title: "on ekoa-code move the Pedidos into a tab in the settings area",
    description: "on ekoa-code move the Pedidos into a tab in the settings area",
    project: null,
    list: "implement",
    status: "ok",
    iterations: 0,
    rev: 0,
    workKind: "full-feature",
    goalMode: true,
    acceptance: null,
    events: [],
    runId: "01WEDGERUN0000000000000000",
    runDir: path.join(root, "runs", id),
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides
  };
  mkdirSync(path.join(root, "cards", card.id), { recursive: true });
  if (card.runDir) mkdirSync(card.runDir as string, { recursive: true });
  await atomicWriteJSON(path.join(root, "cards", card.id, "card.json"), card);
  return card;
}

function landGate(runDir: string, phase: string, nextPhase: string) {
  writeFileSync(
    path.join(runDir, `gate-status.${phase}.json`),
    JSON.stringify({ phase, status: "passed", next_phase: nextPhase }),
    "utf8"
  );
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "kanban-wedge-"));
  // Sandbox the runs home so a freshly MINTED runDir lands under the tmpdir, never ~/.garrison.
  process.env.GARRISON_RUNS_DIR = path.join(tmp, "runs");
  process.env.GARRISON_POLICY_PATH = path.join(tmp, "policy.json");
  writePolicy(process.env.GARRISON_POLICY_PATH);
});

describe("processCard — a concurrent card write during the run must not wedge it in `running`", () => {
  it("(a) the exact incident: project inference lands mid-run, the run then succeeds → card ADVANCES and is not left running", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp);

    // The run: the operative works for a while, and WHILE IT WORKS the board's
    // fire-and-forget project inference writes the card (exactly as
    // runProjectInference does ~4s after an immediate dispatch). That write bumps
    // the rev out from under the run.
    const runFn = async () => {
      await updateCardCAS(tmp, card.id, (c: any) => ({
        ...c,
        project: "ekoa-code",
        inferState: "done",
        events: [...(c.events || []), { at: "2026-01-01T00:00:05Z", kind: "inference", message: "Inferred the project: ekoa-code" }]
      }));
      landGate(card.runDir as string, "implement", "review");
      return { reply: "all done\n\nreview" };
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    // THE BUG: this used to be status "running" forever, with
    // outcome.reason === "conflict-during-run" and nothing written.
    expect(onDisk.status).not.toBe("running");
    expect(onDisk.runningSince ?? null).toBeNull();
    expect(outcome.status).toBe("moved");
    expect(onDisk.list).toBe("review");
    // the concurrent writer's data is preserved — the retry must merge, not clobber
    expect(onDisk.project).toBe("ekoa-code");
  });

  it("(b) a concurrent write + a run that parks → the card parks, and is never left running", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01WEDGECARD000000000000002" });

    const runFn = async () => {
      await updateCardCAS(tmp, card.id, (c: any) => ({ ...c, project: "ekoa-code" }));
      return { reply: "I did some things but never named a next list." };
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.status).not.toBe("running");
    expect(onDisk.runningSince ?? null).toBeNull();
    expect(outcome.status).toBe("needs-attention");
    expect(onDisk.list).toBe("needs-attention");
    expect(onDisk.project).toBe("ekoa-code");
  });

  it("(c) a GENUINE takeover (someone moved the card off the list mid-run) is still refused — the run does not overwrite it", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01WEDGECARD000000000000003" });

    // A human drags the card to needs-attention while the run is in flight. The
    // run's verdict must NOT drag it back — but it must also not leave it running.
    const runFn = async () => {
      await updateCardCAS(tmp, card.id, (c: any) => ({
        ...c,
        list: "todo",
        status: "ok",
        runningSince: null
      }));
      landGate(card.runDir as string, "implement", "review");
      return { reply: "review" };
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.list).toBe("todo"); // the human's move wins
    expect(onDisk.status).not.toBe("running");
    expect(["skipped", "needs-attention"]).toContain(outcome.status);
  });
});

// ── the backstop: a run whose DRIVER died, while the board server lives on ────
//
// recoverInterruptedRuns only fires at board-SERVER boot — which never comes for
// an always-on prod server. And the tick SKIPS cards in status "running", so a card
// whose driver went away (a killed `--tick` CLI, a crashed chain) was never looked
// at again by anything. sweepOrphanedRuns closes that hole on every tick.
describe("sweepOrphanedRuns — a lost run is released instead of wedging the board", () => {
  it("releases a run whose owner pid is dead on this host", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, {
      id: "01ORPHANCARD00000000000001",
      status: "running",
      runningSince: new Date().toISOString(),
      // pid 2^22 is above Linux's default pid_max — reliably not a live process.
      runOwner: { pid: 4194303, host: hostname(), at: new Date().toISOString() }
    });
    void board;

    const swept = await sweepOrphanedRuns(tmp);
    expect(swept).toEqual([card.id]);

    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.status).toBe("ok");
    expect(onDisk.runningSince).toBeNull();
    expect(onDisk.lastDispatchError.reason).toBe("orphaned");
    expect(onDisk.events.some((e: any) => e.kind === "recovered")).toBe(true);
  });

  it("leaves a run with a LIVE owner alone, however long it has been going", async () => {
    const card = await makeCard(tmp, {
      id: "01ORPHANCARD00000000000002",
      status: "running",
      runningSince: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6h
      runOwner: { pid: process.pid, host: hostname(), at: new Date().toISOString() }
    });

    expect(await sweepOrphanedRuns(tmp)).toEqual([]);
    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.status).toBe("running");
  });

  it("falls back to the age ceiling when there is no usable owner stamp (a pre-existing card)", async () => {
    const fresh = await makeCard(tmp, {
      id: "01ORPHANCARD00000000000003",
      status: "running",
      runningSince: new Date(Date.now() - 60 * 1000).toISOString() // 1 min — legitimate
    });
    const ancient = await makeCard(tmp, {
      id: "01ORPHANCARD00000000000004",
      status: "running",
      runningSince: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() // 3h — past any turn
    });

    const swept = await sweepOrphanedRuns(tmp);
    expect(swept).toEqual([ancient.id]);
    expect(((await loadCard(tmp, fresh.id)) as any).status).toBe("running");
    expect(((await loadCard(tmp, ancient.id)) as any).status).toBe("ok");
  });

  it("the threshold is derived from the dispatcher's per-turn timeout, never a bare literal", () => {
    const prev = process.env.KANBAN_TURN_TIMEOUT_MS;
    process.env.KANBAN_TURN_TIMEOUT_MS = String(60 * 60 * 1000); // 1h turns
    try {
      expect(orphanRunThresholdMs()).toBeGreaterThan(60 * 60 * 1000);
    } finally {
      if (prev === undefined) delete process.env.KANBAN_TURN_TIMEOUT_MS;
      else process.env.KANBAN_TURN_TIMEOUT_MS = prev;
    }
  });

  it("a finished run clears its owner stamp, so it can never look sweepable", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01ORPHANCARD00000000000005" });
    const runFn = async () => {
      landGate(card.runDir as string, "implement", "review");
      return { reply: "review" };
    };
    await processCard({ root: tmp, board, card, runFn, cwd: tmp });
    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.runOwner ?? null).toBeNull();
    expect(await sweepOrphanedRuns(tmp)).toEqual([]);
  });
});

// The failure paths CAS with the same stale rev as the success path did, so they
// wedge the card identically — a transport blip or a thrown run during a benign
// concurrent write used to leave "running" on disk too.
describe("processCard — the FAILURE paths also land their terminal state under a concurrent write", () => {
  it("a transport failure (gateway down) reverts the card instead of stranding it running", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01WEDGEFAIL000000000000001" });
    const runFn = async () => {
      await updateCardCAS(tmp, card.id, (c: any) => ({ ...c, project: "ekoa-code" }));
      const e: any = new Error("gateway unreachable: fetch failed");
      e.transport = true;
      throw e;
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    expect(outcome.status).toBe("deferred");
    expect(onDisk.status).not.toBe("running");
    expect(onDisk.runningSince ?? null).toBeNull();
    expect(onDisk.lastDispatchError.reason).toBe("gateway-unavailable");
    expect(onDisk.project).toBe("ekoa-code");
  });

  it("a thrown run parks the card instead of stranding it running", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01WEDGEFAIL000000000000002" });
    const runFn = async () => {
      await updateCardCAS(tmp, card.id, (c: any) => ({ ...c, project: "ekoa-code" }));
      throw new Error("the runtime blew up");
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    expect(outcome.status).toBe("needs-attention");
    expect(onDisk.status).not.toBe("running");
    expect(onDisk.runningSince ?? null).toBeNull();
    expect(onDisk.list).toBe("needs-attention");
    expect(onDisk.project).toBe("ekoa-code");
  });
});

// A released run that comes back late must NOT clobber the run that replaced it.
// mintRunFields is idempotent, so a re-dispatched card keeps the same runId — only
// the run GENERATION distinguishes them.
describe("run generations — a zombie run cannot overwrite the run that replaced it", () => {
  it("a run whose card was released and re-dispatched loses ownership and is refused", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01ZOMBIECARD00000000000001" });

    // Run A starts, and WHILE IT IS RUNNING the card is released (orphan sweep) and
    // re-dispatched as run B. A then tries to commit its verdict.
    let released = false;
    const runFn = async ({ card: c }: { card: any }) => {
      if (!released) {
        released = true;
        // sweep releases it...
        await updateCardCAS(tmp, c.id, (x: any) => ({ ...x, status: "ok", runningSince: null, runOwner: null }));
        // ...and run B acquires it (same runId, next generation).
        await updateCardCAS(tmp, c.id, (x: any) => ({
          ...x,
          status: "running",
          runningSince: new Date().toISOString(),
          runSeq: (x.runSeq ?? 0) + 1,
          runOwner: { pid: process.pid, host: hostname(), at: new Date().toISOString() }
        }));
      }
      landGate(c.runDir as string, "implement", "review");
      return { reply: "review" };
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    // Run A's verdict is refused — run B still owns the card.
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("taken-over-during-run");
    expect(onDisk.list).toBe("implement"); // NOT advanced to review by the zombie
    expect(onDisk.status).toBe("running"); // run B is still going
  });
});

// The card that started all this had runDir `runs/no-project/<runId>` even though its
// project was inferred 4.4s later — the immediate dispatch beat the fire-and-forget
// inference. The runDir literal is baked into the operative's prompt, so it can never
// be corrected after the fact; the only fix is not to mint it too early.
describe("settleProjectInference — an immediate dispatch waits for the project", () => {
  it("waits while inference is running, then mints under the inferred project", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, {
      id: "01INFERCARD000000000000001",
      project: null,
      inferState: "running",
      runId: null,
      runDir: null
    });

    // The inference lands on the 2nd poll, exactly as it did in the incident.
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 2) {
        await updateCardCAS(tmp, card.id, (c: any) => ({ ...c, project: "ekoa-code", inferState: "done" }));
      }
    };

    const runFn = async ({ card: c }: { card: any }) => {
      mkdirSync(c.runDir as string, { recursive: true }); // freshly minted by this dispatch
      landGate(c.runDir as string, "implement", "review");
      return { reply: "review" };
    };

    const { outcome } = await processCard({
      root: tmp, board, card, runFn, cwd: tmp,
      settle: { intervalMs: 1, checks: 10, sleep }
    });

    const onDisk: any = await loadCard(tmp, card.id);
    expect(polls).toBeGreaterThanOrEqual(2); // it actually waited
    expect(outcome.status).toBe("moved");    // and the acquire CAS did not conflict
    expect(onDisk.project).toBe("ekoa-code");
    expect(onDisk.runDir).toContain("ekoa-code");
    expect(onDisk.runDir).not.toContain("no-project");
  });

  it("does NOT wait when inference already settled, or was never attempted", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01INFERCARD000000000000002", project: null, inferState: "none" });
    let polls = 0;
    const runFn = async () => ({ reply: "review" });
    await processCard({
      root: tmp, board, card, runFn, cwd: tmp,
      settle: { intervalMs: 1, checks: 10, sleep: async () => { polls += 1; } }
    });
    expect(polls).toBe(0); // a settled/absent inference never blocks a dispatch
  });

  it("gives up after the bounded window so a busy operative can never block a run", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01INFERCARD000000000000003", project: null, inferState: "running" });
    let polls = 0;
    const runFn = async () => ({ reply: "review" });
    await processCard({
      root: tmp, board, card, runFn, cwd: tmp,
      settle: { intervalMs: 1, checks: 5, sleep: async () => { polls += 1; } } // never settles
    });
    expect(polls).toBe(5); // bounded, then proceeds honestly under no-project
    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.status).not.toBe("running");
  });
});

// The invariant, stated directly: NO path through a finished run may leave the card
// showing "running" with nobody driving it. These cover the two escape hatches the
// first cut of the fix still had — a takeover that preserved the running status, and
// exhausting the rebase retries.
describe("commitRunResult — the card is never left running, on any path", () => {
  it("a takeover that PRESERVES status:running still gets released", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01NEVERRUNNING0000000000001" });

    const runFn = async ({ card: c }: { card: any }) => {
      // Moved to another list mid-run WITHOUT clearing the running flag.
      await updateCardCAS(tmp, c.id, (x: any) => ({ ...x, list: "review" }));
      landGate(c.runDir as string, "implement", "review");
      return { reply: "review" };
    };

    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });

    const onDisk: any = await loadCard(tmp, card.id);
    expect(outcome.status).toBe("skipped");
    expect(onDisk.status).not.toBe("running"); // released, not abandoned
    expect(onDisk.runningSince ?? null).toBeNull();
    expect(onDisk.events.some((e: any) => e.kind === "recovered")).toBe(true);
  });

  it("exhausting the rebase retries still releases the card", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01NEVERRUNNING0000000000002" });

    // A writer that bumps the rev on every attempt so no CAS the run makes can land.
    // Serialized and bounded — a free-running hammer would starve the per-card lock
    // and the test would measure lock contention instead of the retry ceiling.
    let hammering = true;
    const hammerLoop = (async () => {
      for (let i = 0; i < 40 && hammering; i++) {
        await updateCardCAS(tmp, card.id, (c: any) => ({ ...c, hammered: (c.hammered ?? 0) + 1 }));
        await new Promise((r) => setTimeout(r, 3));
      }
    })();

    const runFn = async () => ({ reply: "review" });
    const { outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });
    hammering = false;
    await hammerLoop;

    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.status).not.toBe("running");
    expect(onDisk.runningSince ?? null).toBeNull();
    void outcome;
  }, 20000);
});
