#!/usr/bin/env node
// Kanban Loop V1b CLI:
//   --setup            seed the board + register the Test scheduler beat
//   --probe            verify the engine + board are loadable
//   --tick             process due IMMEDIATE agent-list cards (skips scheduler-beat,
//                      manual, and interactive lists), and run the gateway-free
//                      sweeps, including the Discuss inactivity auto-archive
//   --tick-list <id>   process ONE list. For the Test list this is the BATCHED path
//                      (one session per project); the Test scheduler beat calls it.
//   --review           weekly board review: bucket cards into moving / stalled /
//                      needs-attention, write a dated report, notify. Never moves cards.
// The board UI is owned by other V1b slices; this is the engine spine.
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kanbanRoot, atomicWriteJSON, loadBoard, saveBoard, loadAllCards, createCard, updateCardCAS } from "../lib/board.mjs";
import { normaliseCardSchedule } from "../lib/schedules.mjs";
import { getList, withEvent, sweepOrphanedRuns, sweepExpiredDispatchClaims, sweepDueSchedules } from "../lib/engine.mjs";
import { isDispatchClaimLive } from "../lib/dispatch-lease.mjs";
import { conversationKickFn } from "../lib/gateway-client.mjs";
import { syncAllBeats } from "../lib/scheduler-beats.mjs";
import { resolveGatewayUrl, instanceEnvPrefix, registeredJobHasGateway } from "../lib/instance-env.mjs";
import { computeReview, renderReviewMarkdown, reviewNoticeText, DEFAULT_STALL_HOURS } from "../lib/review.mjs";
import { deliverBoardNotice } from "../lib/notify-origin.mjs";
import { MORNING_BRIEF_SYSTEM_KEY, reconcileMorningBriefDeliveries } from "../lib/morning-briefing.mjs";
import { loadPolicy } from "../lib/policy.mjs";
import { buildBoard, reconcileBoardLists } from "../lib/resolved-model.mjs";
import {
  PERSONAL_SCOPE_TOKEN,
  ensurePersonalWorkspace,
  resolvePersonalWorkspace
} from "../lib/personal-workspace.mjs";
import {
  reevaluateWaiting,
  coordinationConfig,
  coordinationAvailability,
  serializeGate
} from "../lib/coordination.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The full V1b pipeline (brief §"The pipeline and the lists" + v4 wireframe §5 — the
// authoritative per-list table). Every agent list carries an explicit {taskType,tier}
// classification (§10), a trigger (immediate | manual | scheduler-beat), a mode hint,
// the single garrison-* verb skill, and validNext ids the router reply's last line
// must exact-match. No per-list effort/model (the router decides); the two adversarial
// lists are cross-model Codex passes, NOT a higher tier (the operative stays modest);
// the architecture doc pointer is OFFERED to Implement (a convention, never required -
// a foreign project without one is normal, D12). Goal-mode cards carry a
// runtime-neutral acceptance block; the guard is the iteration cap, not a
// host-specific slash command or goal hook (Decision 7).
const ARCH_DOC = "docs/architecture.md";

// The immediately previous canonical Test defaults. Keep these byte-for-byte:
// recently installed boards carry these exact values and must receive the retry-
// safe gate contract below without treating an operator-authored variation as a
// default.
const PREVIOUS_CANONICAL_TEST_EXECUTE_PROMPT =
  "Run the test phase: write + run the committed correctness gate (and typecheck/lint/build) for each card's slice; write each card's test phase gate-status entry. " +
  "For every card whose next-options include `done` (Test is its final executable phase), ALWAYS create `<runDir>/evidence/evidence.md` before the verdict. Record the exact verification commands you ran, their key results/output, and a concise pass/fail summary so the finished card has durable, user-openable proof.";
const PREVIOUS_CANONICAL_TEST_ROUTER_PROMPT =
  "For each card, use THAT card's listed next-options: emit `<cardId> <the first listed forward option>` if green (or already passing), or `<cardId> implement` only if it is genuinely failing and implement is listed. Never name a board column outside that card's next-options.";

