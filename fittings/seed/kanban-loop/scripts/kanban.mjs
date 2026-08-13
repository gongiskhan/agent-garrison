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
import { kanbanRoot, atomicWriteJSON, loadBoard, loadAllCards, createCard, updateCardCAS } from "../lib/board.mjs";
import { normaliseCardSchedule } from "../lib/schedules.mjs";
import { processCard, processBatch, getList, triggerFor, isInteractive, isGatedDiscuss, withEvent, phaseForList, sweepOrphanedRuns, sweepExpiredDispatchClaims, sweepDueSchedules } from "../lib/engine.mjs";
import { gatewayRunFn, compactBoundaryFn } from "../lib/gateway-client.mjs";
import { syncAllBeats } from "../lib/scheduler-beats.mjs";
import { resolveGatewayUrl, instanceEnvPrefix, registeredJobHasGateway } from "../lib/instance-env.mjs";
import { computeReview, renderReviewMarkdown, reviewNoticeText, DEFAULT_STALL_HOURS } from "../lib/review.mjs";
import { deliverBoardNotice } from "../lib/notify-origin.mjs";
import { MORNING_BRIEF_SYSTEM_KEY, reconcileMorningBriefDeliveries } from "../lib/morning-briefing.mjs";
import { loadPolicy } from "../lib/policy.mjs";
import { loadResolvedModel, buildBoard, reconcileBoardLists, validNextForCard } from "../lib/resolved-model.mjs";
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