// Exact historical defaults from boards seeded before the current Test contract.
// Reconciliation may replace only these byte-for-byte values; any operator-edited
// prompt (even a one-character variation) remains authoritative.
export const LEGACY_DEFAULT_PHASE_PROMPTS = {
  test: {
    executePrompt: [
      PREVIOUS_CANONICAL_TEST_EXECUTE_PROMPT,
      "Run the test phase: write + run the committed correctness gate (and typecheck/lint/build) for each card's slice; write each card's test phase gate-status entry.",
      "Run autothing-test: write + run the committed correctness gate (and typecheck/lint/build) for each card's slice.",
      "Write + run the committed correctness gate (and typecheck/lint/build)."
    ],
    routerPrompt: [
      PREVIOUS_CANONICAL_TEST_ROUTER_PROMPT,
      "For each card, emit `<cardId> adversarial-test` if green (or already passing), or `<cardId> implement` only if it is genuinely failing.",
      "For each card, emit `<cardId> adversarial-test` if green or `<cardId> implement` if failing.",
      "If green, choose `validate`; if failing, choose `implement`."
    ]
  }
};

export { migrateBoard } from "../lib/board.mjs";

// The seed board IS the built board: five fixed state columns.
export function seedBoard() {
  return buildBoard();
}

// Move the legacy scheduledFor/scheduleAction shape into the v5 Scheduled
// column. The aliases remain on every card for older clients, but the schedule
// object becomes authoritative. Already-delivered reminders are converted to a
// completed one-shot and never sent again.
export async function migrateLegacyCardSchedules(root, board) {
  const cards = await loadAllCards(root);
  const migrated = [];
  for (const card of cards) {
    if (card.schedule || !card.scheduledFor) continue;
    const schedule = normaliseCardSchedule(null, {
      scheduledFor: card.scheduledFor,
      scheduleAction: card.scheduleAction,
      targetList: card.list,
      now: card.created ?? new Date().toISOString()
    });
    if (!schedule) continue;
    const reminderAlreadySent = Boolean(card.scheduleNotifiedAt);
    const updated = await updateCardCAS(root, card.id, (current) => {
      if (current.schedule || current.scheduledFor !== card.scheduledFor) return null;
      if (reminderAlreadySent) {
        return {
          ...current,
          schedule: { ...schedule, enabled: false, lastAt: schedule.nextAt, nextAt: null },
          scheduledFor: null,
          scheduleAction: null
        };
      }
      return {
        ...current,
        list: getList(board, "scheduled") ? "scheduled" : current.list,
        schedule,
        scheduledFor: schedule.nextAt,
        scheduleAction: schedule.action
      };
    });
    if (updated) migrated.push(card.id);
  }
  return migrated;
}

async function legacyMorningBriefJob(root) {
  const file = process.env.GARRISON_SCHEDULER_JOBS || path.join(path.dirname(root), "scheduler-jobs.json");
  try {
    const jobs = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(jobs)) {
      return { state: "unreadable", file, error: "scheduler jobs registry is not an array" };
    }
    const job = jobs.find((entry) => entry?.id === "morning-briefing") ?? null;
    return job ? { state: "present", file, job } : { state: "absent", file, job: null };
  } catch (error) {
    // Match the scheduler daemon's own contract: a registry that has never
    // existed is an empty registry, not a read failure. The daemon reloads the
    // file on every tick, so there is no in-memory legacy job hiding behind
    // ENOENT. Other I/O and parse failures remain uncertain and fail closed.
    if (error?.code === "ENOENT") return { state: "absent", file, job: null };
    // Apart from the scheduler-defined ENOENT-as-empty case above, absence is a
    // positive cutover signal only when the registry itself was read and parsed
    // successfully. Corrupt JSON and permission/I/O failures are operational
    // uncertainty: treating them as "job removed" can run the old raw job and
    // the new Scheduled template at the same time.
    return {
      state: "unreadable",
      file,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Seed the replacement while the legacy job is still live, but PAUSED. This lets
// the operator inspect it and exercise Run now before cutover without creating a
// second regular delivery. The first setup after the raw job is removed enables
// it according to the legacy job's recorded enabled state.
export async function ensureMorningBriefTemplate(root, board, { force = false, now = new Date().toISOString() } = {}) {
  const cards = await loadAllCards(root);
  const existing = cards.find((card) => card.systemKey === MORNING_BRIEF_SYSTEM_KEY);
  const legacyState = await legacyMorningBriefJob(root);
  const legacy = legacyState.state === "present" ? legacyState.job : null;
  if (existing) {
    if (legacyState.state === "absent" && existing.schedule?.cutoverPending) {
      const desiredEnabled = existing.schedule.desiredEnabled !== false;
      const verification = existing.schedule.runNowVerification;
      const verifiedOccurrence = verification && cards.find((card) =>
        card.id === verification.occurrenceId &&
        card.scheduleTemplateId === existing.id &&
        (!verification.occurrenceKey || card.occurrenceKey === verification.occurrenceKey)
      );
      // Removing the legacy job is not itself proof that the replacement
      // works. An enabled cadence stays paused until Run now has successfully
      // materialised an occurrence and persisted a receipt on this template.
      if (desiredEnabled && !verifiedOccurrence) {
        return {
          card: existing,
          created: false,
          cutoverPending: true,
          cutoverBlocked: true,
          skippedLegacy: false,
          error: "Legacy Morning briefing job is absent, but activation is blocked until Run now creates a verified occurrence."
        };
      }
      const schedule = normaliseCardSchedule({
        ...existing.schedule,
        enabled: desiredEnabled,
        nextAt: desiredEnabled ? null : existing.schedule.nextAt,
        cutoverPending: false,
        desiredEnabled: undefined
      }, { targetList: existing.schedule.targetList, now });
      const updated = await updateCardCAS(root, existing.id, (current) => ({
        ...current,
        schedule,
        scheduledFor: schedule?.enabled ? schedule.nextAt : null,
        scheduleAction: schedule?.action ?? null,
        events: withEvent(current, {
          at: now,
          kind: "schedule-cutover",
          message: desiredEnabled
            ? `Legacy morning-briefing job removed; recurring template enabled for ${schedule?.nextAt}`
            : "Legacy morning-briefing job removed; template preserved paused"
        })
      }));
      return { card: updated ?? existing, created: false, cutover: true, skippedLegacy: false };
    }
    return {
      card: existing,
      created: false,
      cutoverPending: Boolean(existing.schedule?.cutoverPending),
      skippedLegacy: false,
      ...(legacyState.state === "unreadable"
        ? { cutoverBlocked: true, error: `Cannot verify legacy Morning briefing job state: ${legacyState.error}` }
        : {})
    };
  }
  if (legacyState.state === "unreadable" && !force) {
    throw new Error(
      `Cannot safely seed Morning briefing: scheduler registry ${legacyState.file} could not be read and parsed (${legacyState.error})`
    );
  }
  // Conversations: there are no agent execution lists. The occurrence lands on
  // To do with scheduleAction "run" and the tick kicks its conversation.
  const executionList = getList(board, "todo")?.id ?? null;
  const pendingCutover = Boolean(legacy && !force);
  const desiredEnabled = legacy ? legacy.enabled !== false : true;
  const legacyCron = typeof legacy?.cron === "string" && normaliseCardSchedule({
    kind: "cron", action: "run", cron: legacy.cron, timezone: "Europe/Lisbon",
    enabled: false, targetList: "todo"
  }, { now })
    ? legacy.cron
    : "0 8 * * 1-5";
  const card = await createCard(root, {
    title: "Morning briefing",
    description:
      "Prepare today's morning briefing. Read today's Google Calendar events when the connector is available; " +
      "summarise active and due Kanban work, blocked cards, and Needs attention; then recommend a concise focus for the day. " +
      "After the actual Google connector call, write its machine-readable receipt to <runDir>/morning-briefing-evidence.json " +
      "as {\"calendar\":{\"connector\":\"google\",\"action\":\"calendar.list_events\",\"ok\":true|false," +
      "\"checkedAt\":\"ISO timestamp\",\"eventCount\":0,\"reason\":\"failure reason when not ok\"}}; prose is not evidence. " +
      "Deliver the completed briefing to the stable Garrison Web thread and directly to Omi when it is available. " +
      "Record a missing Calendar or Omi connection as a visibly degraded section/delivery result; never invent unavailable data, " +
      "and do not duplicate the Web delivery through Omi's fallback.",
    scope: "personal",
    list: "scheduled",
    origin: "scheduler",
    origin_id: "schedule:morning-briefing",
    // Conversations: the briefing runs as a conversation on the `other` duty;
    // sequence/lists are gone (executionList above is only the occurrence's
    // landing column, To do).
    duty: "other",
    level: 1,
    sequence: null,
    systemKey: MORNING_BRIEF_SYSTEM_KEY,
    schedule: {
      kind: "cron",
      action: "run",
      cron: legacyCron,
      timezone: "Europe/Lisbon",
      enabled: pendingCutover ? false : desiredEnabled,
      ...(pendingCutover ? { cutoverPending: true, desiredEnabled } : {}),
      targetList: "todo"
    },
    at: now
  });
  return { card, created: true, cutoverPending: pendingCutover, skippedLegacy: false, legacyEnabled: legacy?.enabled !== false };
}

// The single setup-time reconcile contract: the five-state board carries no
// per-phase templates or prompts, so reconcile is structural only.
export function reconcileExistingBoard(existingBoard, _model = null) {
  return reconcileBoardLists(existingBoard);
}

export function resolveSeedBoard(_root) {
  return buildBoard();
}

// A card must never be LOST when its list is removed by a duty reconcile. Move every
// card sitting on a now-removed list to the needs-attention column, preserving ALL
// other card state (runDir/runId/fences/… are kept) and recording WHY (a park event)
// so the human touchpoint surfaces it — the operator re-enters it on a current list.
// CAS-safe per card; a card whose list still exists is left untouched. Returns the
// moved card ids.
export async function relocateStrandedCards(root, board, removedListIds) {
  if (!Array.isArray(removedListIds) || removedListIds.length === 0) return [];
  const removed = new Set(removedListIds);
  const validIds = new Set((board.lists || []).map((l) => l.id));
  const cards = await loadAllCards(root);
  const moved = [];
  for (const card of cards) {
    // Only relocate a card whose current list truly left the board.
    if (!removed.has(card.list) || validIds.has(card.list)) continue;
    const fromList = card.list;
    const at = new Date().toISOString();
    const reason =
      `The '${fromList}' list was removed from the board when the composition's selected duties changed. ` +
      `Moved here so the card is not lost — re-enter it on a current list (To Do) to continue.`;
    const res = await updateCardCAS(root, card.id, (c) => ({
      ...c,
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: fromList,
      attentionReason: reason,
      events: withEvent(c, { at, kind: "parked", message: `List '${fromList}' removed by duty reconcile - moved to needs attention`, detail: reason })
    }));
    if (res) moved.push(card.id);
  }
  return moved;
}

// Resolve the installed scheduler CLI. At setup time cwd is the kanban-loop fitting
// dir, so the sibling scheduler fitting is one level up (matches the improver pattern).
function schedulerCli() {
  return process.env.GARRISON_SCHEDULER_CLI
    || path.resolve(__dirname, "..", "..", "scheduler", "scripts", "scheduler.mjs");
}

// Register a scheduler beat for EVERY scheduler-beat list, each on its own `beatCron`
// (the Test list seeds one; the user can add/edit a beat per list in the list config).
// Delegates to the shared lib so --setup and PATCH /lists register beats identically.
export async function registerSchedulerBeats() {
  const board = await loadBoard().catch(() => seedBoard());
  await syncAllBeats(board);
}

// Register the IMMEDIATE-list tick (FINDING 1: "a scheduler job ticks it"). Immediate
// agent lists fire on entry, but the engine is polled (no event bus), so a frequent
// scheduler job runs `--tick`. Cadence configurable via KANBAN_TICK_CRON (default every
// 2 minutes). The Test list has its OWN, separate beat (registerTestBeat).
// KANBAN_LOOP_* is the runner's setupConfigEnv projection of the composition's
// config block (tick_cron / review_cron / review_stall_hours in config_schema),
// so a composition value takes effect without the user exporting anything;
// the bare KANBAN_* name stays the explicit operator override on top.
export async function registerTick() {
  const cron = process.env.KANBAN_TICK_CRON || process.env.KANBAN_LOOP_TICK_CRON || "*/2 * * * *"; // every 2 minutes
  const cli = schedulerCli();
  const self = path.resolve(__dirname, "kanban.mjs");
  // Bake the instance's gateway URL + home into the command: the tick runs from the
  // scheduler daemon's env, which has neither, and guessing them is what silently
  // killed the prod tick (see resolveGatewayUrl).
  const prefix = instanceEnvPrefix();
  const cmd = [...prefix, "node", self, "--tick"].join(" ");
  if (!existsSync(cli)) {
    console.log(`kanban-loop: scheduler CLI not found at ${cli} (skipping tick job; register manually).`);
    return;
  }
  // NEVER DOWNGRADE. `--setup` runs from the apm.yml hook during `up`, which has no
  // gateway URL in scope; the board server re-registers later with one. Both call this
  // function, so without this guard the setup hook silently replaces a WORKING
  // registration with an env-less one, and the tick goes dead again — observed
  // immediately after the first deploy of this fix.
  if (!resolveGatewayUrl()) {
    if (registeredJobHasGateway("kanban-tick")) {
      console.log(
        "kanban-loop: no gateway URL in scope — KEEPING the existing kanban-tick " +
        "registration, which already carries one (refusing to downgrade it)."
      );
      return;
    }
    console.log(
      "kanban-loop: WARNING — registering kanban-tick with NO gateway URL " +
      "(neither GARRISON_GATEWAY_URL nor GARRISON_GATEWAY_PORT is set). The tick will " +
      "not dispatch anything until this fitting is started by the runner."
    );
  }
  const { spawnSync } = await import("node:child_process");
  spawnSync("node", [cli, "remove", "kanban-tick"], { stdio: "ignore" });
  const add = spawnSync("node", [cli, "add", "kanban-tick", cron, cmd], { encoding: "utf8" });
  if (add.status === 0) {
    console.log(`kanban-loop: registered kanban-tick @ '${cron}' -> ${cmd}`);
  } else {
    console.log(`kanban-loop: scheduler add (tick) failed (non-fatal in dev): ${add.stderr || add.stdout || add.status}`);
  }
}

// Register the weekly Monday review. Uses the scheduler CLI's idempotent
// `register` form (NOT remove+add) so a user's enable/disable choice and the
// job's last_run survive re-setup. Cadence via KANBAN_REVIEW_CRON, declared in
// apm.yml config_schema alongside tick_cron.
async function registerWeeklyReview() {
  const cron = process.env.KANBAN_REVIEW_CRON || process.env.KANBAN_LOOP_REVIEW_CRON || "0 8 * * 1"; // Mondays 08:00 local
  const cli = schedulerCli();
  const self = path.resolve(__dirname, "kanban.mjs");
  if (!existsSync(cli)) {
    console.log(`kanban-loop: scheduler CLI not found at ${cli} (skipping weekly review job; register manually).`);
    return;
  }
  // The review job runs from the scheduler daemon's env, which never sees the
  // composition config — so a configured stall threshold is baked into the job
  // command itself (the improver pattern: env assignment ahead of the command,
  // visible in the jobs file). Numeric-only guard: the value rides a `sh -c`.
  const stallRaw = process.env.KANBAN_REVIEW_STALL_HOURS || process.env.KANBAN_LOOP_REVIEW_STALL_HOURS || "";
  const stallPrefix = /^[0-9]+(\.[0-9]+)?$/.test(stallRaw) ? [`KANBAN_REVIEW_STALL_HOURS=${stallRaw}`] : [];
  const { spawnSync } = await import("node:child_process");
  const reg = spawnSync(
    "node",
    [cli, "register", "kanban-weekly-review", cron, "--description", "Weekly Monday board review (stall detection)", "--", ...stallPrefix, "node", self, "--review"],
    { encoding: "utf8" }
  );
  if (reg.status === 0) {
    console.log(`kanban-loop: registered kanban-weekly-review @ '${cron}' -> ${[...stallPrefix, "node", self, "--review"].join(" ")}`);
  } else {
    console.log(`kanban-loop: scheduler register (weekly review) failed (non-fatal in dev): ${reg.stderr || reg.stdout || reg.status}`);
  }
}

// The weekly review: assemble board state through lib/review.mjs (the single
// summary source in the fitting), write a dated markdown report under the
// kanban root, and post a short notice through the notify-origin transport.
// Report-and-notify ONLY — the review never moves or writes cards, so it
// cannot fight the engine.
async function review() {
  const root = kanbanRoot();
  const cards = await loadAllCards(root);
  const stallHoursRaw = Number(process.env.KANBAN_REVIEW_STALL_HOURS);
  const stallHours = Number.isFinite(stallHoursRaw) && stallHoursRaw > 0 ? stallHoursRaw : DEFAULT_STALL_HOURS;
  const nowIso = new Date().toISOString();
  const result = computeReview({ cards, now: nowIso, stallMs: stallHours * 3_600_000 });
  const reportDir = path.join(root, "reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `review-${nowIso.slice(0, 10)}.md`);
  await fs.writeFile(reportPath, renderReviewMarkdown(result, { now: nowIso }), "utf8");
  console.log(
    `kanban-loop: weekly review — attention=${result.attention.length} stalled=${result.stalled.length} moving=${result.moving.length} -> ${reportPath}`
  );
  const delivered = await deliverBoardNotice("Board review", reviewNoticeText(result, reportPath));
  console.log(`kanban-loop: review notice ${delivered ? "delivered to the web channel" : "not delivered (channel down or absent) — report + log only"}`);
}

async function setup() {
  const personalWorkspace = await ensurePersonalWorkspace();
  console.log("kanban-loop: personal workspace ready at", personalWorkspace);
  const root = kanbanRoot();
  await fs.mkdir(path.join(root, "cards"), { recursive: true });
  // The board layout is a shared document in the state service now, so its
  // presence is a read, not an existsSync. Seed-or-migrate-never-clobber is
  // unchanged: an existing layout is reconciled, never overwritten.
  const seeded = await loadBoard(root).catch(() => null);
  if (!seeded) {
    await saveBoard(resolveSeedBoard(root), root);
    console.log("kanban-loop: seeded board layout");
  } else {
    // RECONCILE an existing FIVE-STATE board's lists to the fixed five —
    // structural only (no phase templates or prompts exist any more). A
    // pre-Conversations board (v9) is left strictly alone: reconciling it here
    // would rebuild the five columns UNDER 200+ legacy cards and strand every
    // one of them — exactly the half-migrated hazard migrateBoard's v10 guard
    // exists to prevent. The one-time migration script does board + cards in
    // ONE pass.
    if ((seeded.version || 0) >= 10) {
      const { board, removed, added, updated } = reconcileExistingBoard(seeded);
      if (removed.length || added.length || updated.length) {
        await saveBoard(board, root);
        const moved = await relocateStrandedCards(root, board, removed);
        console.log(
          `kanban-loop: reconciled board layout (+[${added.join(", ")}] -[${removed.join(", ")}] ~[${updated.join(", ")}]${moved.length ? `, moved ${moved.length} stranded card(s) to needs-attention` : ""})`
        );
      } else {
        console.log("kanban-loop: board layout up to date");
      }
    } else {
      console.log("kanban-loop: board is pre-Conversations — left untouched; run scripts/migrate-conversations.mjs");
    }
  }
  const board = await loadBoard(root);
  const legacySchedules = await migrateLegacyCardSchedules(root, board);
  if (legacySchedules.length) console.log(`kanban-loop: migrated ${legacySchedules.length} one-shot schedule(s) into Scheduled`);
  const morning = await ensureMorningBriefTemplate(root, board);
  if (morning.created && morning.cutoverPending) console.log(`kanban-loop: seeded PAUSED Morning briefing template ${morning.card.id}; verify with Run now, remove the legacy job, then rerun setup to enable it`);
  else if (morning.created) console.log(`kanban-loop: seeded recurring Morning briefing card ${morning.card.id}`);
  else if (morning.cutover) console.log(`kanban-loop: completed Morning briefing cutover (${morning.card.id})`);
  await registerTick();
  await registerSchedulerBeats();
  await registerWeeklyReview();
}

async function probe() {
  try {
    await loadBoard();
  } catch {
    // an absent board is fine for the probe — setup seeds it
  }
  if (typeof sweepDueSchedules !== "function" || typeof sweepOrphanedRuns !== "function") {
    console.error("KANBAN-FAIL: engine not loadable");
    process.exit(1);
  }
  const personalWorkspace = await resolvePersonalWorkspace();
  if (!personalWorkspace) {
    console.error("KANBAN-FAIL: personal workspace missing, invalid, or symlinked; run --setup");
    process.exit(1);
  }
  console.log("KANBAN-OK");
}

async function seedMorningBrief() {
  const root = kanbanRoot();
  const board = await loadBoard(root);
  const result = await ensureMorningBriefTemplate(root, board);
  console.log(`kanban-loop: Morning briefing ${result.created ? `created (${result.card.id})` : result.cutover ? `cut over (${result.card.id})` : `already exists (${result.card.id})`}${result.cutoverPending ? " — paused pending legacy-job removal" : ""}`);
}

// Process due IMMEDIATE agent-list cards. Skips scheduler-beat (Test runs on its own
// beat), manual, and interactive lists.
async function tick() {
  const root = kanbanRoot();
  const gatewayUrl = resolveGatewayUrl();
  // Release lost runs FIRST, and do it whether or not a gateway is reachable: an
  // orphaned card is wedged regardless, and the sweep needs no operative.
  const orphans = await sweepOrphanedRuns(root).catch(() => []);
  for (const id of orphans) console.log(`kanban-loop: released a lost run on card ${id} (retryable)`);
  // Same beat, the cross-machine case: a dispatched card whose worker stopped
  // heartbeating. Needs no gateway either — reclaiming is local bookkeeping.
  const reclaimed = await sweepExpiredDispatchClaims(root).catch(() => []);
  for (const id of reclaimed) console.log(`kanban-loop: reclaimed card ${id} from a silent outpost`);
  // Scheduling is clock work, not model work. Create due occurrences and send
  // reminders even while the operative is down; auto-run occurrences simply wait
  // on their agent list until a later tick can reach the gateway.
  const board = await loadBoard(root);
  const due = await sweepDueSchedules(root, board).catch((error) => {
    console.log(`kanban-loop: schedule sweep failed: ${error?.message || error}`);
    return [];
  });
  for (const d of due) console.log(`kanban-loop: scheduled card ${d.id} came due → ${d.action}${d.occurrenceId ? ` (${d.occurrenceId})` : ""}`);
  const morning = await reconcileMorningBriefDeliveries(root).catch((error) => ({
    checked: 0,
    completed: 0,
    skipped: 0,
    errors: [{ cardId: "unknown", error: String(error?.message ?? error) }]
  }));
  if (morning.completed) console.log(`kanban-loop: repaired ${morning.completed} Morning briefing delivery receipt(s)`);
  for (const failure of morning.errors) {
    console.log(`kanban-loop: Morning briefing reconciliation failed for ${failure.cardId}: ${failure.error}`);
  }
  if (!gatewayUrl) {
    // Distinct from "the gateway is down": this instance never told the tick WHICH
    // gateway is its own, so kicking would be a guess. Silently logging
    // "not reachable" here is what hid the dead prod tick for weeks.
    console.log(
      "kanban-loop: NO gateway URL for this instance (neither GARRISON_GATEWAY_URL nor " +
      "GARRISON_GATEWAY_PORT is set) — the tick cannot kick conversations. Re-run `kanban.mjs --setup` " +
      "from the running fitting so the job command carries this instance's gateway."
    );
    return;
  }
  if (!(await gatewayReachable(gatewayUrl))) {
    console.log(`kanban-loop: gateway not reachable at ${gatewayUrl} — nothing to kick (conversations wait for an operative).`);
    return;
  }
  // Coordination (GARRISON-FLOW-V2 S1): release any waiting cards whose blocker
  // reached its release point BEFORE kicking, then reload so released cards are
  // seen on their new list this same tick.
  const cards0 = await loadAllCards(root);
  await reevaluateWaiting({ root, board, cards: cards0 }).catch(() => {});
  const cards = await loadAllCards(root);
  // Conversations: the tick no longer dispatches duty turns. It KICKS the
  // launcher (fire-and-forget /conversation/kick) for exactly two shapes:
  //   - a due schedule occurrence sitting on To do with scheduleAction "run"
  //     (the nightly and every Run-now come through here), and
  //   - RECOVERY: a card stuck in Running with no advancing conversation
  //     (a crashed gateway left it mid-flight; the kick resumes from the store).
  // Everything else starts through the Start action or the materialization
  // door. The gateway 409s an already-advancing conversation, so kicks are
  // idempotent at every 2-minute beat.
  const kick = conversationKickFn(gatewayUrl);
  let kicked = 0;
  for (const card of cards) {
    if (card.autonomyHeld === true || card.waitingOn) continue;
    // A live dispatch claim means a worker on another machine is driving this
    // card — kicking the LOCAL gateway would double-drive it. Claim expiry is
    // swept above (sweepExpiredDispatchClaims), so a dead worker's card
    // becomes kickable again on a later tick.
    if (isDispatchClaimLive(card)) continue;
    const dueRun = card.list === "todo" && card.scheduleAction === "run";
    const recovery = card.list === "running";
    if (!dueRun && !recovery) continue;
    const res = await kick({
      conversationId: card.conversationId ?? card.id,
      cardId: card.id,
      task: dueRun ? [card.title, card.description].filter(Boolean).join("\n\n") : null,
      title: card.title ?? null
    });
    if (res.ok && res.kicked) {
      console.log(`kanban-loop: kicked conversation for card ${card.id} (${dueRun ? "schedule-run" : "recovery"})`);
      kicked++;
    } else if (!res.ok) {
      console.log(`kanban-loop: kick failed for card ${card.id}: ${res.error}`);
    }
  }
  console.log(`kanban-loop: tick kicked ${kicked} conversation(s)`);
}

// Only dispatch the CLI when run directly (so `import { seedBoard }` from a test is
// side-effect-free).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = process.argv[2];
  if (arg === "--setup") await setup();
  else if (arg === "--probe") await probe();
  else if (arg === "--tick") await tick();
  else if (arg === "--tick-list") console.log("kanban-loop: --tick-list is retired (Conversations) — the tick kicks conversations; per-list dispatch is gone.");
  else if (arg === "--review") await review();
  else if (arg === "--seed-morning-brief") await seedMorningBrief();
  else console.log("usage: kanban.mjs --setup | --probe | --tick | --review | --seed-morning-brief");
}