export function seedBoard() {
  return {
    version: 5,
    lists: [
      {
        id: "scheduled", title: "Scheduled", order: -1, userOrder: -1,
        kind: "scheduled", trigger: "scheduler-beat", system: true, validNext: []
      },
      {
        id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual",
        // On entry: infer the title eagerly; apply the project only at >=70% confidence,
        // else park in needs-attention (engine.resolveBacklogInference — FINDING 3).
        onEnter: "infer-title-and-project",
        validNext: ["todo"]
      },
      { id: "todo", title: "To Do", order: 1, kind: "manual", trigger: "manual", validNext: ["discuss", "plan"] },
      {
        id: "discuss", title: "Discuss", order: 2, kind: "agent-interactive", trigger: "manual",
        // Interactive: NOT auto-dispatched. The board opens the web chat; the operative
        // produces a brief to disk; the human advances manually. (Per-list mode is DEAD
        // — D15; the gateway resolves the face.)
        interactive: true, surface: "web-channel",
        onEnter: "open-web-chat",
        validNext: ["plan"]
      },
      // ── Autonomous lists (Plan onward). A list maps to a PHASE NAME and nothing
      // else (D15): skill / model / effort / runtime resolve from the compiled
      // Orchestrator policy at dispatch time (lib/policy.mjs); the engine injects
      // the policy-bound skill into the prompt. These lists are ENGINE-OWNED
      // (D16): the board API + UI reject manual moves/edits on them.
      {
        id: "plan", title: "Plan", order: 3, kind: "agent", trigger: "immediate", phase: "plan",
        executePrompt:
          "Plan this card: explore, then write the implementation plan and machine-checkable acceptance under the run directory, and write the plan phase's gate-status entry.",
        routerPrompt: "When the plan + acceptance are written (or already exist in the run directory) AND the plan phase's gate-status entry exists, end with `implement` on its own final line.",
        validNext: ["implement"]
      },
      {
        id: "implement", title: "Implement", order: 4, kind: "agent", trigger: "immediate", phase: "implement",
        executePrompt:
          `Implement the planned slice end-to-end. Read the plan + acceptance from the run directory, and the project's architecture doc (${ARCH_DOC}) WHEN THE PROJECT HAS ONE - it is a convention, not a requirement, and a project without it is normal (GARRISON-FLOW-V2 D12: the flow is project-agnostic). Follow the project's existing conventions; fix forward; write the implement phase's gate-status entry.`,
        routerPrompt: "When the code is written and self-checks pass — or the change is already present and complete — end with `review` on its own final line.",
        validNext: ["review"]
      },
      {
        id: "review", title: "Review", order: 5, kind: "agent", trigger: "immediate", phase: "review",
        executePrompt: "Review the slice diff for correctness then quality; write the review phase's gate-status entry with the verdict.",
        routerPrompt: "If the review is clean OR the slice is already complete (no real issues), end with `adversarial-review`. Only if real issues remain, end with `implement`. End with the bare token on its own final line.",
        validNext: ["adversarial-review", "implement"]
      },
      {
        id: "adversarial-review", title: "Adversarial Review", order: 6, kind: "agent", trigger: "immediate", phase: "adversarial-review",
        executePrompt: "Run the adversarial review phase: a fresh-context pass that tries to break the diff; iterate to approve; write the phase's gate-status entry.",
        routerPrompt: "If the adversarial review approves — or there is nothing left to review (already complete/clean) — end with `test`. Only if it found real issues, end with `implement`. End with the bare token on its own final line.",
        validNext: ["test", "implement"]
      },
      {
        id: "test", title: "Test", order: 7, kind: "agent", trigger: "scheduler-beat", phase: "test",
        // Runs on its OWN scheduler beat (default every 5h, editable as a cron), not
        // the global heartbeat, and is BATCHED per project: one session per project
        // against one test plan, one verdict per card (list MECHANICS, preserved — D9).
        beatCron: "0 */5 * * *",
        batched: true,
        // A resolved workflow may end at Test (for example develop level 2 is
        // plan -> implement -> review -> test -> done) and therefore never visit
        // Walkthrough. In that transition Test owns the always-on evidence report;
        // the engine verifies the exact file before allowing Test -> Done. Longer
        // workflows still produce their richer visual proof in Walkthrough.
        requiresEvidenceOn: ["done"],
        requiredEvidenceFile: "evidence.md",
        executePrompt:
          "Run the test phase: write + run the committed correctness gate (and typecheck/lint/build) for each card's slice. " +
          "For EACH card, during THIS attempt create or overwrite `<runDir>/gate-status.test.json`; a pre-existing gate record is stale input, never proof for this attempt. Before emitting the verdict, inspect the gate record you just wrote and replace any stale or invalid `next_phase` so it exactly matches one of THAT card's listed next-options. Use `done` when `done` is that card's green terminal option. " +
          "For every card whose next-options include `done` (Test is its final executable phase), ALWAYS create or overwrite `<runDir>/evidence/evidence.md` before the verdict. Record the exact verification commands you ran, their key results/output, and a concise pass/fail summary so the finished card has durable, user-openable proof.",
        routerPrompt:
          "For each card, use THAT card's listed next-options. Before the verdict, verify this attempt created or overwrote that card's `<runDir>/gate-status.test.json` and that its `next_phase` exactly equals the next-list you emit; replace any stale value first. Emit `<cardId> <the first listed forward option>` if green (especially `<cardId> done` when `done` is its terminal option), or `<cardId> implement` only if it is genuinely failing and implement is listed. Never name a board column outside that card's next-options.",
        validNext: ["adversarial-test", "implement"]
      },
      {
        id: "adversarial-test", title: "Adversarial Test", order: 8, kind: "agent", trigger: "immediate", phase: "adversarial-test",
        executePrompt: "Run the adversarial-test phase: an independent pass drives the running app through the acceptance with its own probes; write the phase's gate-status entry.",
        routerPrompt: "If the independent pass passed — or there is nothing left to test (already complete) — end with `walkthrough`. Only if it genuinely failed, end with `implement`. End with the bare token on its own final line.",
        validNext: ["walkthrough", "implement"]
      },
      {
        id: "walkthrough", title: "Walkthrough", order: 9, kind: "agent", trigger: "immediate", phase: "walkthrough",
        // The engine ENFORCES this: the card cannot advance off Walkthrough unless
        // <runDir>/evidence/ actually contains a file (screenshot or evidence.md).
        requiresEvidence: true,
        executePrompt:
          "Leave TANGIBLE EVIDENCE for this change under the run directory's evidence/ folder (create `<runDir>/evidence/`), and write the walkthrough phase's gate-status entry. This is the proof the user opens on the finished card, so it must always exist:\n" +
          "1. ALWAYS write `<runDir>/evidence/evidence.md` — a short log: WHAT changed (the diff or a concise summary with file:line), and HOW you verified it (the commands you ran + their key output).\n" +
          "2. If the change has ANY visual / UI surface, ALSO capture at least one screenshot of the affected page or state into `<runDir>/evidence/` as a .png. Name it descriptively (e.g. after.png).\n" +
          "3. If the change genuinely warrants a full recorded walkthrough video (real multi-step UI behavior), record it and also set the card's videoUrl.\n" +
          "For a trivial change (a static text/copy/config tweak), steps 1 (and 2 if there's a page) are enough — do NOT force a video. Keep your reply short.",
        routerPrompt: "If you produced the evidence bundle (a screenshot and/or evidence.md under <runDir>/evidence/, plus a video if warranted), end with `validate`. Only if you could not produce ANY evidence at all, end with `implement`. End with the bare token on its own final line.",
        validNext: ["validate", "implement"]
      },
      {
        id: "validate", title: "Validate", order: 10, kind: "agent", trigger: "immediate", phase: "validate",
        executePrompt:
          "Run the validate phase against this card's run directory + slice: check every APPLICABLE DoD gate (tests/typecheck/lint/build/e2e, review, adversarial passes; a phase the card's rail turned OFF is recorded off, never a silent pass) and write the durable gate record. " +
          "CONFIRM the evidence bundle exists under `<runDir>/evidence/` — that tangible proof is part of the DoD. " +
          "A gate that was legitimately size-skipped for a trivial change COUNTS AS SATISFIED, but DO expect at least the evidence.md log. Keep your reply short.",
        routerPrompt: "If the Definition of Done holds — all applicable gates pass, are rail-off, or are size-skip-satisfied AND the evidence bundle exists — end with `done`. Only if a gate genuinely FAILED or NO evidence was produced, end with `implement`. End with the bare token on its own final line.",
        validNext: ["done", "implement"]
      },
      { id: "done", title: "Done", order: 11, kind: "manual", trigger: "manual", terminal: true, validNext: [] },
      {
        id: "needs-attention", title: "Needs attention", order: 12, kind: "manual", trigger: "manual",
        // Always notifies on entry (the surface honours notifyOnEntry). The ONE human
        // touchpoint on the autonomous side (D16): edit, resolve, re-enter the pipeline.
        notifyOnEntry: true,
        validNext: ["todo", "plan", "implement"]
      },
      // A terminal parking column for finished/abandoned cards, so the Done column
      // stays legible. No forward edges — a card leaves it only by a human Move/Unarchive.
      { id: "archived", title: "Archived", order: 13, kind: "manual", trigger: "manual", terminal: true, archived: true, validNext: [] }
    ],
    projects: {}
  };
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
  const other = getList(board, "other");
  const fallback = (board.lists || []).find((list) => list.kind === "agent" && !isInteractive(list));
  const executionList = other?.id ?? fallback?.id ?? null;
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
    duty: other ? "other" : null,
    level: other ? 1 : null,
    sequence: executionList ? [executionList] : null,
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

// The canonical per-phase list configs (prompts, trigger, gate flags), indexed
// by phase id from the default pipeline — the SINGLE source buildBoard reuses so
// a derived board's phase lists carry the same behaviour as the built-in
// pipeline. Structural fields (id/order/validNext) are stripped by buildBoard and
// recomputed from the resolved model.
export function phaseTemplatesFrom(board) {
  const out = {};
  for (const l of board.lists || []) {
    // Capture agent lists AND the interactive Discuss template (S3d) - the resolved-
    // model board reuses its interactive/surface/onEnter behaviour when a composition
    // selects a discuss duty (buildBoard recomputes only its structural edges).
    if (l.kind === "agent" || l.kind === "agent-interactive") out[l.id] = l;
  }
  return out;
}

// The single setup-time reconcile contract. Keeping the prompt-migration
// whitelist beside the canonical seed makes the live setup path and focused
// tests exercise the same ownership-aware merge.
export function reconcileExistingBoard(existingBoard, model) {
  return reconcileBoardLists(existingBoard, model, {
    templates: phaseTemplatesFrom(seedBoard()),
    legacyDefaultPrompts: LEGACY_DEFAULT_PHASE_PROMPTS
  });
}

// The board to seed: DRIVEN BY the resolved model when the runner has projected
// one to ~/.garrison/kanban-loop/model.json (D15 — the fixed human columns plus
// one phase list per leaf duty in the composition's resolved sequences), else the
// built-in default pipeline. seedBoard() itself stays pure (a fixed default) so
// it is safe to call as an in-memory default; the model only drives the board
// that is actually PERSISTED to disk here at --setup.
export function resolveSeedBoard(root) {
  const model = loadResolvedModel(root);
  if (!model) return seedBoard();
  return buildBoard(model, { templates: phaseTemplatesFrom(seedBoard()) });
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
  const boardFile = path.join(root, "board.json");
  if (!existsSync(boardFile)) {
    await atomicWriteJSON(boardFile, resolveSeedBoard(root));
    console.log("kanban-loop: seeded board at", boardFile);
  } else {
    // RECONCILE an existing board's phase-list definitions to the current resolved
    // model (D15): add/drop selected duties and refresh engine-owned mechanics even
    // when the list set is unchanged. Operator config survives; only explicitly
    // recognized historical default prompts migrate. Card state is preserved
    // (membership is derived from card files); any card stranded on a removed list
    // is relocated to needs-attention. No model on disk → leave the board untouched.
    const model = loadResolvedModel(root);
    const existing = model ? await loadBoard(root).catch(() => null) : null;
    if (model && existing) {
      const { board, removed, added, updated } = reconcileExistingBoard(existing, model);
      if (removed.length || added.length || updated.length) {
        await atomicWriteJSON(boardFile, board);
        const moved = await relocateStrandedCards(root, board, removed);
        console.log(
          `kanban-loop: reconciled board (+[${added.join(", ")}] -[${removed.join(", ")}] ~[${updated.join(", ")}]${moved.length ? `, moved ${moved.length} stranded card(s) to needs-attention` : ""}) at`,
          boardFile
        );
      } else {
        console.log("kanban-loop: board up to date with the resolved model at", boardFile);
      }
    } else {
      console.log("kanban-loop: board exists at", boardFile);
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
  if (typeof processCard !== "function" || typeof processBatch !== "function") {
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

// Dispatch goes through the shared, transport-aware gateway client (lib/gateway-client.mjs,
// imported at the top of this file): one wire shape + one failure classification across the
// tick and the board, so a transient gateway failure reverts a card rather than parking it.

// Batched dispatch for the Test list: ONE session per project covering all of the
// project's waiting cards. The prompt is the list's execute/router prompt plus the
// card roster (id + runDir + slice), and the session is asked to emit one verdict line
// per card (`<cardId> <next-list>`); processBatch parses each verdict per card.
// Exported so the board server's manual "Run" can drive a batched list (Test) through
// the SAME batch wire shape the scheduler beat uses (one session per project).
export function batchGatewayRunFn(gatewayUrl) {
  // Delegate the wire to the SAME transport-aware streaming client the per-card
  // path uses (gateway-client.mjs): /chat/stream + the generous kanban per-turn
  // timeout + err.transport classification. The old blocking /chat had NO
  // timeoutMs (the gateway capped a real batched test run at the 5-min PTY
  // default) and died at the HTTP client's ~5-min headersTimeout — either way
  // a legitimate long batch parked its whole project group.
  const streamRunFn = gatewayRunFn(gatewayUrl);
  const batchCard = (project) => {
    if (project === PERSONAL_SCOPE_TOKEN) return { scope: "personal" };
    if (project && project !== "(no-project)") return { project };
    return null;
  };
  const batchLabel = (project) => project === PERSONAL_SCOPE_TOKEN ? "personal" : project;
  return async ({
    project,
    cards,
    list,
    classification,
    skill,
    suppressContinuations,
    nudge,
    duty,
    level,
    phase: routedPhase,
    stepIndex,
    sequence,
    onChunk,
    onJournal
  }) => {
    const routeContext = { duty, level, phase: routedPhase, stepIndex, sequence };
    // A verdict NUDGE (engine backstop) replaces the roster prompt: same
    // session, ask for nothing but the per-card verdict lines.
    if (nudge) {
      return streamRunFn({
        prompt: nudge,
        // A batch runs one session per PROJECT, so the whole group shares a cwd —
        // the same routing.project the per-card path sends. Without it the batch
        // (the Test list) ran in the composition dir too.
        card: batchCard(project),
        classification,
        skill,
        suppressContinuations: suppressContinuations ?? true,
        cardIds: cards.map((c) => c.id).filter(Boolean),
        onChunk,
        onJournal,
        ...routeContext
      });
    }
    // D15 (S4a): each card's valid next steps come from ITS resolved (duty, level)
    // sequence (cached on the card), so a sequence-ended card is offered `done`, not
    // the board's next column. A legacy card (no sequence) falls back to the list's
    // static validNext. Tell the operative each card's own options so the verdict it
    // emits matches what parseBatchVerdicts will accept.
    const phase = phaseForList(list) || list.id;
    const roster = cards
      .map((c) => {
        const opts = validNextForCard(c, phase, null) ?? list.validNext ?? [];
        return `- ${c.id} :: title="${c.title}" runDir=${c.runDir || "(none)"} slice=${c.sliceId || "(none)"} next-options=[${opts.join(" | ")}]`;
      })
      .join("\n");
    // Lead with the list's mode so the gateway switches the operative's face (same as
    // the per-card buildCardPrompt). Inert if the gateway ignores it.
    const mode = (list?.mode || "").trim();
    const prompt = [
      ...(mode ? [`${mode}, take on the following batched test run.`, ""] : []),
      `Batched test run for scope "${batchLabel(project)}". Test ALL of these cards' slices in ONE session against one test plan:`,
      roster,
      "",
      list.executePrompt || "",
      "",
      "Emit ONE verdict line per card, each on its own line, EXACTLY in the form `<cardId> <next-list>` where <next-list> is one of THAT card's own next-options listed above.",
      list.routerPrompt || ""
    ].join("\n");
    return streamRunFn({
      prompt,
      // The batch is grouped BY project, so every card in it shares this cwd.
      card: batchCard(project),
      classification,
      skill,
      suppressContinuations: suppressContinuations ?? true,
      cardIds: cards.map((c) => c.id).filter(Boolean),
      onChunk,
      onJournal,
      ...routeContext
    });
  };
}


// The scheduler tick runs out-of-band (launchd) with no operative, so PING the gateway
// first and skip the whole tick when it is down — immediate cards WAIT for an operative
// instead of every card failing its run and parking in needs-attention.
async function gatewayReachable(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(url, { method: "GET", signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return Boolean(r); // any HTTP response (even 404) means the gateway is up
  } catch {
    return false;
  }
}

// ── Discuss inactivity auto-archive ─────────────────────────────────────────
// A Discuss card is a resumable conversation, which is exactly why it never leaves
// on its own: the list is interactive, the engine never dispatches it, and a
// discussion nobody comes back to sits on the board forever. So a Discuss card that
// has gone quiet for the idle window moves to the terminal `archived` column with an
// event naming the reason. A HELD card archives on the same terms - being parked on
// a question nobody answered for a week IS inactivity.
//
// Archiving is reversible (a human Move brings the card back), needs no gateway, and
// is the least destructive way to say "this conversation is over".
const DEFAULT_DISCUSS_IDLE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// The idle window in ms. GARRISON_KANBAN_DISCUSS_IDLE_DAYS overrides the default (the
// same env-knob shape as GARRISON_KANBAN_ITERATION_CAP); an explicit 0 turns the
// sweep OFF. A non-numeric or negative value falls back to the default rather than
// silently disabling a sweep the operator thought they had configured.
export function discussIdleWindowMs(env = process.env) {
  const raw = String(env.GARRISON_KANBAN_DISCUSS_IDLE_DAYS ?? "").trim();
  if (!raw) return DEFAULT_DISCUSS_IDLE_DAYS * DAY_MS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_DISCUSS_IDLE_DAYS * DAY_MS;
  return Math.round(days * DAY_MS);
}

// The freshest timestamp the CARD ITSELF carries: its created/updated stamps, the
// last of its events, and a live run's start. Deliberately NOT the web channel's
// thread file - the board owns cards, the channel owns threads, and reaching across
// that line to age a card would make the board depend on a surface it does not
// install. Every card write stamps `updated`, so a reply that touches the card (a
// brief link, a hold, a move) counts as activity. Null when a card carries no
// parseable timestamp at all; such a card is never archived, because we cannot prove
// it is idle.
export function lastCardActivityAt(card) {
  let newest = null;
  const consider = (value) => {
    const t = Date.parse(value ?? "");
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  };
  consider(card?.created);
  consider(card?.updated);
  consider(card?.runningSince);
  for (const event of Array.isArray(card?.events) ? card.events : []) consider(event?.at);
  return newest;
}

export async function sweepIdleDiscussCards(
  root,
  board,
  { now = () => Date.now(), windowMs = discussIdleWindowMs() } = {}
) {
  if (!(windowMs > 0)) return [];
  const lists = Array.isArray(board?.lists) ? board.lists : [];
  // Without the terminal column there is nowhere to archive TO, and moving a card to
  // a list the board does not have would make it invisible.
  if (!lists.some((l) => l?.id === "archived")) return [];
  const discussLists = new Set(lists.filter((l) => phaseForList(l) === "discuss").map((l) => l.id));
  if (!discussLists.size) return [];
  const cards = await loadAllCards(root);
  const archived = [];
  for (const card of cards) {
    if (!discussLists.has(card.list)) continue;
    // A live run is not idle. A run that DIED mid-turn is released by
    // sweepOrphanedRuns earlier in this same tick, so it becomes eligible next tick.
    if (card.status === "running") continue;
    const last = lastCardActivityAt(card);
    if (last === null) continue;
    if (now() - last < windowMs) continue;
    const res = await updateCardCAS(root, card.id, (c) => {
      // Re-check against the card the CAS loop just read: a reply may have landed
      // between our scan and this write, and a reply un-idles the conversation.
      if (!discussLists.has(c.list) || c.status === "running") return null;
      const fresh = lastCardActivityAt(c);
      if (fresh === null || now() - fresh < windowMs) return null;
      const idleDays = Math.floor((now() - fresh) / DAY_MS);
      return {
        ...c,
        list: "archived",
        status: "ok",
        runningSince: null,
        events: withEvent(c, {
          at: new Date(now()).toISOString(),
          kind: "archived",
          message: `Archived from Discuss: discuss-inactivity (${idleDays}d quiet)`,
          detail:
            `Nothing touched this Discuss card for ${idleDays} day(s), past the ${Math.round(windowMs / DAY_MS)}-day ` +
            `inactivity window (GARRISON_KANBAN_DISCUSS_IDLE_DAYS). The conversation is kept - move the card back ` +
            `to Discuss to pick it up again.`
        })
      };
    });
    // updateCardCAS returns the UNCHANGED card when the mutate opts out, so a
    // declined re-check is truthy. Only a card that actually landed on `archived`
    // is reported (and logged) as archived.
    if (res?.list === "archived") archived.push(card.id);
  }
  return archived;
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
  // Retire conversations nobody came back to. Local bookkeeping like the sweeps
  // above, so it runs whether or not a gateway is reachable.
  const staleDiscuss = await sweepIdleDiscussCards(root, board).catch((error) => {
    console.log(`kanban-loop: discuss inactivity sweep failed: ${error?.message || error}`);
    return [];
  });
  for (const id of staleDiscuss) console.log(`kanban-loop: archived idle Discuss card ${id} (discuss-inactivity)`);
  if (!gatewayUrl) {
    // Distinct from "the gateway is down": this instance never told the tick WHICH
    // gateway is its own, so dispatching would be a guess. Silently logging
    // "not reachable" here is what hid the dead prod tick for weeks.
    console.log(
      "kanban-loop: NO gateway URL for this instance (neither GARRISON_GATEWAY_URL nor " +
      "GARRISON_GATEWAY_PORT is set) — the tick cannot dispatch. Re-run `kanban.mjs --setup` " +
      "from the running fitting so the job command carries this instance's gateway."
    );
    return;
  }
  if (!(await gatewayReachable(gatewayUrl))) {
    console.log(`kanban-loop: gateway not reachable at ${gatewayUrl} — nothing to dispatch (immediate cards wait for an operative).`);
    return;
  }
  const cap = Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10);
  // Coordination (GARRISON-FLOW-V2 S1): release any waiting cards whose blocker
  // reached its release point BEFORE dispatching, then reload so released cards
  // are seen on their new list this same tick.
  const cards0 = await loadAllCards(root);
  await reevaluateWaiting({ root, board, cards: cards0 }).catch(() => {});
  const cards = await loadAllCards(root);
  const coordCfg = coordinationConfig(loadPolicy());
  const degraded = coordCfg.enabled && !coordinationAvailability().ok && coordCfg.serializeWhenUnavailable;
  const runFn = gatewayRunFn(gatewayUrl);
  const onDutyBoundary = compactBoundaryFn(gatewayUrl);
  let processed = 0;
  for (const card of cards) {
    const list = getList(board, card.list);
    if (!list) continue;
    // S3d review R2: a clarity-gated discuss card whose move-time dispatch failed is
    // otherwise stranded (the tick skips agent-interactive lists). Let it THROUGH the
    // list-kind/trigger/interactive guards so the tick self-heals it like any agent
    // list; a card held-for-go is left alone (processCard's discuss-held guard skips it,
    // and !discussHeld gates it here too).
    // §7.1: a card the router held below its autonomy threshold is waiting for a
    // go and the tick must not answer on the human's behalf. A held card sits in
    // the capture list, which the list-kind guard below already skips, so this is
    // belt-and-suspenders in the same spirit as the discuss-held skip - and it is
    // checked BEFORE the gated-discuss exemption, which is the one path that
    // deliberately walks past those guards.
    if (card.autonomyHeld === true) continue;
    const gatedDiscuss = isGatedDiscuss(card, list) && card.discussHeld !== true;
    if (!gatedDiscuss) {
      if (list.kind !== "agent") continue;                // manual / agent-interactive skip
      if (triggerFor(list) !== "immediate") continue;     // scheduler-beat / manual skip
      if (isInteractive(list)) continue;                  // belt-and-suspenders
    }
    if (card.status === "running" || card.status === "needs-attention") continue;
    if (card.waitingOn) continue;                         // deferred behind an overlapping run
    // Serialize gate (D9): coordination enabled but its substrate is unusable —
    // run only the oldest live card per project until it recovers.
    if (degraded) {
      const gate = serializeGate(cards, card, board);
      if (!gate.allowed) { console.log(`kanban-loop: card ${card.id} → ${gate.reason}`); continue; }
    }
    const { outcome } = await processCard({ root, board, card, runFn, cap, onDutyBoundary });
    console.log(`kanban-loop: card ${card.id} → ${outcome.status}${outcome.to ? " " + outcome.to : ""}`);
    processed++;
  }
  console.log(`kanban-loop: tick processed ${processed} card(s)`);
}

// Process ONE list. For a batched list (Test) this is the per-project batched path
// invoked by the Test scheduler beat; for any other agent list it falls back to the
// per-card path (manual single-list kick).
async function tickList(listId) {
  const gatewayUrl = resolveGatewayUrl();
  // Parity with tick(): release lost runs first (no operative needed), and say
  // "no gateway configured" distinctly from "the gateway is down". Without the
  // first branch this would print `gateway not reachable at null` — the same
  // indistinguishable message that hid the dead prod tick for weeks.
  const orphans = await sweepOrphanedRuns(kanbanRoot()).catch(() => []);
  for (const id of orphans) console.log(`kanban-loop: released a lost run on card ${id} (retryable)`);
  // Same beat, the cross-machine case: a dispatched card whose worker stopped
  // heartbeating. Needs no gateway either — reclaiming is local bookkeeping.
  const reclaimed = await sweepExpiredDispatchClaims(kanbanRoot()).catch(() => []);
  for (const id of reclaimed) console.log(`kanban-loop: reclaimed card ${id} from a silent outpost`);
  if (!gatewayUrl) {
    console.log(
      "kanban-loop: NO gateway URL for this instance (neither GARRISON_GATEWAY_URL nor " +
      "GARRISON_GATEWAY_PORT is set) — the beat cannot dispatch. Re-run `kanban.mjs --setup` " +
      "from the running fitting so the job command carries this instance's gateway."
    );
    return;
  }
  if (!(await gatewayReachable(gatewayUrl))) {
    console.log(`kanban-loop: gateway not reachable at ${gatewayUrl} — nothing to dispatch (cards wait for an operative).`);
    return;
  }
  const root = kanbanRoot();
  const board = await loadBoard(root);
  const list = getList(board, listId);
  if (!list || list.kind !== "agent") {
    console.log(`kanban-loop: list '${listId}' is not an agent list — nothing to dispatch.`);
    return;
  }
  const cap = Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10);
  // Release waiting cards first (same as tick), then read fresh.
  const cards0 = await loadAllCards(root);
  await reevaluateWaiting({ root, board, cards: cards0 }).catch(() => {});
  const cards = await loadAllCards(root);
  const coordCfg = coordinationConfig(loadPolicy());
  const degraded = coordCfg.enabled && !coordinationAvailability().ok && coordCfg.serializeWhenUnavailable;

  if (list.batched) {
    const batchRunFn = batchGatewayRunFn(gatewayUrl);
    const listCards = cards.filter((c) => c.list === listId);
    const { outcomes } = await processBatch({ root, board, listId, cards: listCards, batchRunFn, cap, cwd: process.cwd() });
    const projects = new Set(outcomes.map((o) => o.project));
    for (const o of outcomes) {
      console.log(`kanban-loop: [${o.project}] card ${o.id} → ${o.status}${o.to ? " " + o.to : ""}`);
    }
    console.log(`kanban-loop: --tick-list ${listId} batched ${outcomes.length} card(s) across ${projects.size} project(s)`);
    return;
  }

  const runFn = gatewayRunFn(gatewayUrl);
  const onDutyBoundary = compactBoundaryFn(gatewayUrl);
  let processed = 0;
  for (const card of cards) {
    if (card.list !== listId) continue;
    if (card.status === "running" || card.status === "needs-attention") continue;
    if (card.waitingOn) continue;                         // deferred behind an overlapping run
    if (degraded) {
      const gate = serializeGate(cards, card, board);
      if (!gate.allowed) { console.log(`kanban-loop: card ${card.id} → ${gate.reason}`); continue; }
    }
    const { outcome } = await processCard({ root, board, card, runFn, cap, onDutyBoundary });
    console.log(`kanban-loop: card ${card.id} → ${outcome.status}${outcome.to ? " " + outcome.to : ""}`);
    processed++;
  }
  console.log(`kanban-loop: --tick-list ${listId} processed ${processed} card(s)`);
}

// Only dispatch the CLI when run directly (so `import { seedBoard }` from a test is
// side-effect-free).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = process.argv[2];
  if (arg === "--setup") await setup();
  else if (arg === "--probe") await probe();
  else if (arg === "--tick") await tick();
  else if (arg === "--tick-list") await tickList(process.argv[3]);
  else if (arg === "--review") await review();
  else if (arg === "--seed-morning-brief") await seedMorningBrief();
  else console.log("usage: kanban.mjs --setup | --probe | --tick | --tick-list <id> | --review | --seed-morning-brief");
}
