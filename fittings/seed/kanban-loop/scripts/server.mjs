#!/usr/bin/env node
// Kanban Loop own-port server (V1b, port 27089). Serves the responsive,
// phone-first board UI (dist/) and a small REST surface over lib/board.mjs +
// lib/engine.mjs. It NEVER duplicates artifacts: a card stores POINTERS
// (runId/runDir/sliceId/sessionIds/briefPath/videoUrl) and this server resolves
// + read-only serves the files those pointers name (plan, gate markers, the
// Claude Code transcript, the walkthrough video) so the UI can OPEN them in
// place. Watch streams a card's latest log-N.md over SSE for a live run; when
// nothing is live it sends the linked static logs and closes (the pooled gateway
// operative is raw node-pty, NOT tmux-attachable, so there is no attach path —
// see the v4 wireframe §4 / the board-ui brief).
//
// Scaffolding (strict configured-port bind, status-file registration under
// ~/.garrison/ui-fittings/<id>.json, CORS, static dist/ serve, graceful
// shutdown) follows the dev-env / web-channel own-port precedent. The pure
// request helpers (buildBoardView, resolveCardLinks, the path-confinement guard,
// isReadableFile) are EXPORTED so tests/kanban-board-ui.test.ts can unit-test
// them without a live socket.

import { createReadStream, existsSync, statSync, accessSync, realpathSync, readFileSync, readdirSync, constants as fsConstants } from "node:fs";
import { mkdir, readFile, unlink, writeFile, rm, appendFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  kanbanRoot,
  loadBoard,
  saveBoard,
  saveBoardCAS,
  loadAllCards,
  loadCard,
  createCard,
  saveCardCAS,
  saveCardCASWithHooks,
  withFileLock,
  withCardOrderLock,
  deleteCard,
  deriveMembership,
  appendCardLog,
  latestCardLogNumber,
  cardBriefFile,
  cardBriefRel,
  normalisePlacement,
  sanitiseCardRouting,
  atomicWriteJSON,
  normaliseScheduledFor,
  normaliseScheduleAction,
  normaliseChecklist,
  cardPosition,
  cardAttachmentsDir,
  listCardAttachments,
  CARD_SCOPES,
  cardScope, listProseLabel } from "../lib/board.mjs";
// S3a: the lifecycle event router — the server emits `created` after a card is made.
// §7.1: it also poses an autonomy hold's question through the card's own origin.
import { routeOriginEvent, createdMessage, routeNeedsInput } from "../lib/notify-origin.mjs";
// Kanban → Drill handoff: a done card's change brief, posted to the Drill fitting.
import { sendCardToDrill, drillEligibility, resolveDrillProject, drillStamp } from "../lib/drill-handoff.mjs";
import { readOriginRecord, readOriginEventsSince } from "../lib/origins.mjs";
// S3c: steering sidecars (steering.md guidance + steering.json revisit directive).
import { STEER_ACTIONS, appendSteeringMd, writeSteeringDirective, markSteeringApplied, readSteeringDirective, isEarlierPhase } from "../lib/steering.mjs";
import {
  getList,
  validNextFor,
  processCard,
  processChain,
  processBatch,
  advanceCardPhase,
  recoverInterruptedRuns,
  triggerFor,
  isInteractive,
  isGatedDiscuss,
  withEvent,
  replySnippet,
  parkFields,
  consumeStartOverrides,
  ATTENTION_LIST,
  sweepDueSchedules
} from "../lib/engine.mjs";
import { runScheduleNow } from "../lib/engine.mjs";
import { scheduleValidationError, normaliseCardSchedule, nextCronOccurrence } from "../lib/schedules.mjs";
import {
  kanbanModelFile,
  loadResolvedModel,
  hasExecutionModel,
  resolveCardSequence,
  executionRouteFor
} from "../lib/resolved-model.mjs";
import { batchGatewayRunFn, reconcileExistingBoard, relocateStrandedCards, registerSchedulerBeats } from "./kanban.mjs";
import { recordBrief, briefRelPath } from "./discuss.mjs";
import { gatewayRunFn, inferenceRunFn, compactBoundaryFn, interruptCardTurn, projectNameForRouting } from "../lib/gateway-client.mjs";
import { inferProject, explicitWorkspaceFromCard } from "../lib/infer-project.mjs";
import { loadPolicy, railForCard, railIsManualOnly, phaseTogglesFromCsv } from "../lib/policy.mjs";
import {
  readTouchSet,
  inspectTouchSet,
  coordinationConfig,
  coordinationAvailability,
  serializeGate,
  repoPathForProject,
  claimCovers,
  acquireLeases,
  isHumanHeld,
  refreshCardTouchSetIntent,
  cleanupCardCoordination
} from "../lib/coordination.mjs";
import { prepareRevert, executeRevert } from "../lib/fences.mjs";
import { listProjects, readDevRoot, resolveProjectName, listSkills } from "../lib/discover.mjs";
import { syncListBeat } from "../lib/scheduler-beats.mjs";
import { reconcilePersonalCompletionOutbox } from "../lib/personal-memory-outbox.mjs";
import { reconcileMorningBriefDeliveries } from "../lib/morning-briefing.mjs";
import { claudeProjectDirForCwd, claudeProjectsDir } from "@garrison/claude-pty";
// WS2: the artifact-ref vocabulary lives in lib/links.mjs (shared with the handoff
// packet generator). Re-exported below so existing importers (tests) keep working.
import {
  resolveArtifactRef as resolveArtifactRefCore,
  isValidSliceId,
  isSafeEvidenceName,
  isEvidenceImage,
  enumerateArtifactRefs
} from "../lib/links.mjs";
export { isValidSliceId, isSafeEvidenceName, isEvidenceImage };
// Rich-Log SSE tail of the Claude Code transcript per card session (parser copy
// in lib/session-transcript.mjs, canonical in the drill fitting).
import {
  readJsonlLines,
  parseTranscriptLines,
  extractRelatedTaskRecords,
  relatedTaskEvents
} from "../lib/session-transcript.mjs";
import { readLiveSessionPointer } from "../lib/live-session.mjs";
import {
  CardImportError,
  NATIVE_CARD_BUNDLE_KIND,
  NATIVE_CARD_BUNDLE_VERSION,
  normaliseCardImport
} from "../lib/card-import.mjs";
// Terminal modal: an interactive shell PTY per card over the /io WebSocket.
import { WebSocketServer } from "ws";
import { spawnPty, getPty, resizePty, killPty, shutdownPtys } from "./ptys.mjs";
// Host-aware URL rewriting: loopback ports → their HTTPS tailnet form, for the
// GET /host-map the UI reads (see ui/host-rewrite.ts).
import { getTailnetServeMap } from "../lib/tailnet-serve.mjs";
import { resolvePersonalWorkspaceSync } from "../lib/personal-workspace.mjs";

const FITTING_ID = "kanban-loop";
const DEFAULT_PORT = 7089;
const HOME = os.homedir();
// GARRISON_HOME (when set) IS the .garrison root - the sandbox convention every
// own-port fitting follows so spawned test instances never touch live status files.
const STATUS_ROOT = path.join(process.env.GARRISON_HOME || path.join(HOME, ".garrison"), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);

// The working directory Kanban runs operatives in. runDir pointers are
// project-relative (docs/autothing/runs/<runId>), and the Claude Code transcript
// for a session is keyed by the encoded cwd, so both resolve against this root.
// Overridable for tests / non-default checkouts.
function projectRoot() {
  return process.env.GARRISON_KANBAN_PROJECT_ROOT || process.cwd();
}

// The composition-scoped uploads dir where ClaudeChat writes attached files
// (POST /attachments → <compositionDir>/.garrison/uploads). Its OWN narrow
// confine set for the attachment read route — never widened into allowedRoots.
function uploadsDir() {
  return path.join(process.env.GARRISON_COMPOSITION_DIR || process.cwd(), ".garrison", "uploads");
}

// Parse the ClaudeChat-appended attachment block out of a card description
// (issue #2). ClaudeChat appends "\n\nAttached file(s):\n- <abs path>…" to the
// message body; we scan for that header, then collect the CONTIGUOUS list of
// absolute-path bullet lines. Derived, never stored. Returns
// [{ i, path, name, image }] in appearance order.
function parseAttachments(description) {
  const text = typeof description === "string" ? description : "";
  const lines = text.split("\n");
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!inBlock) {
      if (/^Attached files?:/i.test(line.trim())) inBlock = true;
      continue;
    }
    const m = line.match(/^- (\/.+\S)$/);
    if (!m) break; // the contiguous attachment list ended
    const p = m[1];
    const name = path.basename(p);
    out.push({ i: out.length, path: p, name, image: isEvidenceImage(name) });
  }
  return out;
}

// The working directory a card's Terminal shell opens in. This mirrors the
// gateway's wire boundary: routing.project wins over card.project, and either
// must be a confined direct-child project NAME resolving to a Git repo. An
// invalid explicit project is refused instead of silently opening a different
// cwd. Personal is only the fallback when neither project field was supplied.
export function cardWorkdir(card, opts) {
  const routingProject = typeof card?.routing?.project === "string" ? card.routing.project.trim() : "";
  const cardProject = typeof card?.project === "string" ? card.project.trim() : "";
  const specifiedProject = routingProject || cardProject;
  if (specifiedProject) {
    // routing.project is a strict run-spec name. Only the older top-level card
    // field supports path-shaped records, and then solely by reducing them to a
    // name before the same confined resolver dispatch uses.
    const projectName = routingProject || projectNameForRouting(cardProject);
    const resolved = projectName
      ? resolveProjectName(projectName, { devRoot: opts?.devRoot || readDevRoot() })
      : null;
    if (resolved) return resolved;
    throw new Error(`selected project is not a Git repository under the configured dev root: ${specifiedProject}`);
  }
  if (cardScope(card) === "personal") {
    const personal = resolvePersonalWorkspaceSync({
      home: opts?.garrisonHome || process.env.GARRISON_HOME || path.join(HOME, ".garrison")
    });
    if (!personal) {
      throw new Error("personal workspace is unavailable; run kanban setup and verify it is not a symlink");
    }
    return personal;
  }
  return opts?.cwd || projectRoot();
}

// ─────────────────────────── pure helpers (exported, unit-tested)

// Build the board view the UI renders: the list defs (in order) plus the cards
// decorated with their DERIVED list membership (membership is never stored —
// board.deriveMembership scans the cards). Each list carries its cards inline so
// the phone UI renders a column per list without a second round-trip; the flat
// `cards` array is kept too for clients that prefer it.
// When a card last DID anything: its newest event instant, else its creation
// instant. The archive sort key for terminal lists - a card finished today
// belongs at the top of Done even if it was created weeks ago.
function lastActivityInstant(card) {
  const events = Array.isArray(card?.events) ? card.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const t = Date.parse(events[i]?.at ?? "");
    if (Number.isFinite(t)) return t;
  }
  const created = Date.parse(card?.created ?? "");
  return Number.isFinite(created) ? created : 0;
}

export function buildBoardView(board, cards) {
  const membership = deriveMembership(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lists = (board.lists || [])
    .slice()
    // userOrder is the OPERATOR-owned column order (drag-reorder writes it;
    // reconcile preserves it because it is not engine-owned). Falls back to
    // the engine's spine order for untouched boards and freshly added lists.
    .sort((a, b) => {
      if (a.id === "scheduled") return -1;
      if (b.id === "scheduled") return 1;
      return (a.userOrder ?? a.order ?? 0) - (b.userOrder ?? b.order ?? 0);
    })
    .map((list) => ({
      id: list.id,
      title: list.title,
      order: list.userOrder ?? list.order ?? 0,
      kind: list.kind || "manual",
      trigger: triggerFor(list),
      interactive: Boolean(isInteractive(list)),
      // D15: phase only — skill/taskType/tier/mode live in the compiled policy.
      phase: list.phase ?? (list.kind === "agent" ? list.id : null),
      terminal: Boolean(list.terminal),
      notifyOnEntry: Boolean(list.notifyOnEntry),
      system: Boolean(list.system),
      validNext: Array.isArray(list.validNext) ? list.validNext : [],
      cards: (membership[list.id] || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        // Within-list order: explicit position (drag-reorder) or created
        // instant — one comparator, ties broken by id so the order is total.
        // Terminal lists (done/archived) are an ARCHIVE, not a queue: most
        // recently FINISHED first (last event instant - drag positions and
        // creation order are meaningless there), or a freshly finished card
        // lands invisibly at the bottom of dozens of old ones ("my card
        // disappeared", 2026-08-07).
        .sort((a, b) => {
          if (list.terminal || list.id === "done" || list.id === "archived") {
            return lastActivityInstant(b) - lastActivityInstant(a) || (a.id < b.id ? 1 : -1);
          }
          return cardPosition(a) - cardPosition(b) || (a.id < b.id ? -1 : 1);
        })
        .map(cardSummary)
    }));
  return { version: board.version ?? 2, lists, cards: cards.map(cardSummary) };
}

// The card fields the board front renders: title, project chip, list, iter/cap,
// goalMode, status — plus the pointer set (so the UI can show Open without a
// second fetch). It is a projection, not a copy of any artifact body.
// ── expected execution identity (the badges a card carries BEFORE it runs) ───
//
// card.lastRoute only exists once a turn has SETTLED, so a queued card — and a
// card for the entire duration of its run, which is exactly when you want to know
// what is burning — showed no runtime/model/effort at all. The resolved model the
// runner projects to ~/.garrison/kanban-loop/model.json already knows the answer
// for any (duty, level, phase), so compute and serialize it. It is labelled
// EXPECTED and rendered dashed in the UI: it is what the card WILL run on, never
// a claim about what did run.
let _modelCache = { key: null, model: null };
function resolvedModelCached(root) {
  try {
    const file = kanbanModelFile(root);
    const key = `${file}:${statSync(file).mtimeMs}`;
    if (_modelCache.key !== key) _modelCache = { key, model: loadResolvedModel(root) };
    return _modelCache.model;
  } catch {
    return null;
  }
}

export function expectedRouteFor(card, model) {
  if (!card || !model || !hasExecutionModel(model)) return null;
  const duty = typeof card.duty === "string" && card.duty ? card.duty : null;
  if (!duty) return null;
  const level = Number.isInteger(card.level) ? card.level : 1;
  const sequence = resolveCardSequence(card, model) || [];
  // On a phase list, the phase IS that list. Off one (backlog / todo / done), show
  // the FIRST phase of the card's sequence — the step it would run next.
  const idx = sequence.indexOf(card.list);
  const phase = idx >= 0 ? card.list : (sequence[0] ?? null);
  const stepIndex = idx >= 0 ? idx : (sequence.length ? 0 : null);
  const r = executionRouteFor({ duty, level, phase, stepIndex }, model);
  if (!r) return null;
  const t = r.target && typeof r.target === "object" ? r.target : {};
  return {
    targetId: r.targetId ?? null,
    runtime: t.runtime ?? null,
    provider: t.provider ?? null,
    model: t.model ?? null,
    effort: t.effort ?? null,
    phase: r.phase ?? phase ?? null,
    duty,
    level,
    skill: r.skill ?? null
  };
}

// Runtime capability required before a card may be placed remotely. When the
// card already carries its resolved duty/level/sequence, inspect that exact
// phase cell. A hand-authored card has not been routed yet, so use the active
// composition's first runnable phase as the explicit default instead of merely
// asking whether the worker is generically "ready".
export function remoteRuntimeRequirement(input = {}, model = null) {
  if (typeof input?.dispatchCommand === "string" && input.dispatchCommand.trim()) return null;
  if (!hasExecutionModel(model)) return null;
  const explicitDuty = typeof input?.duty === "string" && input.duty.trim()
    ? input.duty.trim()
    : typeof input?.routing?.duty === "string" && input.routing.duty.trim()
      ? input.routing.duty.trim()
      : null;
  const fallbackDuty = (Array.isArray(model.kanbanLists) ? model.kanbanLists : [])
    .find((candidate) => model.steps?.[candidate]?.["1"]?.length);
  const duty = explicitDuty || fallbackDuty || null;
  if (!duty) return null;
  const requestedLevel = Number.isInteger(input?.level) && input.level > 0
    ? input.level
    : Number.isInteger(input?.routing?.level) && input.routing.level > 0
      ? input.routing.level
      : 1;
  const sequence = Array.isArray(input?.sequence) && input.sequence.length
    ? input.sequence
    : model.sequences?.[duty]?.[String(requestedLevel)] || [];
  const requestedPhase = typeof input?.phase === "string" && input.phase.trim()
    ? input.phase.trim()
    : typeof input?.list === "string" && sequence.includes(input.list)
      ? input.list
      : null;
  const phase = requestedPhase || sequence[0] || duty;
  const stepIndex = sequence.indexOf(phase);
  const route = executionRouteFor({
    duty,
    level: requestedLevel,
    phase,
    stepIndex: stepIndex >= 0 ? stepIndex : null
  }, model);
  if (!route?.target?.runtime) return null;
  const provider = typeof route.target.provider === "string" && route.target.provider
    ? route.target.provider
    : null;
  return {
    key: `${route.target.runtime}:${provider || "unknown"}`,
    targetId: route.targetId,
    runtime: route.target.runtime,
    provider,
    model: route.target.model ?? null,
    duty,
    level: requestedLevel,
    phase
  };
}

export function appendDispatchRunProvenance(card, run) {
  if (!run || typeof run.runId !== "string" || !run.runId.trim()) {
    return Array.isArray(card?.dispatchRuns) ? card.dispatchRuns : [];
  }
  const entry = {
    runId: run.runId.trim(),
    machine: typeof run.machine === "string" ? run.machine.slice(0, 160) : "remote",
    workerId: typeof run.workerId === "string" ? run.workerId.slice(0, 160) : null,
    phase: typeof run.phase === "string" ? run.phase.slice(0, 80) : null,
    state: ["done", "failed", "cancelled"].includes(run.state) ? run.state : "failed",
    claimedAt: typeof run.claimedAt === "string" ? run.claimedAt : null,
    completedAt: typeof run.completedAt === "string" ? run.completedAt : new Date().toISOString(),
    logIndex: Number.isInteger(run.logIndex) ? run.logIndex : null,
    sessionId: typeof run.sessionId === "string" ? run.sessionId.slice(0, 200) : null,
    logCursor: Number.isSafeInteger(run.logCursor) && run.logCursor >= 0 ? run.logCursor : 0,
    evidenceManifest: Array.isArray(run.evidenceManifest) ? run.evidenceManifest.slice(0, 64) : []
  };
  const previous = Array.isArray(card?.dispatchRuns)
    ? card.dispatchRuns.filter((candidate) => candidate?.runId !== entry.runId)
    : [];
  return [...previous, entry].slice(-100);
}

export function cardSummary(card) {
  // The card's LATEST commit fence (S2, Q5) — the board shows only the most recent
  // one as a subtle chip; the full chain lives on the card, not in this projection.
  const fenceList = Array.isArray(card.fences) ? card.fences : [];
  const lastFence = fenceList.length ? fenceList[fenceList.length - 1] : null;
  return {
    id: card.id,
    title: card.title ?? "(untitled)",
    project: card.project ?? null,
    // Explicit task ownership, independent of the execution flow. Derive it
    // for pre-scope cards so old card.json files need no destructive migration.
    scope: cardScope(card),
    list: card.list,
    status: card.status ?? "ok",
    iterations: card.iterations ?? 0,
    goalMode: Boolean(card.goalMode),
    rev: card.rev ?? 0,
    runId: card.runId ?? null,
    runDir: card.runDir ?? null,
    sliceId: card.sliceId ?? null,
    sessionIds: Array.isArray(card.sessionIds) ? card.sessionIds : [],
    briefPath: card.briefPath ?? null,
    videoUrl: card.videoUrl ?? null,
    // S4 (D2/D17): the run-policy fields — the flow naming the rail, the
    // per-card phase toggles (OFF phases render as dimmed chips: honesty), the
    // tier, and who registered the run.
    flow: card.flow ?? null,
    phases: card.phases ?? null,
    tier: card.tier ?? null,
    // RUN-SPEC-V1: the card's explicit run spec. It MUST cross the projection or
    // the whole control is write-only — the engine reads the card from disk, so a
    // spec left out here is still honored at run time but can never be shown back
    // to the user or pre-filled for an edit. ("What did I choose for this card?"
    // has to be answerable from the card.)
    routing: card.routing ?? null,
    origin: card.origin ?? null,
    // Outpost Dispatch: WHERE the card runs, and the live claim ledger. Both
    // are surfaced so the board can show the machine a running card is on.
    placement: normalisePlacement(card.placement, card.outpost),
    dispatch: card.dispatch ?? null,
    // Immutable per-claim provenance. `dispatch` is only the current/latest
    // claim and is overwritten by the next phase; these entries keep every
    // prior rich Outpost stream reachable from Watch.
    dispatchRuns: Array.isArray(card.dispatchRuns) ? card.dispatchRuns : [],
    dispatchCommand: card.dispatchCommand ?? null,
    // D15 (S4a): the card's resolved-model journey — its duty + level and the
    // cached ordered leaf phase lists it visits (skipping the rest).
    duty: card.duty ?? null,
    level: card.level ?? null,
    sequence: Array.isArray(card.sequence) ? card.sequence : null,
    // The level each duty in that sequence runs at (the flow's pins, plus any
    // escalation applied to THIS card). It has to cross the projection for the
    // same reason `routing` does: the engine reads the card off disk, so a field
    // left out here is still honored at run time but can never be shown back -
    // and "why did review run at level 3?" must be answerable from the card.
    dutyLevels: card.dutyLevels ?? null,
    // WS2 (D7): the predecessor card id this card continues (null for a fresh card).
    continues: card.continues ?? null,
    // S3a (D8): the card's origin id ("web:<threadId>" | "skill:..." | "board").
    origin_id: card.origin_id ?? null,
    // S3d (D9b): the dispatcher's specification-clarity verdict - "needs-discuss"
    // means the card ran (or is running) the Discuss duty before plan.
    clarity: card.clarity ?? null,
    // S3d (D9b, review R3): true when the card is HELD on Discuss by an explicit gate,
    // awaiting a human go (a Move, or an affirmative reply the gateway routes as a move).
    discussHeld: card.discussHeld === true,
    // §7.1: true when the ROUTER held this card below its lower autonomy
    // threshold, awaiting a go. Both fields must cross the projection: the
    // gateway's channel-agnostic resume (discuss-intercept) reads the held flag
    // and the resume list straight off this summary, so leaving them out would
    // make "go" a word that works on the board and nowhere else - the exact
    // parity break §5.2 was about.
    autonomyHeld: card.autonomyHeld === true,
    autonomyAsk: card.autonomyAsk ?? null,
    // The band the router acted under when it did NOT have to ask, carried so the
    // board can say what it is doing at first dispatch and so the card explains
    // itself afterwards.
    autonomy: card.autonomy ?? null,
    // D19: a quick card is a trivial-plan task the gateway ran inline and
    // auto-advanced to Done. The Done column groups these under a collapsed
    // "quick tasks" strip, and they are never engine-owned (operator-touchable).
    quick: Boolean(card.quick),
    // The last dispatch failure (set by engine.processCard on transport defer
    // or run-failed, and by handlePatchCard when an auto-dispatch can't reach
    // the gateway). The UI renders a clear badge + Retry button when this is
    // non-null. A successful dispatch clears it back to null.
    lastDispatchError: card.lastDispatchError ?? null,
    // Coordination (GARRISON-FLOW-V2 S1): when this card is deferred behind an
    // overlapping same-project run, waitingOn carries the blocker + why + until;
    // stabilityAt marks its own first-review stability point; planCompletedAt is
    // the total-order key; blocking lists the cards waiting on THIS one. The UI
    // renders a waiting callout + chips (amber, distinct from the parked red).
    waitingOn: card.waitingOn ?? null,
    stabilityAt: card.stabilityAt ?? null,
    planCompletedAt: card.planCompletedAt ?? null,
    blocking: Array.isArray(card.blocking) ? card.blocking : [],
    // Coordination (GARRISON-FLOW-V2 S2): the LATEST fence (phase + short-able sha +
    // when) for a card whose runs committed touch-set fences, and the abandonment
    // prepared-revert descriptor thinned for the UI — its state (prepared | applied |
    // conflict), the commit COUNT, up to 20 short shas + the conflictRisk count for the
    // detail's commit list, and when it was prepared. The board front shows the count +
    // a Confirm-revert button; the detail lists the shas. The full descriptor lives on
    // the card + in <runDir>/coordination/prepared-revert.json, never in this projection.
    fences: lastFence ? { phase: lastFence.phase ?? null, sha: lastFence.sha ?? null, at: lastFence.at ?? null } : null,
    preparedRevert: card.preparedRevert
      ? {
          state: card.preparedRevert.state ?? "prepared",
          commits: Array.isArray(card.preparedRevert.commits) ? card.preparedRevert.commits.length : 0,
          commitShas: (Array.isArray(card.preparedRevert.commits) ? card.preparedRevert.commits : [])
            .slice(0, 20)
            .map((s) => String(s).slice(0, 10)),
          conflictRisk: Array.isArray(card.preparedRevert.conflictRisk) ? card.preparedRevert.conflictRisk.length : 0,
          preparedAt: card.preparedRevert.preparedAt ?? null
        }
      : null,
    // The card's Drill handoff, if it was ever sent: { state (planning | running |
    // passed | failed | error), jobId, runUrl, findings, … }. The board renders it
    // as a chip on a done card + the Send-to-Drill button's live state.
    drill: card.drill ?? null,
    // Why a card is parked + where it came from (set by the engine when it moves a
    // card to the needs-attention column). The UI shows the reason on the card.
    attentionReason: card.attentionReason ?? null,
    parkedFrom: card.parkedFrom ?? null,
    // ── execution visibility (board front) ────────────────────────────────
    // A short task description (the operative's context + the card front tooltip);
    // the operative's last reply snippet (so the card shows WHAT it said, not just
    // that it parked); the most-recent timeline event + the total count (the card
    // front shows "last: …"; the full timeline is on the detail); and when the
    // current run started (the live elapsed timer). The full `events` array is NOT
    // in this projection (it can be long) — GET /cards/:id carries it for the detail.
    description: typeof card.description === "string" ? card.description : "",
    lastReply: card.lastReply ?? null,
    lastEvent: lastEventOf(card),
    // Per-phase runtime/model attribution for the card front: the most recent routed
    // event's route stamp ({ targetId, runtime, provider, model, effort,
    // effortApplied, tier, phase }), or
    // null when no turn has routed yet / a legacy non-routed runtime. The board renders a small
    // "<phase> @ <model>" chip from it.
    lastRoute: lastRouteOf(card),
    // What this card WILL run on (resolved from its duty/level + the current phase),
    // so a queued or in-flight card carries runtime/model/effort badges too — not
    // just a card whose turn already settled.
    // kanbanRoot() explicitly, not an implicit default: it is the SAME source
    // parseArgs uses for opts.root, so the badge can never resolve its model from a
    // different instance's kanban home than the rest of the server reads.
    expectedRoute: expectedRouteFor(card, resolvedModelCached(kanbanRoot())),
    eventCount: Array.isArray(card.events) ? card.events.length : 0,
    runningSince: card.runningSince ?? null,
    // Project-inference state for a no-project card: running | done | none | skipped |
    // failed | null (never attempted). The UI shows "inferring project…" while running.
    inferState: card.inferState ?? null,
    // Card scheduling: when the card is held until / what happens at the due
    // instant (notify | run) / whether the reminder already fired. The card
    // front shows a clock chip; the detail exposes the picker.
    scheduledFor: card.scheduledFor ?? null,
    scheduleAction: card.scheduleAction ?? null,
    scheduleNotifiedAt: card.scheduleNotifiedAt ?? null,
    schedule: card.schedule ?? null,
    scheduleTemplateId: card.scheduleTemplateId ?? null,
    scheduleSystemKey: card.scheduleSystemKey ?? null,
    occurrenceKey: card.occurrenceKey ?? null,
    occurrenceAt: card.occurrenceAt ?? null,
    systemKey: card.systemKey ?? null,
    morningBriefDelivery: card.morningBriefDelivery ?? null,
    // Within-list ordering (drag-reorder writes position; null = created order).
    position: typeof card.position === "number" && Number.isFinite(card.position) ? card.position : null,
    // Checklist progress for the card-front chip; the full items ride the detail.
    checklistTotal: Array.isArray(card.checklist) ? card.checklist.length : 0,
    checklistDone: Array.isArray(card.checklist) ? card.checklist.filter((i) => i && i.done === true).length : 0,
    // `created` crosses so the drag layer can compute effective positions with
    // the EXACT value the server sorts by (cardPosition falls back to it).
    created: card.created ?? null,
    updated: card.updated ?? null
  };
}

// ── card export / import (Item 4) ────────────────────────────────────────────
//
// A list of cards leaves the board as ONE JSON bundle and comes back the same way.
// EXPORT_CARD_FIELDS is the ALLOW-LIST of card fields that travel (composition-
// transfer's principle: a bundle is shared, so an unknown field must never ride
// along). This ONE const drives BOTH the export projection and the import reader, so
// the two can never drift.
//
// What travels: the human-authored content + the run SPEC (routing pin, flow,
// tier, phase toggles) + the schedule. What NEVER travels: identity (id/rev), the
// lifecycle (status/iterations), all run evidence (runId/runDir/sessionIds/briefPath/
// events/logIndex), coordination state (waitingOn/blocking/fences/preparedRevert/
// coordinationSeq/planCompletedAt/stabilityAt), the outpost/placement/dispatch ledger,
// origin*/continues/duty/level/sequence, the within-list `position`, and above all the
// literal `dispatchCommand` — a shell command that must never cross machines.
export const EXPORT_CARD_FIELDS = [
  "title",
  "description",
  "project",       // a LABEL (board.projects maps it to a path on THIS machine), never a path
  "scope",         // personal | project | unscoped; independent of execution flow
  "acceptance",
  "goalMode",
  "checklist",
  "routing",       // the RUN-SPEC-V1 pin (scalars only; re-sanitised on import)
  "flow",
  "tier",
  "phases",
  "scheduledFor",
  "scheduleAction",
  "schedule"
];

export const CARDS_BUNDLE_KIND = NATIVE_CARD_BUNDLE_KIND;
export const CARDS_BUNDLE_VERSION = NATIVE_CARD_BUNDLE_VERSION;
export const MAX_CHECKLIST_ITEMS = 100;
export const MAX_CHECKLIST_ITEM_CHARACTERS = 64 * 1024;
const DEFAULT_JSON_BODY_BYTES = 16 * 1024 * 1024;

export function isMachineLocalPath(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  // Match the gateway's safe project-label boundary: a project that travels is
  // a dev-root child NAME, never an absolute, relative, UNC, URI, or dot path.
  // This lexical check deliberately does not require the label to exist on the
  // exporting host; portability is what matters here.
  return path.isAbsolute(text)
    || text.includes("/")
    || text.includes("\\")
    || text.includes("..")
    || text.startsWith(".")
    || /^~(?:[\\/]|$)/.test(text)
    || /^[A-Za-z]:/.test(text)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/i.test(text);
}

// ClaudeChat appends this exact machine-local attachment block to a prompt. It
// is useful inside one host but must never turn into a fake attachment or leak a
// home path when a card bundle moves elsewhere.
export function stripAttachedFilesBlock(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\n{2,}Attached files?:\n(?:- [^\n]*(?:\n|$))+\s*$/i, "").trimEnd();
}

function portableChecklist(value) {
  if (!Array.isArray(value)) return value;
  return value
    .filter((item) => item && typeof item === "object" && typeof item.text === "string" && item.text.trim())
    .map((item) => ({ text: item.text.trim(), done: item.done === true }));
}

function portablePhases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, enabled]) => /^[A-Za-z0-9_-]{1,80}$/.test(key) && typeof enabled === "boolean")
      .slice(0, 64)
  );
}

// ── per-duty levels on a card (the level chain's storage boundary) ──────────
// `dutyLevels` is {<dutyId>: 1|2|3}: the level EACH duty in the card's sequence
// runs at once the flow definition's pins are applied. It is written once at
// creation and afterwards only ever RAISED, by an escalation.
//
// The 1..3 bound mirrors level-resolution.mjs's MIN_LEVEL/MAX_LEVEL. The board
// cannot import the orchestrator fitting, and a bound is exactly the kind of
// thing that must be enforced where the write happens rather than trusted from
// the caller - a card is read by the engine long after whoever wrote it is gone.
export const MAX_DUTY_LEVELS = 32;
const DUTY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate a `dutyLevels` map. Returns {value} or {error}; absent → {value: null}. */
export function validateDutyLevels(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "dutyLevels must be an object or null" };
  const entries = Object.entries(raw);
  if (entries.length > MAX_DUTY_LEVELS) {
    return { error: `dutyLevels names ${entries.length} duties; the maximum is ${MAX_DUTY_LEVELS}` };
  }
  const out = {};
  for (const [duty, level] of entries) {
    if (!DUTY_ID_RE.test(duty)) return { error: `dutyLevels: invalid duty id "${duty}"` };
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      return { error: `dutyLevels.${duty} must be an integer 1-3` };
    }
    out[duty] = level;
  }
  return { value: Object.keys(out).length ? out : null };
}

/**
 * Merge a `dutyLevels` patch over what the card already carries, RAISE-ONLY.
 *
 * The raise-only rule lives in level-resolution.mjs because escalation is
 * fail-safe and de-escalation is not (worst case of a raise is compute spent;
 * worst case of a lower is unreviewed work shipped). It is enforced AGAIN here
 * because this is the storage boundary: a caller that never went through
 * `escalateDuty` - a hand-rolled PATCH, a future surface, a retry with a stale
 * body - must not be able to walk a level back down. Refused, never clamped: a
 * silent clamp would let the caller believe it had lowered something.
 */
export function mergeDutyLevels(existing, patch) {
  const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const merged = { ...current };
  for (const [duty, level] of Object.entries(patch || {})) {
    const held = current[duty];
    if (Number.isInteger(held) && level < held) {
      return { error: `dutyLevels.${duty} would lower ${held} → ${level}; a level may only be raised` };
    }
    merged[duty] = level;
  }
  return { value: merged };
}

export function checklistValidationError(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return "checklist must be an array or null";
  if (value.length > MAX_CHECKLIST_ITEMS) {
    return `checklist has ${value.length} items; the maximum is ${MAX_CHECKLIST_ITEMS}`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item && typeof item === "object" && typeof item.text === "string" && item.text.length > MAX_CHECKLIST_ITEM_CHARACTERS) {
      return `checklist item ${index + 1} exceeds the ${MAX_CHECKLIST_ITEM_CHARACTERS.toLocaleString("en-US")}-character limit`;
    }
  }
  return null;
}

// Project a card down to the export bundle's shape: the allow-listed content fields
// plus two INFORMATIONAL source markers (sourceList, created) that are NOT re-imported
// — the importer reads only EXPORT_CARD_FIELDS and lets createCard mint everything else.
export function exportCard(card) {
  const out = {};
  for (const f of EXPORT_CARD_FIELDS) {
    // `project` is visited immediately before `scope`. Derive non-personal scope
    // from the project that actually survived portability scrubbing, not from a
    // machine-local path that was intentionally omitted from the bundle.
    const value = f === "scope"
      ? cardScope({ scope: card.scope, project: out.project ?? null })
      : card[f];
    if (value === undefined) continue;
    if (f === "project" && isMachineLocalPath(value)) continue;
    if (f === "description") {
      out.description = stripAttachedFilesBlock(value);
      continue;
    }
    if (f === "checklist") {
      out.checklist = portableChecklist(value);
      continue;
    }
    if (f === "phases") {
      out.phases = portablePhases(value);
      continue;
    }
    if (f === "routing") {
      const routing = sanitiseCardRouting(value);
      if (routing?.project && isMachineLocalPath(routing.project)) delete routing.project;
      if (routing && Object.keys(routing).length) out.routing = routing;
      continue;
    }
    out[f] = value;
  }
  out.sourceList = card.list ?? null;
  out.created = card.created ?? null;
  return out;
}

// The most recent timeline event (or null) — what the card front shows as "last
// activity". The full history is on the detail (GET /cards/:id).
function lastEventOf(card) {
  const ev = Array.isArray(card.events) ? card.events : [];
  return ev.length ? ev[ev.length - 1] : null;
}

// The most recent routed event's route stamp (or null) — the card front's per-phase
// attribution chip reads from it. Scans BACK through the timeline because a later
// fence / coordination event can sit on top of the routed one, so lastEventOf alone
// would miss it.
function lastRouteOf(card) {
  const ev = Array.isArray(card.events) ? card.events : [];
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i] && ev[i].route && typeof ev[i].route === "object") return ev[i].route;
  }
  return null;
}

// The last few non-empty lines of a running card's current iteration log — the live
// "tail" the card front shows so you can see the operative WORKING without opening
// Watch. Best-effort + bounded: a missing/short log just yields "".
function liveTailFor(root, card, maxLines = 3, maxChars = 240) {
  try {
    const n = latestCardLogNumber(root, card);
    if (!n || card.status !== "running") return "";
    const f = path.join(root, "cards", card.id, `log-${n}.md`);
    if (!isReadableFile(f)) return "";
    const text = readFileSync(f, "utf8");
    const lines = text
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() && !/^# iteration \d+$/.test(l.trim()) && l.trim() !== "_dispatching to the operative…_");
    const tail = lines.slice(-maxLines).join("\n");
    return tail.length > maxChars ? "…" + tail.slice(tail.length - maxChars) : tail;
  } catch {
    return "";
  }
}

// The decision-10 links for a card (the v4 wireframe §2 "Card open" table). Each
// is a POINTER, not a copy: a `serve` path (the server's /artifact?path= route,
// for files it can read) or an external `href` (videoUrl). The transcript path
// is resolved from the sessionId via claudeProjectDirForCwd (FINDING:
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl). `root` defaults to the
// kanban board root (where cards/<id>/log-N.md live); `cwd` is the project root
// the run + transcript resolve against.
// The roots an artifact path may live under: the project root (legacy
// plan/gate paths), the board root (per-card logs), the Claude Code projects
// dir (session transcripts), and the evidence home ~/.garrison/runs (S6/D19 —
// where run directories live now). A served path must be inside ONE of these —
// the read side (handleArtifact) re-confines against the SAME set.
export function runsHomeDir() {
  return (
    process.env.GARRISON_RUNS_DIR ||
    path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "runs")
  );
}

export function allowedRoots(cwd = projectRoot(), root = kanbanRoot()) {
  return [cwd, root, claudeProjectsDir(), runsHomeDir()];
}

export function resolveCardLinks(card, { root = kanbanRoot(), cwd = projectRoot() } = {}) {
  const roots = allowedRoots(cwd, root);
  const mk = (ref) => serveRef(card.id, ref, resolveArtifactRef(card, ref, { root, cwd }), roots);
  const links = {
    plan: null,
    brief: null,
    gateMarkers: null,
    // Root-level durable gate records (`gate-status.<phase>.json` and the
    // aggregate `gate-status.json`). These are the actual phase evidence used
    // by D9 and exist independently of the legacy slice marker below.
    gates: [],
    evidenceIndex: null,
    // The always-on evidence bundle (<runDir>/evidence/): screenshots + an evidence.md
    // log the pipeline produces even when the heavy walkthrough VIDEO is size-skipped.
    // Each entry carries `name` + `image` so the UI renders images inline and links the
    // rest. Enumerated from disk (read-only) so whatever the operative wrote shows up.
    evidence: [],
    sessions: [],
    video: null,
    logs: []
  };
  if (card.runDir) {
    links.plan = mk("plan");
    links.evidenceIndex = mk("evidenceIndex");
    if (card.sliceId) links.gateMarkers = mk("gateMarkers");
    const runRoot = confinePath(path.resolve(cwd, card.runDir), roots);
    if (runRoot && existsSync(runRoot)) {
      let gateNames = [];
      try {
        gateNames = readdirSync(runRoot, { withFileTypes: true })
          .filter((d) => d.isFile() && /^gate-status(?:\.[A-Za-z0-9_-]+)?\.json$/.test(d.name))
          .map((d) => d.name)
          .sort();
      } catch { gateNames = []; }
      const phaseOrder = new Map((Array.isArray(card.sequence) ? card.sequence : [])
        .map((phase, i) => [String(phase), i]));
      gateNames.sort((a, b) => {
        // Put concrete phase evidence first in the card's configured workflow
        // order; keep the aggregate gate-status.json after the sidecars.
        if (a === "gate-status.json") return b === "gate-status.json" ? 0 : 1;
        if (b === "gate-status.json") return -1;
        const ap = a.slice("gate-status.".length, -".json".length);
        const bp = b.slice("gate-status.".length, -".json".length);
        const ai = phaseOrder.has(ap) ? phaseOrder.get(ap) : Number.MAX_SAFE_INTEGER;
        const bi = phaseOrder.has(bp) ? phaseOrder.get(bp) : Number.MAX_SAFE_INTEGER;
        return ai - bi || ap.localeCompare(bp);
      });
      links.gates = gateNames.map((name) => mk(`gate:${name}`));
    }
    // List the evidence dir (confined first), newest meaningful order: images before the
    // log so the visual proof leads. A missing dir / read error just yields no evidence.
    const evDir = confinePath(path.resolve(cwd, card.runDir, "evidence"), roots);
    if (evDir && existsSync(evDir)) {
      let names = [];
      // Only REGULAR FILES are servable evidence — a subdir would otherwise enumerate as
      // a serve link that 404s on click (and hide any nested file), so filter it here.
      try { names = readdirSync(evDir, { withFileTypes: true }).filter((d) => d.isFile() && isSafeEvidenceName(d.name)).map((d) => d.name); } catch { names = []; }
      names.sort((a, b) => (isEvidenceImage(b) ? 1 : 0) - (isEvidenceImage(a) ? 1 : 0) || a.localeCompare(b));
      for (const name of names) {
        const ref = serveRef(card.id, `evidence:${name}`, resolveArtifactRef(card, `evidence:${name}`, { root, cwd }), roots);
        if (ref.kind === "serve") links.evidence.push({ name, image: isEvidenceImage(name), ...ref });
      }
    }
  }
  // The card-owned brief (<root>/cards/<id>/brief.md) is deterministic — surface the
  // link whenever the file exists, even while the card is still in Discuss (so it's
  // viewable/editable during the discussion, not only after Move-out links it).
  if (card.briefPath || isReadableFile(cardBriefFile(root, card.id))) links.brief = mk("brief");
  // The Claude Code transcript per run: ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
  const sids = Array.isArray(card.sessionIds) ? card.sessionIds : [];
  sids.forEach((sessionId, i) => {
    links.sessions.push({ sessionId, ...mk(`session:${i}`) });
  });
  // The walkthrough video is an external gallery link (FINDING 8): show it as a
  // link, never proxy/duplicate the bytes.
  if (card.videoUrl) {
    links.video = { kind: "href", href: card.videoUrl };
  }
  // The card's own per-iteration logs (cards/<id>/log-N.md) — what Watch shows
  // when nothing is live.
  const latestLog = latestCardLogNumber(root, card);
  for (let n = 1; n <= latestLog; n++) {
    links.logs.push({
      n,
      ...serveRef(card.id, `log:${n}`, path.join(root, "cards", card.id, `log-${n}.md`), roots)
    });
  }
  return links;
}

// Server-facing compatibility projection over the shared links vocabulary. Keep
// the newer shared resolver as the default, while retaining the board's existing
// plan.md fallback, phase-gate refs, and monotonic log ordinals.
export function resolveArtifactRef(card, ref, { root = kanbanRoot(), cwd = projectRoot() } = {}) {
  if (!card || typeof ref !== "string") return null;
  if (ref === "plan") {
    if (!card.runDir) return null;
    const canonical = path.resolve(cwd, card.runDir, "FLOW_PLAN.md");
    const fallback = path.resolve(cwd, card.runDir, "plan.md");
    return isReadableFile(canonical) || !isReadableFile(fallback) ? canonical : fallback;
  }
  const gate = ref.match(/^gate:(gate-status(?:\.[A-Za-z0-9_-]+)?\.json)$/);
  if (gate) return card.runDir ? path.resolve(cwd, card.runDir, gate[1]) : null;
  const log = ref.match(/^log:(\d+)$/);
  if (log) {
    const n = Number(log[1]);
    return n >= 1 && n <= latestCardLogNumber(root, card)
      ? path.join(root, "cards", card.id, `log-${n}.md`)
      : null;
  }
  return resolveArtifactRefCore(card, ref, { root, cwd });
}

// One artifact pointer: { kind:"serve", ref, path:<abs>, url:"/cards/<id>/artifact?ref=…",
// exists }. The url names the card + an OPAQUE ref token — NEVER an absolute path —
// so the read route re-derives the path server-side (resolveArtifactRef) and a
// client can never ask for an arbitrary file. `path`/`exists` are kept for
// server-side use + tests. A path outside the allowed roots (or a null ref) is
// marked unservable (kind:"missing") rather than handed out.
function serveRef(cardId, ref, absPath, roots) {
  if (!absPath) return { kind: "missing", ref, path: null, exists: false };
  const confined = confinePath(absPath, roots);
  if (!confined) return { kind: "missing", ref, path: absPath, exists: false };
  return {
    kind: "serve",
    ref,
    path: absPath,
    url: `/cards/${encodeURIComponent(cardId)}/artifact?ref=${encodeURIComponent(ref)}`,
    exists: existsSync(absPath)
  };
}

// Canonicalize a path through symlinks AS FAR AS IT EXISTS, then append the
// not-yet-existing tail. This defeats a symlinked ANCESTOR being used to escape a
// root (e.g. a `link` inside the root pointing outside): realpath resolves it to
// the real target so the prefix check below sees the true location. A path whose
// existing prefix can't be realpath'd falls back to the lexical resolve.
function realpathSafe(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch (e) {
      if (e.code !== "ENOENT") return path.resolve(p);
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Path-confinement guard (link-never-duplicate is read-only AND traversal-safe):
// canonicalize `candidate` (through symlinks, via realpathSafe) and accept it only
// when it is inside one of `roots`. Any `..` escape, a symlink that points outside
// a root, a path outside every allowed root, or a non-string is rejected (null).
// Each root is itself canonicalized so a symlinked or relative root still confines.
export function confinePath(candidate, roots) {
  if (typeof candidate !== "string" || !candidate) return null;
  const resolved = realpathSafe(candidate);
  for (const r of roots) {
    if (typeof r !== "string" || !r) continue;
    const base = realpathSafe(r);
    // Inside the root, or exactly the root. The trailing sep stops
    // "/a/bcd" from passing for root "/a/bc".
    if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  }
  return null;
}

// A card id MUST be a ULID (26 Crockford base32 chars, excludes I/L/O/U). The
// router matches `/cards/([^/]+)` on the still-ENCODED segment, so a decoded id
// like `..%2f..%2fsecret` would otherwise reach path.join(root,"cards",id,...) and
// traverse out of the board root (read via loadCard, write via saveCardCAS). This
// guard rejects any id that is not a clean ULID before it touches the filesystem.
export function isValidCardId(id) {
  return typeof id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

// isValidSliceId / isSafeEvidenceName / isEvidenceImage moved to lib/links.mjs
// (shared with the handoff generator) and imported/re-exported at the top.

// A list id is client-editable (PATCH /lists/:listId) and flows into a board
// lookup, so it MUST be a clean kebab token — no path separators or `..`. The
// list id never touches the filesystem directly (the board is one file), but the
// guard keeps the route surface uniform with the card-id guard and rejects junk
// before it reaches applyListConfig.
export function isValidListId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(s) && s.length <= 64;
}

// A cron field for a scheduler-beat list (the schedule the beat fires on) or null.
// Validate the SHAPE — a 5-field POSIX cron (min hour dom mon dow), each field built
// only from cron-legal chars — so a bad value can't register a never-firing/garbage
// beat; the scheduler does the authoritative parse at fire time. Empty → null.
function cleanCronField(v) {
  if (v == null) return { value: null };
  if (typeof v !== "string") return { error: "must be a cron string or null" };
  const s = v.trim();
  if (!s) return { value: null };
  if (/[\n\r]/.test(s)) return { error: "must be a single line" };
  const fields = s.split(/\s+/);
  if (fields.length !== 5) return { error: "must be a 5-field cron expression (min hour day-of-month month day-of-week)" };
  if (!fields.every((f) => /^[*0-9,\-/]+$/.test(f))) return { error: "contains characters that aren't valid in a cron field" };
  return { value: s };
}

// A multi-line prompt field (executePrompt / routerPrompt): any string is fine
// (these are sent verbatim to the operative as instructions); only the type is
// checked. Empty collapses to "".
function cleanPromptField(v) {
  if (v == null) return { value: "" };
  if (typeof v !== "string") return { error: "must be a string" };
  return { value: v };
}

// A list's trigger is restricted to this set so a typo can't silently turn an
// agent list into a never-firing column.
const VALID_TRIGGERS = new Set(["immediate", "manual", "scheduler-beat"]);

// The fields a MANUAL / terminal list (kind "manual") may edit — it has no
// agent behavior, so only its label + routing are configurable.
const MANUAL_EDITABLE = new Set(["title", "validNext"]);
// The agent-only fields a manual list must NEVER accept (rejected with a clear
// error rather than silently ignored, so the UI can't half-configure a column).
const AGENT_ONLY_FIELDS = ["executePrompt", "routerPrompt", "trigger", "beatCron"];

// applyListConfig — the pure list-config updater. Reads `listId` from `board`,
// applies ONLY the editable fields PRESENT in `patch`, validates each, and
// returns { board, list } (a NEW board object, never mutating the input) or
// { error }. Structure (id / order / kind) is never touched. Editability is
// gated by the list's kind:
//   - manual: only title + validNext (agent-only fields are REJECTED).
//   - agent-interactive (Discuss): editable like an agent list but interactive
//     stays true and mode is kept (its trigger stays manual unless explicitly set).
//   - agent: title, executePrompt, routerPrompt, validNext, trigger, beatCron.
// D15: skill/taskType/tier/mode are NO LONGER per-list settings — resolution
// comes from the compiled Orchestrator policy; the patch REJECTS those keys.
// validNext must be a subset of the board's existing list ids; trigger must be
// a known trigger.
export function applyListConfig(board, listId, patch) {
  if (!board || !Array.isArray(board.lists)) return { error: "invalid board" };
  if (!isValidListId(listId)) return { error: "invalid list id" };
  const idx = board.lists.findIndex((l) => l.id === listId);
  if (idx < 0) return { error: `unknown list: ${listId}` };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { error: "patch must be an object" };
  }

  const current = board.lists[idx];
  const isManual = (current.kind || "manual") === "manual";
  const listIds = new Set(board.lists.map((l) => l.id));
  const next = { ...current };

  // A manual list rejects every agent-only field outright (don't silently drop
  // them — a half-applied config is worse than a clear error).
  if (isManual) {
    for (const f of AGENT_ONLY_FIELDS) {
      if (f in patch) return { error: `cannot edit '${f}' on a manual list (only title + validNext)` };
    }
    for (const f of Object.keys(patch)) {
      if (!MANUAL_EDITABLE.has(f)) return { error: `cannot edit '${f}' on a manual list (only title + validNext)` };
    }
  }

  if ("title" in patch) {
    if (typeof patch.title !== "string" || !patch.title.trim()) return { error: "title must be a non-empty string" };
    const t = patch.title.trim();
    if (/[\n\r]/.test(t)) return { error: "title must be a single line" };
    next.title = t;
  }

  if ("validNext" in patch) {
    const vn = patch.validNext;
    if (!Array.isArray(vn)) return { error: "validNext must be an array" };
    for (const t of vn) {
      if (typeof t !== "string") return { error: "validNext entries must be strings" };
      if (!listIds.has(t)) return { error: `validNext contains unknown list: ${t}` };
    }
    // De-dupe while preserving order.
    next.validNext = [...new Set(vn)];
  }

  // D15: per-list skill/taskType/tier/mode config is DEAD — resolution comes
  // from the compiled Orchestrator policy. Reject the keys outright (a clear
  // error beats a silently-dropped field); the composer view is where routing
  // is configured now.
  for (const dead of ["skill", "taskType", "tier", "mode"]) {
    if (dead in patch) {
      return { error: `'${dead}' is no longer a per-list setting — resolution comes from the compiled Orchestrator policy (edit it in the Orchestrator composer view)` };
    }
  }

  if ("executePrompt" in patch) {
    const r = cleanPromptField(patch.executePrompt);
    if (r.error) return { error: `executePrompt: ${r.error}` };
    next.executePrompt = r.value;
  }

  if ("routerPrompt" in patch) {
    const r = cleanPromptField(patch.routerPrompt);
    if (r.error) return { error: `routerPrompt: ${r.error}` };
    next.routerPrompt = r.value;
  }

  if ("trigger" in patch) {
    if (!VALID_TRIGGERS.has(patch.trigger)) {
      return { error: `trigger must be one of: ${[...VALID_TRIGGERS].join(", ")}` };
    }
    next.trigger = patch.trigger;
  }

  if ("beatCron" in patch) {
    const r = cleanCronField(patch.beatCron);
    if (r.error) return { error: `beatCron: ${r.error}` };
    next.beatCron = r.value;
  }

  // Structure never changes: pin id/order/kind back to the on-board values even
  // if the patch tried to set them (it can't — they're not handled above — but
  // belt-and-suspenders against a future field leak), and an interactive list
  // keeps interactive:true.
  next.id = current.id;
  next.order = current.order;
  next.kind = current.kind;
  if (current.interactive) next.interactive = true;

  const lists = board.lists.slice();
  lists[idx] = next;
  return { board: { ...board, lists }, list: next };
}

// A path is safe to stream only if it is a readable REGULAR FILE (a directory
// passes existsSync but cannot be streamed).
export function isReadableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// A Move onto this list should AUTO-START the card's run iff it is an IMMEDIATE agent
// list — not a manual column, not an interactive list (Discuss), not a scheduler-beat
// list (Test, which runs batched on its own beat). This is what makes "moving a card to
// Plan start planning" instead of silently parking it.
export function shouldAutoDispatch(board, listId) {
  const l = getList(board, listId);
  return !!l && l.kind === "agent" && !isInteractive(l) && triggerFor(l) === "immediate";
}

// Is a card LIVE — occupying its project's serialize slot / counting as an overlap
// candidate? Mirrors coordination.mjs's isLiveCard (which is module-private there):
// a card is live when it is running, waiting behind another card, or has a minted
// runDir on a non-terminal list. Kept byte-aligned with that predicate so the
// board's create-time provisional check agrees with the engine's overlap scan.
function isCardLive(board, c) {
  if (!c) return false;
  if (c.waitingOn) return true;
  if (c.status === "running") return true;
  if (c.runDir) {
    const list = getList(board, c.list);
    if (!(list && (list.terminal || c.list === "done"))) return true;
  }
  return false;
}

// Is the gateway actually up? PING it before dispatching so a Move/Start while no
// operative is running LEAVES the card on its list to wait — instead of firing a
// doomed run that processCard would convert into a needs-attention park. Any HTTP
// response (even 404) means up; a connection error / timeout means down.
async function gatewayReachable(url) {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(url, { method: "GET", signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return Boolean(r);
  } catch {
    return false;
  }
}

// CSRF/SSRF guard for mutating routes — same shape as dev-env: same-origin (our
// own iframe) or no Origin (curl / server-to-server) is allowed; a cross-origin
// browser POST is rejected.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ─────────────────────────── http plumbing

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = DEFAULT_JSON_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += c.length;
    if (Number.isFinite(maxBytes) && bytes > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`);
      err.code = "BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(c);
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

// ─────────────────────────── REST handlers

// GET /cards[?origin_id=…] (S3b): the flat card list, optionally filtered to one
// origin. Most-recent-first (by created). cardSummary already carries origin_id.
async function handleListCards(req, res, opts, query) {
  const originId = typeof query?.origin_id === "string" && query.origin_id ? query.origin_id : null;
  let cards = await loadAllCards(opts.root);
  if (originId) cards = cards.filter((c) => (c.origin_id ?? null) === originId);
  cards.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  jsonRes(res, 200, { cards: cards.map(cardSummary) });
}

// GET /origins/:originId (S3e) - the origin record (transport, address, thread), or
// 404 when the origin has no record yet. The id is sanitised to a safe filename by
// safeOriginId (origins.mjs), so an encoded path cannot traverse out of the store.
async function handleGetOrigin(req, res, opts, originId) {
  const record = readOriginRecord(opts.root, originId);
  if (!record) return jsonRes(res, 404, { error: `no origin record: ${originId}` });
  return jsonRes(res, 200, { origin: record });
}

// GET /origins/:originId/events?since=<ISO|line-offset> (S3e) - the PULL delivery a
// skill/terminal session polls: the durable lifecycle events (created/needs-input/
// blocked/failed/finished/duty-summary/steering) written by S3a for EVERY transport,
// capped to the last 200. `since` is a line offset (integer) or an ISO timestamp;
// `total` is the full line count so the caller polls incrementally with since=total.
async function handleGetOriginEvents(req, res, opts, originId, query) {
  const since = typeof query?.since === "string" && query.since ? query.since : null;
  const { events, total } = readOriginEventsSince(opts.root, originId, since);
  return jsonRes(res, 200, { origin_id: originId, events, total, nextSince: String(total) });
}

// GET /cards/:id/handoff (S3b) — the WS2 handoff packet (completionSummary,
// decisions, files, evidence manifest, chain), or 404 when none exists yet.
async function handleGetHandoff(req, res, opts, id) {
  const file = path.join(opts.root, "cards", id, "handoff.json");
  if (!isReadableFile(file)) return jsonRes(res, 404, { error: "no handoff for this card" });
  try {
    return jsonRes(res, 200, { handoff: JSON.parse(readFileSync(file, "utf8")) });
  } catch {
    return jsonRes(res, 404, { error: "handoff unreadable" });
  }
}

// POST /cards/:id/steer {message, action, revisitDuty?, reason?, viaTurn?} (S3c):
// write the steering sidecars, record a timeline + origin event, and — when the
// card is NOT running and the action is revisit — apply the re-stage immediately.
async function handleSteerCard(req, res, opts, id) {
  const body = (await readBody(req)) || {};
  const message = typeof body.message === "string" ? body.message : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!STEER_ACTIONS.includes(action)) return jsonRes(res, 400, { error: "action must be absorb | revisit | acknowledge" });
  let card;
  try {
    card = await loadCard(opts.root, id);
  } catch {
    return jsonRes(res, 404, { error: "no such card" });
  }
  card.id = id;
  const at = new Date().toISOString();
  const revisitDuty = typeof body.revisitDuty === "string" && body.revisitDuty ? body.revisitDuty : null;
  const reason = typeof body.reason === "string" ? body.reason : null;
  // Go-back invariant: a revisit must target an EARLIER phase in the card's sequence
  // — reject a direct POST that would march the card FORWARD past gates.
  if (action === "revisit") {
    if (!revisitDuty) return jsonRes(res, 400, { error: "revisit requires revisitDuty" });
    if (!isEarlierPhase(card, revisitDuty)) {
      return jsonRes(res, 400, { error: `revisitDuty "${revisitDuty}" is not an earlier phase in the card's sequence` });
    }
  }

  let applied = false;
  // An idle revisit is one lifecycle transition, not a preflight + retrying
  // update pair. Rev/existence are validated before restoring the coordination
  // hold, and the card cannot become running/abandoned/deleted underneath us.
  if (action === "revisit" && revisitDuty && card.status !== "running") {
    const board = await loadBoard(opts.root);
    if (getList(board, revisitDuty)) {
      let events = withEvent(card, {
        at,
        kind: "steering",
        message: `Steering: ${action} → ${revisitDuty}`,
        detail: reason || null
      });
      events = withEvent({ events }, {
        at,
        kind: "steering-restage",
        message: `Re-staged to ${revisitDuty} (steering)`
      });
      const target = {
        ...card,
        // A human sending a card back through the pipeline is a fresh, approved pass:
        // clear the park reason and RESET the iteration counter (the convergence guard),
        // exactly like un-parking. Without this a card re-staged from needs-attention
        // (parked AT the cap) would trip the cap on its first tick and re-park, and a
        // done card would burn straight into it. The runDir + steering.md carry the
        // prior context forward, so "same card, same context" holds.
        ...unparkRecoveryFields(card),
        list: revisitDuty,
        status: "ok",
        runningSince: null,
        events
      };
      const moved = await saveCardCASWithHooks(opts.root, target, card.rev ?? 0, at, {
        beforeWrite: ({ next }) => prepareRecoveredCoordinationHold(board, next),
        afterWrite: () => {
          appendSteeringMd(opts.root, id, { at, action, message });
          writeSteeringDirective(opts.root, id, { at, action, revisitDuty, reason, applied: false });
          markSteeringApplied(opts.root, id);
        }
      });
      if (moved.precondition) return coordinationRecoveryConflict(res, moved.detail);
      if (moved.deleted) return jsonRes(res, 404, { error: "card was deleted while you were steering it" });
      if (!moved.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(moved.card) });
      card = moved.card;
      applied = true;
    }
  }
  if (!applied) {
    // Running revisits remain pending until the engine's next duty boundary;
    // absorb/acknowledge only append guidance + a timeline event. Keep their
    // sidecars in the same external lifecycle lock too: writing steering.md
    // before a guarded card save let a concurrent Delete remove the card, then
    // the late sidecar write recreate cards/<id>/ without card.json.
    const steered = await saveCardCASWithHooks(
      opts.root,
      {
        ...card,
        events: withEvent(card, {
          at,
          kind: "steering",
          message: `Steering: ${action}${revisitDuty ? ` → ${revisitDuty}` : ""}`,
          detail: reason || null
        })
      },
      card.rev ?? 0,
      at,
      {
        afterWrite: () => {
          appendSteeringMd(opts.root, id, { at, action, message });
          if (action === "revisit" && revisitDuty) {
            writeSteeringDirective(opts.root, id, { at, action, revisitDuty, reason, applied: false });
          }
        }
      }
    );
    if (steered.deleted) return jsonRes(res, 404, { error: "card was deleted while you were steering it" });
    if (!steered.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(steered.card) });
    card = steered.card;
  }
  // The short confirmation, recorded to the origin event log (web-delivered unless
  // the gateway turn already delivered it — detail.viaTurn).
  const confirmation =
    action === "absorb"
      ? `Noted — folded into the current ${card.list} work.`
      : action === "revisit"
        ? applied
          ? `Going back to ${revisitDuty} to include that.`
          : `Going back to ${revisitDuty} at the next duty boundary.`
        : "Noted.";
  try {
    const fresh = await loadCard(opts.root, id).catch(() => card);
    fresh.id = id;
    routeOriginEvent(opts.root, null, fresh, { kind: "steering", message: confirmation, detail: { action, revisitDuty, viaTurn: body.viaTurn === true, applied } });
  } catch {
    /* origin routing is best-effort */
  }
  jsonRes(res, 200, { ok: true, action, revisitDuty, applied });
}

async function handleBoard(req, res, opts) {
  const root = opts.root;
  const board = await loadBoard(root);
  const cards = await loadAllCards(root);
  const view = buildBoardView(board, cards);
  // Enrich RUNNING cards with a live log tail so the card front shows the operative
  // actually working (not just a pulsing dot). Done here rather than in the pure
  // cardSummary because it needs the board root + a file read; running cards are few
  // (usually 0–1), so the cost is negligible. Both the per-list and the flat card
  // projections are separate objects, so patch both.
  const tails = {};
  const steeringPending = {};
  for (const c of cards) {
    if (c.status === "running") tails[c.id] = liveTailFor(root, c);
    // S3c: a cheap sidecar check (existsSync-gated) so the board renders a steering
    // chip while a revisit directive is pending (unapplied).
    if (readSteeringDirective(root, c.id)) steeringPending[c.id] = true;
  }
  const patch = (cs) => {
    if (!cs) return;
    if (tails[cs.id]) cs.liveTail = tails[cs.id];
    if (steeringPending[cs.id]) cs.steeringPending = true;
  };
  for (const l of view.lists) l.cards.forEach(patch);
  view.cards.forEach(patch);
  jsonRes(res, 200, view);
}

async function handleGetCard(req, res, opts, id) {
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — never trust the on-disk id field
  const links = resolveCardLinks(card, { root, cwd: opts.cwd });
  jsonRes(res, 200, {
    card: cardSummary(card),
    // The full checklist items (the summary carries only the counts).
    checklist: Array.isArray(card.checklist) ? card.checklist : [],
    links,
    // Two attachment sources, one list: card-owned uploads (cards/<id>/
    // attachments/, served by opaque artifact ref, deletable) and the legacy
    // ClaudeChat description block (derived, read-only).
    attachments: [
      ...listCardAttachments(root, id).map((a) => ({
        name: a.name,
        image: /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name),
        url: `/cards/${encodeURIComponent(id)}/artifact?ref=${encodeURIComponent(`attachment:${a.name}`)}`,
        uploaded: true
      })),
      ...parseAttachments(card.description).map((a) => ({
        i: a.i,
        name: a.name,
        image: a.image,
        url: `/cards/${encodeURIComponent(id)}/attachment?i=${a.i}`
      }))
    ],
    decisionLog: card.decisionLog ?? card.runs ?? [],
    // The FULL execution timeline (the detail's Activity feed). Newest first so the
    // UI renders most-recent-at-top without re-sorting.
    events: (Array.isArray(card.events) ? card.events : []).slice().reverse()
  });
}

// Apply a mutation to a card CAS-safely, re-reading + retrying a few times on a
// concurrent write — so a background inference write and a user move never clobber each
// other. `mutate(card)` returns the next card, or null to abort (no write). Returns the
// final card or null.
async function updateCard(root, id, mutate, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let card;
    try { card = await loadCard(root, id); } catch { return null; }
    card.id = id;
    const next = mutate(card);
    if (!next) return card;
    const res = await saveCardCAS(root, next, card.rev ?? 0);
    if (res.ok) return res.card;
  }
  return null;
}

// Distinct projects already in use across the board (capped) — bias inference toward an
// existing project when one fits, instead of minting a fresh slug each time.
function knownProjectsFrom(cards, max = 24) {
  const seen = [];
  for (const c of cards) {
    const p = typeof c.project === "string" ? c.project.trim() : "";
    if (p && !seen.includes(p)) seen.push(p);
    if (seen.length >= max) break;
  }
  return seen;
}

const inferEvent = (kind, message, detail) => ({ at: new Date().toISOString(), kind: "inference", message, ...(detail ? { detail } : {}) });

// Infer a no-project card's project via a short gateway turn, writing a VISIBLE event
// at EACH step so the attempt is never silent (the exact gap the user hit: "I didn't
// see a try to infer anywhere"). Best-effort + fire-and-forget: every failure mode
// leaves the card usable (project blank) with an honest event saying why. Guarded so it
// only runs while the card still has no project.
async function runProjectInference(opts, id, { manual = false } = {}) {
  const root = opts.root;
  const gatewayUrl = opts.gatewayUrl;
  // Mark "inferring…" immediately so the UI shows the attempt — but only for a card
  // that still has no project, is not explicitly personal, and isn't already
  // inferring. Personal is a deliberate classification, not a failed inference.
  let inferenceStarted = false;
  const started = await updateCard(root, id, (card) => {
    // updateCard returns the current card for a no-op, so carry an explicit bit
    // out of the final CAS attempt. Otherwise a suppressed inference would still
    // call the gateway even though no "running" state was committed.
    inferenceStarted = false;
    if (card.runId) return null;
    if (!manual && cardScope(card) === "personal") return null;
    if (card.project) return null;
    if (!manual && card.inferState === "running") return null;
    inferenceStarted = true;
    return { ...card, inferState: "running", events: withEvent(card, inferEvent("inference", "Inferring the project from the title + description…")) };
  });
  if (!inferenceStarted || !started || started.project || started.runId) return;

  const stopIfRunStarted = (card) => card.runId ? {
    ...card,
    inferState: "skipped",
    events: withEvent(card, inferEvent(
      "inference",
      "Project inference result discarded - the first run had already started, so its execution scope is fixed."
    ))
  } : null;

  if (!gatewayUrl || !(await gatewayReachable(gatewayUrl))) {
    await updateCard(root, id, (card) => {
      const stopped = stopIfRunStarted(card);
      if (stopped) return stopped;
      if (card.project || (!manual && cardScope(card) === "personal")) return null;
      return {
        ...card,
        inferState: "skipped",
        events: withEvent(card, inferEvent("inference", "Project inference skipped — no operative is running. Set a project manually, or it'll be inferred on the next run."))
      };
    });
    return;
  }

  try {
    const knownProjects = knownProjectsFrom(await loadAllCards(root));
    const { project, reply } = await inferProject(started, inferenceRunFn(gatewayUrl), { knownProjects });
    await updateCard(root, id, (card) => {
      const stopped = stopIfRunStarted(card);
      if (stopped) return stopped;
      if (!manual && cardScope(card) === "personal") return null; // a personal edit while automatic inference ran wins
      if (card.project) return null; // the user set one while we inferred — respect it
      if (project) {
        return {
          ...card,
          project,
          // An explicit personal label survives deliberate manual inference; it is
          // independent of where the task executes.
          scope: cardScope(card) === "personal" ? "personal" : "project",
          inferState: "done",
          events: withEvent(card, inferEvent("inference", `Inferred the project: ${project}`, replySnippet(reply)))
        };
      }
      return { ...card, inferState: "none", events: withEvent(card, inferEvent("inference", "Couldn't confidently infer a project — left blank. Set one on the card if you know it.", replySnippet(reply))) };
    });
  } catch (err) {
    await updateCard(root, id, (card) => {
      const stopped = stopIfRunStarted(card);
      if (stopped) return stopped;
      if (card.project || (!manual && cardScope(card) === "personal")) return null;
      return {
        ...card,
        inferState: "failed",
        events: withEvent(card, inferEvent("inference", "Project inference failed (the operative was busy or unavailable) — left blank.", String(err?.message || err)))
      };
    });
  }
}

// Derive a card title from its description when the user left the title blank: the
// first non-empty line, stripped of leading markdown bullet/heading/quote markers and
// collapsed to one short line. The user can rename it later — this just gives the card a
// real, legible name at creation instead of "(untitled)".
export function deriveTitle(description, max = 80) {
  const first = String(description ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "";
  const cleaned = first.replace(/^[#>\-*\s]+/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() + "…" : cleaned;
}

// Float step used to place a fresh card just below the current top of a list.
const TOP_OF_LIST_STEP = 60_000;

// The float position a card should take to land at the TOP of `list` — one step
// below the current topmost card's effective position, or zero when the list is
// empty (zero is an explicit allocator baseline, so even the first concurrent
// create has a unique numeric position rather than a shared null fallback).
// Best-effort: a read failure falls back to null (created order), never fails a
// create.
async function topOfListPosition(root, list) {
  try {
    const cards = await loadAllCards(root);
    const inList = cards.filter((c) => c.list === list);
    if (inList.length === 0) return 0;
    const minPos = Math.min(...inList.map((c) => cardPosition(c)));
    return Number.isFinite(minPos) ? minPos - TOP_OF_LIST_STEP : null;
  } catch (err) {
    console.error(`[kanban-loop] top-of-list position for ${list}:`, err?.message || err);
    return null;
  }
}

// A browser drag sends a float midpoint computed from the board snapshot it saw.
// Another create/move may claim that exact value before the PATCH reaches disk.
// Under the collection-order lock, keep the requested location but nudge a
// collision just ahead of the incumbent so ordering never falls through to ULID.
async function collisionFreePosition(root, list, cardId, requested) {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return requested;
  const occupied = new Set(
    (await loadAllCards(root))
      .filter((candidate) => candidate.id !== cardId && candidate.list === list)
      .map((candidate) => cardPosition(candidate))
      .filter((position) => typeof position === "number" && Number.isFinite(position))
  );
  let position = requested;
  while (occupied.has(position)) {
    const delta = Math.max(0.000001, Math.abs(position) * Number.EPSILON * 4);
    position -= delta;
  }
  return position;
}

// POST /cards — create a card in Backlog by default, or directly in an active
// manual list via `targetList` (the board UI uses this for To Do). Agent,
// interactive and terminal destinations are refused so simple capture can never
// start a run or silently mark work complete. Body: { title?, description?,
// project?, scope?, goalMode?, acceptance?, targetList? }. Title is OPTIONAL: a blank
// title is inferred from the description's first line (only when BOTH are blank
// is there nothing to name it by). A card created WITHOUT a project kicks a
// visible, fire-and-forget project inference (so the attempt shows on the card
// instead of nothing).
async function handleCreateCard(req, res, opts) {
  const body = (await readBody(req)) || {};
  const checklistError = checklistValidationError(body.checklist);
  if (checklistError) return jsonRes(res, 400, { error: checklistError });
  const dutyLevels = validateDutyLevels(body.dutyLevels);
  if (dutyLevels.error) return jsonRes(res, 400, { error: dutyLevels.error });
  const description = typeof body.description === "string" ? body.description : "";
  const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
  const title = rawTitle || deriveTitle(description);
  if (!title) return jsonRes(res, 400, { error: "give the card a title or a description to infer one from" });
  if (body.targetList != null && (typeof body.targetList !== "string" || !body.targetList.trim())) {
    return jsonRes(res, 400, { error: "targetList must be a non-empty list id" });
  }
  const scheduleInput = body.schedule ?? (body.scheduledFor != null
    ? {
        kind: "once",
        action: body.scheduleAction ?? "notify",
        at: body.scheduledFor,
        timezone: "Europe/Lisbon",
        enabled: true,
        targetList: typeof body.targetList === "string" ? body.targetList.trim() : "backlog"
      }
    : null);
  const scheduleError = scheduleValidationError(scheduleInput);
  if (scheduleError) return jsonRes(res, 400, { error: scheduleError });
  const targetListId = scheduleInput && typeof scheduleInput.targetList === "string"
    ? scheduleInput.targetList.trim()
    : typeof body.targetList === "string" ? body.targetList.trim() : "backlog";
  if (!isValidListId(targetListId)) return jsonRes(res, 400, { error: "invalid target list id" });
  const board = await loadBoard(opts.root);
  const targetList = getList(board, targetListId);
  if (!targetList) return jsonRes(res, 400, { error: `unknown list: ${targetListId}` });
  if (targetList.kind !== "manual" || targetList.terminal) {
    return jsonRes(res, 400, {
      error: `cards can only be created directly in an active manual list: ${targetListId}`
    });
  }
  const cardSchedule = normaliseCardSchedule(scheduleInput, {
    scheduledFor: body.scheduledFor ?? null,
    scheduleAction: body.scheduleAction ?? null,
    targetList: targetListId
  });
  if (scheduleInput && !cardSchedule) return jsonRes(res, 400, { error: "schedule could not be normalised" });
  const storageListId = cardSchedule ? "scheduled" : targetListId;
  if (cardSchedule && !getList(board, storageListId)) {
    return jsonRes(res, 503, { error: "Scheduled column is missing; rerun kanban setup to migrate the board" });
  }
  const requestedScope = body.scope == null ? null : body.scope;
  if (requestedScope !== null && !CARD_SCOPES.includes(requestedScope)) {
    return jsonRes(res, 400, { error: `scope must be one of: ${CARD_SCOPES.join(", ")}` });
  }
  const suppliedProject = typeof body.project === "string" && body.project.trim() ? body.project.trim() : null;
  if (requestedScope === "unscoped" && suppliedProject) {
    return jsonRes(res, 400, { error: "unscoped scope cannot also carry a project" });
  }
  if (requestedScope === "project" && !suppliedProject) {
    return jsonRes(res, 400, { error: "project scope requires a project" });
  }
  const explicitWorkspace = suppliedProject || requestedScope === "personal"
    ? null
    : explicitWorkspaceFromCard({ title, description });
  const createPlacement = normalisePlacement(body.placement);
  const placementPreflight = await remotePlacementPreflight({
    placement: createPlacement,
    project: suppliedProject,
    scope: requestedScope ?? (suppliedProject ? "project" : "unscoped"),
    dispatchCommand: typeof body.dispatchCommand === "string" ? body.dispatchCommand.trim() : "",
    duty: typeof body.duty === "string" ? body.duty : null,
    level: Number.isInteger(body.level) ? body.level : null,
    sequence: Array.isArray(body.sequence) ? body.sequence : null,
    routing: body.routing && typeof body.routing === "object" ? body.routing : null,
    list: storageListId
  }, opts);
  if (!placementPreflight.ok) {
    return jsonRes(res, placementPreflight.status, {
      error: placementPreflight.code,
      message: placementPreflight.detail
    });
  }
  // A supplied schedule must parse NOW - storing an unparseable instant would
  // hold the card forever (the engine's fail-closed rule) over a typo.
  if (body.scheduledFor != null && (typeof body.scheduledFor !== "string" || !Number.isFinite(Date.parse(body.scheduledFor)))) {
    return jsonRes(res, 400, { error: "scheduledFor must be a parseable ISO date-time string" });
  }
  // Item 1: a new card lands at the TOP of its list, not the bottom. Compute a
  // float position just below the current top of the selected manual list and
  // thread it through createCard (stamping it at create time avoids a
  // rev-churning stamp-after-create write, and 44509022's
  // provisional-coordination event already bumps rev right after create). Gateway/
  // Continue cards are created in backlog then engine-PATCHed to their target list;
  // handlePatchCard allocates that destination's top unless an explicit drag
  // midpoint is supplied. Positions trend negative over time; the sort is
  // float-based and the server 400s non-finite values. Empty list starts at zero.
  const card = await withCardOrderLock(opts.root, async () => {
    const topPosition = await topOfListPosition(opts.root, storageListId);
    return createCard(opts.root, {
    title,
    description,
    project: suppliedProject || explicitWorkspace,
    scope: requestedScope,
    list: storageListId,
    goalMode: body.goalMode === true,
    acceptance: typeof body.acceptance === "string" ? body.acceptance : null,
    // S4 (D2/D8/D17): the flow naming the card's phase plan, the per-card
    // phase toggles merged over it, the tier (direct field or the D8 payload's
    // classification), and the origin of the registration.
    // RUN-SPEC-V1: the flow, the tier and the phase toggles all have a home
    // inside the card's `routing` pin now, so accept EITHER spelling and let the
    // pin win. The legacy top-level fields stay for the gateway's card payload
    // builder and every existing API client; the UI sends only the pin.
    flow:
      typeof body.flow === "string" ? body.flow : (typeof body.routing?.flow === "string" ? body.routing.flow : null),
    // The CSV pin is the ONE wire form for "phases off" (the same converter the
    // gateway uses); the toggle map remains what the card stores, because that is
    // what railForCard reads.
    phases: body.phases && typeof body.phases === "object" ? body.phases : phaseTogglesFromCsv(body.routing?.phasesOff),
    tier:
      typeof body.tier === "string"
        ? body.tier
        : typeof body.routing?.tier === "string"
          ? body.routing.tier
          : typeof body.classification?.tier === "string"
            ? body.classification.tier
            : null,
    routing: body.routing ?? null,
    origin: typeof body.origin === "string" ? body.origin : null,
    // Where the task came from ({channel, threadId}) — createCard validates the
    // shape; the engine posts the card's outcome back to that thread.
    originChannel: body.originChannel && typeof body.originChannel === "object" ? body.originChannel : null,
    // S4b door-1 persistence (D15 acceptance 9): the gateway's resolved
    // (duty, level, sequence) must survive the server boundary, or a
    // channel-entered card walks the default pipeline instead of its duty's
    // resolved sequence. createCard validates each field's shape.
    duty: typeof body.duty === "string" && body.duty.trim() ? body.duty.trim() : null,
    level: Number.isInteger(body.level) ? body.level : null,
    sequence:
      Array.isArray(body.sequence) && body.sequence.every((item) => typeof item === "string")
        ? body.sequence
        : null,
    // Outpost Dispatch: which machine pulls this card (default host), and the
    // literal command for a stub/no-model dispatched run.
    placement: body.placement ?? null,
    dispatchCommand:
      typeof body.dispatchCommand === "string" && body.dispatchCommand.trim()
        ? body.dispatchCommand.trim()
        : null,
    // WS2 (D7): a continuation card references its predecessor by ULID. createCard
    // shape-validates it and stamps origin "continuation" when no origin is given.
    continues: typeof body.continues === "string" ? body.continues : null,
    // S3a (D8): an explicit origin_id (else createCard derives it from originChannel/origin).
    origin_id: typeof body.origin_id === "string" ? body.origin_id : null,
    // S3d (D9b): a board/API/gateway caller can pass the clarity verdict; a
    // needs-discuss card is dispatched through the Discuss duty first. createCard
    // normalises anything but "needs-discuss" to null. NOTE: a card is CREATED on
    // its selected capture list (Backlog by default); the clarity is stamped now,
    // but the card only REACHES Discuss when its creator moves it there (gateway carding via
    // targetList "discuss"; this create target deliberately accepts manual lists
    // only, so a gateway still uses its engine-authorised follow-up move).
    clarity: typeof body.clarity === "string" ? body.clarity : null,
    // Card scheduling: hold until this instant, then notify (default) or run.
    // A supplied-but-unparseable instant is a caller mistake worth failing fast
    // on at the API door (the engine's hold is fail-closed for on-disk values).
    schedule: cardSchedule,
    scheduledFor: body.scheduledFor ?? null,
    scheduleAction: body.scheduleAction ?? null,
    // The in-card checklist (normalised by createCard).
    checklist: body.checklist ?? null,
    // Item 1: land at the top of the chosen list (zero when it is empty).
      position: topPosition
    });
  });
  // The level chain's per-duty resolution. Same stamp-after-create shape as
  // `quick` below and for the same reason (createCard's field set is frozen).
  // Absent for every card whose sequence came from the duty ladder rather than a
  // levelled flow, and absence is the legacy reading - consumers resolve a
  // phase's level as `dutyLevels?.[phase] ?? level`.
  if (dutyLevels.value) {
    const d = await updateCard(opts.root, card.id, (c) => ({ ...c, dutyLevels: dutyLevels.value }));
    if (d) Object.assign(card, d);
  }
  // D19: a quick card (the gateway's trivial-plan inline task) carries quick:true.
  // createCard's field set is frozen, so stamp it via updateCard right after create.
  if (body.quick === true) {
    const q = await updateCard(opts.root, card.id, (c) => ({ ...c, quick: true }));
    if (q) Object.assign(card, q);
  }
  // §7.1: the AUTONOMY HOLD. The router routed this work, found itself below the
  // lower threshold for the shape, and parked it instead of starting it. Same
  // stamp-after-create shape as `quick` and `dutyLevels`, for the same reason.
  //
  // The hold itself is structural, not a flag race: a held card is created in the
  // board's capture list, which is manual and never auto-dispatched, so nothing
  // can start it before the guards even look. The flag is what the guards, the
  // resume path and the board read.
  const autonomyHeld = body.autonomyHeld === true;
  const autonomyAsk =
    body.autonomyAsk && typeof body.autonomyAsk === "object" && !Array.isArray(body.autonomyAsk)
      ? body.autonomyAsk
      : null;
  const autonomyBand =
    body.autonomy && typeof body.autonomy === "object" && !Array.isArray(body.autonomy) ? body.autonomy : null;
  if (autonomyHeld || autonomyBand) {
    const a = await updateCard(opts.root, card.id, (c) => ({
      ...c,
      ...(autonomyHeld ? { autonomyHeld: true, autonomyAsk } : {}),
      ...(autonomyBand ? { autonomy: autonomyBand } : {}),
      ...(autonomyHeld
        ? {
            events: withEvent(c, {
              at: new Date().toISOString(),
              kind: "autonomy-hold",
              message: "Held for a go - the router is below its confidence threshold on this shape",
              detail: autonomyAsk?.question ?? null
            })
          }
        : {})
    }));
    if (a) Object.assign(card, a);
  }
  // Drill Evidence v0.1: an origin may hand the card its run-evidence video
  // link at create time — the field already exists on the card (the
  // Walkthrough list sets it for build runs); same stamp-after-create shape.
  if (typeof body.videoUrl === "string" && /^https?:\/\//i.test(body.videoUrl)) {
    const v = await updateCard(opts.root, card.id, (c) => ({ ...c, videoUrl: body.videoUrl }));
    if (v) Object.assign(card, v);
  }
  // S3a (D8): emit the `created` lifecycle event to the card's origin (ensures the
  // origin record + appends to its event log; web origins also get a thread ack).
  routeOriginEvent(opts.root, null, card, { kind: "created", message: createdMessage(card) });
  // §7.1: first sight of a held card is where the question gets asked. It rides
  // `needs-input`, which already appends to the durable origin log for EVERY
  // transport and posts into the originating thread for the channel ones - the
  // same path the discuss duty's mid-run questions take, so a held card asks in
  // the same place and the same words on web, Omi and Slack alike. Posted here,
  // after the card write is on disk, so the question can never name a card that
  // does not exist.
  if (autonomyHeld && autonomyAsk?.question) {
    routeNeedsInput(opts.root, null, card, { questions: [autonomyAsk.question], autonomyHold: true });
  }
  if (explicitWorkspace) {
    const scoped = await updateCard(opts.root, card.id, (c) => ({
      ...c,
      inferState: "done",
      events: withEvent(c, inferEvent(
        "inference",
        `Detected explicit workspace: ${explicitWorkspace}`,
        "Taken directly from the task text before dispatch; model-based project inference was not used."
      ))
    }));
    if (scoped) Object.assign(card, scoped);
  }
  // Coordination (GARRISON-FLOW-V2 S1, Q2 point 1): when coordination is active and
  // this project already has other LIVE cards, record an honest provisional note.
  // A fresh card has no touch-set yet (its runDir is minted on first plan dispatch),
  // so the real overlap is only computed when its Plan completes and writes
  // touch-set.json — until then we do NOT guess, we just flag the contention.
  if (card.project) {
    try {
      const policy = loadPolicy();
      const coord = coordinationConfig(policy);
      if (coord.enabled && policy?.coordination) {
        const board = await loadBoard(opts.root);
        const all = await loadAllCards(opts.root);
        const livePeers = all.filter(
          (c) => c.id !== card.id && (c.project || null) === (card.project || null) && isCardLive(board, c)
        );
        if (livePeers.length > 0 && !readTouchSet(card.runDir)) {
          const updated = await updateCard(opts.root, card.id, (c) => ({
            ...c,
            events: withEvent(c, {
              at: new Date().toISOString(),
              kind: "coordination",
              message:
                `Provisional - ${livePeers.length} other live card(s) on ${card.project}; ` +
                `overlap computed when Plan completes and writes its touch-set`
            })
          }));
          if (updated) Object.assign(card, updated);
        }
      }
    } catch (err) {
      // Provisional coordination is best-effort visibility — never fail a create over it.
      console.error(`[kanban-loop] provisional coordination for ${card.id}:`, err?.message || err);
    }
  }
  // Visible project inference for a no-project card — fire-and-forget so create returns
  // at once; the events land on the card and surface on the next board poll.
  if (cardScope(card) === "unscoped") {
    void runProjectInference(opts, card.id).catch((err) => console.error(`[kanban-loop] inference failed for ${card.id}:`, err?.message || err));
  }
  jsonRes(res, 201, { card: cardSummary(card) });
}

// GET /cards/export[?list=<id>][&download=1] — export ONE list's cards (or the whole
// board when no list is named) as a portable JSON bundle. download=1 sets a
// Content-Disposition so the browser saves a file (jsonRes can't set headers).
async function handleExportCards(req, res, opts, query) {
  const root = opts.root;
  const board = await loadBoard(root);
  const cards = await loadAllCards(root);
  const listId = typeof query.list === "string" && query.list ? query.list : null;
  let scope = cards;
  let sourceLists;
  if (listId) {
    if (!isValidListId(listId) || !getList(board, listId)) {
      return jsonRes(res, 400, { error: `unknown list: ${listId}` });
    }
    scope = cards.filter((c) => c.list === listId);
    const l = getList(board, listId);
    sourceLists = [{ id: l.id, title: l.title ?? l.id }];
  } else {
    const present = new Set(scope.map((c) => c.list));
    sourceLists = (board.lists || [])
      .filter((l) => present.has(l.id))
      .map((l) => ({ id: l.id, title: l.title ?? l.id }));
  }
  // Bundle order mirrors the board's within-list sort (position then created) so the
  // batch re-imports in the same visible order.
  scope = scope.slice().sort((a, b) => cardPosition(a) - cardPosition(b) || (a.id < b.id ? -1 : 1));
  const bundle = {
    kind: CARDS_BUNDLE_KIND,
    version: CARDS_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    sourceLists,
    cards: scope.map(exportCard)
  };
  const payload = JSON.stringify(bundle, null, 2);
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (query.download) {
    const name = listId ? `kanban-${listId}.cards.json` : "kanban-board.cards.json";
    headers["content-disposition"] = `attachment; filename="${name}"`;
  }
  res.writeHead(200, headers);
  return res.end(payload);
}

// POST /cards/import { bundle, targetList?, preview? } — import a card bundle onto a
// list. Every card is CREATED FRESH (fresh ULID, rev 0, every travelled field re-
// validated by createCard's normalisers) — an incoming card is NEVER written verbatim.
// targetList must be a real NON-AGENT list (importing onto an agent list would auto-
// dispatch runs); default "backlog". preview:true returns counts + warnings, no write.
async function handleImportCards(req, res, opts) {
  const root = opts.root;
  let body;
  try {
    body = (await readBody(req, 50 * 1024 * 1024)) || {};
  } catch (err) {
    if (err?.code === "BODY_TOO_LARGE") return jsonRes(res, 413, { error: "import JSON exceeds the 50 MB limit" });
    throw err;
  }
  const bundle = body.bundle;
  let source;
  try {
    // One adapter boundary for both local files and a future live connector: raw
    // Trello board JSON is normalised to the same content-only card shape as a
    // native Garrison bundle. No credential, API token, runtime id, or raw source
    // object is persisted.
    source = normaliseCardImport(bundle, {
      sourceList: typeof body.sourceList === "string" && body.sourceList ? body.sourceList : null,
      includeArchived: body.includeArchived === true
    });
  } catch (err) {
    const message = err instanceof CardImportError ? err.message : "could not read the import file";
    return jsonRes(res, 400, { error: message });
  }
  const incoming = source.cards;
  for (let index = 0; index < incoming.length; index += 1) {
    const checklistError = checklistValidationError(incoming[index]?.checklist);
    if (checklistError) {
      return jsonRes(res, 400, { error: `card ${index + 1}: ${checklistError}` });
    }
  }

  const board = await loadBoard(root);
  const cards = await loadAllCards(root);
  const targetList = typeof body.targetList === "string" && body.targetList ? body.targetList : "backlog";
  if (!isValidListId(targetList)) return jsonRes(res, 400, { error: "invalid target list id" });
  const target = getList(board, targetList);
  if (!target) return jsonRes(res, 400, { error: `unknown target list: ${targetList}` });
  // Never import onto an agent list — creating/moving a card there auto-dispatches a run.
  if (target.kind === "agent" || target.kind === "agent-interactive") {
    return jsonRes(res, 400, { error: `cannot import onto the agent list "${targetList}" — pick a manual list (e.g. backlog)` });
  }

  // Read ONLY the allow-listed fields from each incoming card (the SAME const the
  // export projected), validate the schedule (drop an unparseable hold; downgrade
  // run→notify so an imported card never auto-runs), and collect human-readable
  // warnings. The importer NEVER trusts a field outside EXPORT_CARD_FIELDS.
  const knownProjects = new Set(knownProjectsFrom(cards));
  const warnings = [...source.warnings];
  const prepared = incoming.map((raw, i) => {
    const c = raw && typeof raw === "object" ? raw : {};
    const picked = {};
    for (const f of EXPORT_CARD_FIELDS) {
      if (c[f] !== undefined) picked[f] = c[f];
    }
    // Fully normalise every selected field before the first card is written. The
    // create loop below consumes only this prepared shape, never the raw bundle.
    picked.title = typeof picked.title === "string" ? picked.title.trim() : "";
    picked.description = stripAttachedFilesBlock(typeof picked.description === "string" ? picked.description : "");
    picked.project = typeof picked.project === "string" ? picked.project.trim() : null;
    picked.scope = CARD_SCOPES.includes(picked.scope) ? picked.scope : null;
    picked.acceptance = typeof picked.acceptance === "string" ? picked.acceptance : null;
    picked.goalMode = picked.goalMode === true;
    picked.checklist = picked.checklist == null
      ? null
      : normaliseChecklist(
          Array.isArray(picked.checklist)
            ? picked.checklist.map((item) => item && typeof item === "object" ? { ...item, id: undefined } : item)
            : picked.checklist
        );
    picked.routing = sanitiseCardRouting(picked.routing);
    picked.flow = typeof picked.flow === "string" && picked.flow.trim() ? picked.flow.trim() : null;
    picked.tier = typeof picked.tier === "string" && picked.tier.trim() ? picked.tier.trim() : null;
    if (picked.phases && typeof picked.phases === "object" && !Array.isArray(picked.phases)) {
      picked.phases = Object.fromEntries(
        Object.entries(picked.phases)
          .filter(([key, value]) => /^[A-Za-z0-9_-]{1,80}$/.test(key) && typeof value === "boolean")
          .slice(0, 64)
      );
    } else {
      picked.phases = null;
    }
    const label = String(c.title || "").slice(0, 40);
    if (picked.schedule != null) {
      const importedSchedule = { ...picked.schedule, targetList };
      if (importedSchedule.action === "run") {
        importedSchedule.action = "notify";
        warnings.push(`card ${i + 1} ("${label}"): recurring/one-shot auto-run downgraded to "notify" on import`);
      }
      const scheduleError = scheduleValidationError(importedSchedule);
      picked.schedule = scheduleError ? null : normaliseCardSchedule(importedSchedule, { targetList });
      if (scheduleError) warnings.push(`card ${i + 1} ("${label}"): dropped invalid schedule (${scheduleError})`);
      picked.scheduledFor = picked.schedule?.nextAt ?? null;
      picked.scheduleAction = picked.schedule?.action ?? null;
    }
    // Fail-closed schedule: an unparseable scheduledFor would hold the imported card
    // forever (scheduleHolds treats it as "never releases"). Drop it and warn.
    if (picked.scheduledFor != null) {
      if (typeof picked.scheduledFor !== "string" || !Number.isFinite(Date.parse(picked.scheduledFor))) {
        warnings.push(`card ${i + 1} ("${label}"): dropped an unparseable scheduledFor`);
        picked.scheduledFor = null;
        picked.scheduleAction = null;
      } else if (picked.scheduleAction === "run") {
        // Never auto-RUN an imported card — downgrade the schedule to a reminder.
        picked.scheduleAction = "notify";
        warnings.push(`card ${i + 1} ("${label}"): scheduleAction "run" downgraded to "notify" on import`);
      }
    }
    // A machine path never travels as a project label. The routing pin has its
    // own project copy, so scrub both spellings before createCard sees either.
    if (picked.project && isMachineLocalPath(picked.project)) {
      warnings.push(`card ${i + 1} ("${label}"): removed a machine-local project path`);
      picked.project = null;
    }
    if (picked.routing?.project && isMachineLocalPath(picked.routing.project)) {
      warnings.push(`card ${i + 1} ("${label}"): removed a machine-local routing.project path`);
      delete picked.routing.project;
      if (Object.keys(picked.routing).length === 0) picked.routing = null;
    }
    // Derive legacy/malformed non-personal scope from the project that survived
    // portability scrubbing. Explicit personal remains personal with or without a
    // project because it is a task label, not a cwd selector.
    picked.scope = cardScope({ scope: picked.scope, project: picked.project });
    // An unknown LABEL is still useful content; import it and explain that this
    // machine has no path mapping for it yet.
    if (picked.project) {
      if (!knownProjects.has(picked.project)) {
        warnings.push(`card ${i + 1} ("${label}"): project "${picked.project}" is not known on this machine`);
      }
    }
    // A Heartbeat-titled card can collide with job-ingress dedupe (harmless for normal
    // cards, but worth flagging so an unexpected suppression is explicable).
    if (typeof picked.title === "string" && /^Heartbeat job:/i.test(picked.title)) {
      warnings.push(`card ${i + 1}: title looks like a scheduled-job card — may collide with job dedupe`);
    }
    return picked;
  }).filter((picked, i) => {
    const title = typeof picked.title === "string" ? picked.title.trim() : "";
    const description = typeof picked.description === "string" ? picked.description.trim() : "";
    if (title || description) return true;
    warnings.push(`card ${i + 1}: skipped because it has no title or description`);
    return false;
  });

  if (body.preview === true) {
    return jsonRes(res, 200, {
      preview: true,
      count: prepared.length,
      targetList,
      warnings,
      sourceFormat: source.format,
      sourceName: source.sourceName,
      sourceLists: source.sourceLists,
      excludedArchived: source.excludedArchived
    });
  }

  // Land the batch at the TOP of the target list, preserving bundle order (first card
  // on top), so imported cards behave like freshly-added ones (Item 1).
  const created = await withCardOrderLock(root, async () => {
    // Re-read under the allocator lock: a card may have landed after preview or
    // prevalidation, and its position is part of the ordering transaction.
    const currentCards = await loadAllCards(root);
    const existing = currentCards.filter((c) => c.list === targetList);
    const minPos = existing.length ? Math.min(...existing.map(cardPosition)) : 0;
    const n = prepared.length;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const p = prepared[i];
      const position = minPos - (n - i) * TOP_OF_LIST_STEP;
      const title = p.title || deriveTitle(p.description);
      const card = await createCard(root, {
        title,
        description: p.description,
        project: p.project,
        scope: p.scope,
        list: p.schedule ? "scheduled" : targetList,
        goalMode: p.goalMode,
        acceptance: p.acceptance,
        checklist: p.checklist,
        routing: p.routing,
        flow: p.flow,
        tier: p.tier,
        phases: p.phases,
        schedule: p.schedule ?? null,
        scheduledFor: p.scheduledFor ?? null,
        scheduleAction: p.scheduleAction ?? null,
        origin: "import",
        position
      });
      rows.push(cardSummary(card));
    }
    return rows;
  });
  return jsonRes(res, 201, {
    imported: created.length,
    targetList,
    warnings,
    cards: created,
    sourceFormat: source.format,
    sourceName: source.sourceName
  });
}

// POST /cards/:id/infer-project — manually (re)run project inference for a no-project
// card. Fire-and-forget: returns at once with inferState=running; the result events
// land on the card and show on the next poll.
async function handleInferProject(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin inference rejected" });
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id;
  if (card.runId) {
    return jsonRes(res, 409, {
      error: "scope-already-ran",
      message: "Project inference cannot change a card after its first run starts. Create a fresh card to run the task in a different scope."
    });
  }
  if (card.project) return jsonRes(res, 200, { card: cardSummary(card), note: "card already has a project" });
  void runProjectInference(opts, id, { manual: true }).catch((err) => console.error(`[kanban-loop] manual inference failed for ${id}:`, err?.message || err));
  jsonRes(res, 200, { card: cardSummary({ ...card, inferState: "running" }), inferring: true });
}

// An engine-context request (the run engine's own moves, the gateway's D8 card
// registration) carries the x-garrison-engine header; everything else is a
// manual/human request subject to the D16 locks.
export function isEngineRequest(req) {
  return typeof req.headers["x-garrison-engine"] === "string" && req.headers["x-garrison-engine"].length > 0;
}

// `x-garrison-engine` marks a privileged engine-context mutation; it does NOT
// by itself say who owns progression. Most engine callers self-drive (the
// garrison doorway uses advanceCardPhase; quick gateway cards run inline), so
// their move must suppress the board's background chain. A significant gateway
// registration explicitly hands progression to the board with this second,
// orthogonal intent header.
export function requestsAutoDispatch(req) {
  return req.headers["x-garrison-dispatch"] === "auto";
}

// Strictly normalize the gateway's settled quick-turn route evidence before it
// reaches card.json. This is accepted only on an engine-context PATCH below.
// Strings are capped so a malformed local caller cannot inflate the timeline.
export function quickRouteEvent(raw, at = new Date().toISOString()) {
  if (!raw || typeof raw !== "object") return null;
  const text = (value, max = 160) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  const targetId = text(raw.targetId);
  const runtime = text(raw.runtime);
  const provider = text(raw.provider);
  const model = text(raw.model);
  const effort = text(raw.effort, 40);
  const effortApplied = typeof raw.effortApplied === "boolean" ? raw.effortApplied : null;
  const tier = text(raw.tier, 40);
  const phase = text(raw.phase, 80);
  if (
    targetId == null && runtime == null && provider == null && model == null &&
    effort == null && effortApplied == null && tier == null
  ) {
    return null;
  }
  const route = { targetId, runtime, provider, model, effort, effortApplied, tier, phase };
  const idPart = [runtime || provider, model].filter(Boolean).join("/");
  let suffix = idPart ? ` · ${idPart}` : "";
  if (tier) suffix += suffix ? ` (${tier})` : ` · (${tier})`;
  return {
    at,
    kind: "routed",
    message: `Quick task completed${suffix}`,
    detail: replySnippet(typeof raw.reply === "string" ? raw.reply : "") || null,
    route
  };
}

// The field patch applied when a card is un-parked (moved OUT of
// needs-attention). Clears the park reason + prior dispatch error and resets
// the iteration count so the re-run isn't instantly re-capped. D19
// context-keeping retry: when the card carries retryKeepsContext (set by the
// engine on an empty-output park), the phase runDir + its iteration logs are
// PRESERVED so the re-entered phase resumes with prior context; the flag is
// then consumed (cleared). Pure + exported so the recovery contract is
// unit-tested (S1b review finding: the flag was written but read nowhere).
//
// Coordination invariant: this patch never marks the card as having yielded its
// ordering position. A needs-attention card retains its same-checkout overlap,
// intent, and lease holds while parked; PATCH, Start, and steering/manual-list
// recovery resume that held position. Only terminal completion, Delete, or the
// explicit Abandon path releases those holds.
export function unparkRecoveryFields(card) {
  const patch = {
    attentionReason: null,
    parkedFrom: null,
    lastDispatchError: null,
    iterations: 0
  };
  if (card.retryKeepsContext) {
    patch.runDir = card.runDir ?? null;
    patch.retryKeepsContext = false;
  }
  return patch;
}

// Restore every durable part of a parked card's coordination position BEFORE its
// CAS moves back into autonomous work. While parked, the card is the logical owner
// even if an on-disk lease expires; reacquiring here closes the unpark→dispatch gap
// in which a waiter could otherwise observe a free lease and fan out. There is no
// dirty-worktree predicate in this shared-checkout flow, so recovery fails closed
// instead of guessing that partial edits were safely yielded. The same preflight
// refreshes the outward touch-set intent after a long pause; terminal, Abandon,
// and Delete remove the owner-scoped records instead. This is a forward recovery
// seam, not a background repair sweep: historical parked cards keep their internal
// board holds, and their outward intent is refreshed only when a human resumes them.
export function prepareRecoveredCoordinationHold(board, card, now = () => new Date().toISOString()) {
  if (card?.abandoned) {
    return {
      ok: false,
      code: "abandoned-card",
      message: "This card was explicitly abandoned and no longer owns its prior coordination position. Finish or discard its prepared revert, or create a new card; it cannot be resumed in place."
    };
  }
  const cfg = coordinationConfig(loadPolicy());
  if (!cfg.enabled) return { ok: true, skipped: "coordination-disabled", acquired: [], intent: null };
  // A never-started card has no ordering position to restore. Once a runDir was
  // minted, however, its touch-set is the evidence that defines that position;
  // missing/corrupt evidence must fail closed instead of silently re-entering the
  // shared checkout with unknown overlap.
  if (!card?.runDir) return { ok: true, skipped: "never-started", acquired: [], intent: null };
  const inspected = inspectTouchSet(card.runDir);
  const touchSet = inspected.touchSet;
  if (!touchSet) {
    return {
      ok: false,
      code: "touch-set-unavailable",
      message: `Recovery remains parked because its prior coordination touch-set is unavailable (${inspected.issue}). Restore a valid schema-v1 touch-set.json, re-run Plan, or explicitly Abandon/Delete the card.`
    };
  }
  const repoPath = repoPathForProject(card?.project, board);
  if (!repoPath) {
    return {
      ok: false,
      code: "repo-unresolved",
      message: `Recovery remains parked because project "${card?.project || "(none)"}" no longer resolves to a repository. Project scope is locked after a run starts; create a fresh card with the intended project, or explicitly Abandon/Delete this card.`
    };
  }
  const exclusive = [...new Set(touchSet.exclusive || [])];
  for (const p of cfg.exclusiveLeases || []) {
    if (!exclusive.includes(p) && claimCovers(touchSet, p)) exclusive.push(p);
  }
  const lease = acquireLeases({
    repoPath,
    card,
    paths: exclusive,
    ttlMinutes: cfg.leaseTtlMinutes,
    now
  });
  if (lease.unavailable) {
    return {
      ok: false,
      code: "lease-substrate-unavailable",
      message: "Recovery remains parked because its exclusive lease could not be durably restored. Make coordination storage writable and retry, or explicitly Abandon/Delete the card."
    };
  }
  if (!lease.ok) {
    return {
      ok: false,
      code: "lease-held",
      heldBy: lease.heldBy || null,
      path: lease.path || null,
      message: `Recovery remains parked because ${lease.path || "an exclusive path"} is now leased by ${lease.heldBy || "another card"}. Resolve that holder first, or explicitly Abandon/Delete this card.`
    };
  }
  if (lease.acquired.length !== exclusive.length) {
    return {
      ok: false,
      code: "lease-substrate-unavailable",
      message: "Recovery remains parked because its exclusive lease could not be durably restored. Make coordination storage writable and retry, or explicitly Abandon/Delete the card."
    };
  }
  const intent = refreshCardTouchSetIntent({ repoPath, card, touchSet, now });
  if (!intent) {
    return {
      ok: false,
      code: "intent-refresh-failed",
      message: "Recovery remains parked because its outward coordination intent could not be refreshed. Make coordination storage writable and retry, or explicitly Abandon/Delete the card."
    };
  }
  // The lease generation is part of the card's durable ownership identity.
  // Persist it in the same lifecycle CAS that unparks the card so a delayed
  // cleanup/renewal from the prior generation cannot mutate this successor.
  if (lease.ownerToken) card.leaseOwnerToken = lease.ownerToken;
  return { ok: true, acquired: lease.acquired, ownerToken: lease.ownerToken || null, intent };
}

function coordinationRecoveryConflict(res, hold) {
  return jsonRes(res, 409, {
    error: "coordination-recovery-held",
    message: hold.message,
    coordination: { code: hold.code, heldBy: hold.heldBy || null, path: hold.path || null }
  });
}

function cleanupClosedCoordinationHold(root, board, card, priorCard = null) {
  const repos = new Set([
    repoPathForProject(card?.project, board),
    repoPathForProject(priorCard?.project, board)
  ].filter(Boolean));
  return cleanupCardCoordination({
    root,
    cardId: card.id,
    repoPaths: [...repos],
    removeIntents: true,
    ownerToken: null
  });
}

// D16: cards on autonomous (agent-kind) lists are ENGINE-OWNED — the board API
// rejects manual moves and edits on them. needs-attention is the one human
// touchpoint on the autonomous side; interactive + manual lists stay editable.
export function isEngineOwned(board, card) {
  // D19: a quick card is never engine-run — the gateway ran it inline and parked
  // it on an agent list only transiently (Implement → Done). The locked-list rules
  // apply ONLY to engine-owned cards mid-run, so a quick card stays operator-editable
  // wherever it sits.
  if (card.quick === true) return false;
  const list = getList(board, card.list);
  return Boolean(list && list.kind === "agent" && !isInteractive(list));
}

// A move from a human-held column resumes an existing coordination position.
// Reopening a terminal card does too: terminal entry removed its leases/intents,
// while its runDir and touch-set still make it live again on a non-terminal
// destination. Treating Archived/Done as ordinary manual sources would reopen
// the card without restoring that position.
export function shouldRecoverCoordinationHold(board, card, next) {
  if (!card || !next || card.list === next.list) return false;
  const sourceTerminal = Boolean(getList(board, card.list)?.terminal || card.list === "done");
  const targetTerminal = Boolean(getList(board, next.list)?.terminal || next.list === "done");
  return !targetTerminal && (isHumanHeld(card, board) || sourceTerminal);
}

// PATCH /cards/:id — manual gate: Move to a list and/or set editable fields
// (project, goalMode, sliceId, acceptance). CAS against the card's rev so a
// concurrent tick is never silently overwritten. A Move target must be a real
// list id.
async function handlePatchCard(req, res, opts, id) {
  const root = opts.root;
  const body = (await readBody(req)) || {};
  if (body.scope !== undefined && !CARD_SCOPES.includes(body.scope)) {
    return jsonRes(res, 400, { error: `scope must be one of: ${CARD_SCOPES.join(", ")}` });
  }
  const checklistError = checklistValidationError(body.checklist);
  if (checklistError) return jsonRes(res, 400, { error: checklistError });
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — the write must never use a tampered on-disk id
  const patchedRouting = body.routing === undefined ? undefined : sanitiseCardRouting(body.routing);
  const storedExecutionProject = sanitiseCardRouting(card.routing)?.project || card.project || null;
  const patchedExecutionProject = patchedRouting?.project || card.project || null;
  const changesExecutionProject = body.routing !== undefined && patchedExecutionProject !== storedExecutionProject;
  const board = await loadBoard(root);
  // A list move without an explicit drag position is an insertion at the top.
  // The position is allocated later under the collection-order lock; drag moves
  // supply a midpoint and bypass that allocator.
  const needsImplicitMovePosition =
    typeof body.list === "string" && body.list !== card.list && body.position === undefined;
  // D16 lock: a card on an autonomous list is engine-owned — manual moves and
  // edits are rejected in the API (the UI hides the controls too). The engine
  // and the gateway's registration flow pass x-garrison-engine.
  //
  // Carve-out: a patch touching ONLY the human-side annotations (schedule,
  // within-list position, checklist) never rewrites what the engine is
  // executing, so it is allowed even on an engine-owned card — snoozing a
  // queued agent-list card is precisely the point of the schedule.
  const BENIGN_PATCH_KEYS = new Set(["rev", "schedule", "scheduledFor", "scheduleAction", "position", "checklist"]);
  const benignPatch = Object.keys(body).length > 0 && Object.keys(body).every((k) => BENIGN_PATCH_KEYS.has(k));
  if (isEngineOwned(board, card) && !isEngineRequest(req) && !benignPatch) {
    return jsonRes(res, 403, {
      error: "engine-owned",
      message: `Card is on the autonomous list "${card.list}" — it is engine-owned (D16). Wait for the run, or resolve it from needs-attention if it parks.`
    });
  }
  if ((typeof body.project === "string" || body.scope !== undefined || changesExecutionProject) && card.runId && !isEngineRequest(req)) {
    return jsonRes(res, 409, {
      error: "scope-already-ran",
      message: "Project/personal scope is fixed after the first run starts because its artifacts belong to that execution context. Create a fresh card to run the task in a different scope."
    });
  }
  const next = { ...card };
  if (typeof body.list === "string") {
    if (!getList(board, body.list)) return jsonRes(res, 400, { error: `unknown list: ${body.list}` });
    if ((body.list === "scheduled" || card.list === "scheduled") && !isEngineRequest(req)) {
      return jsonRes(res, 400, {
        error: "schedule-owned",
        message: "Use the Schedule controls to place a card in Scheduled or release it to its target list."
      });
    }
    next.list = body.list;
    next.status = "ok"; // a manual Move clears a parked/needs-attention status
    // Record the manual move on the timeline so the activity feed shows human moves
    // alongside the engine's dispatches (a complete "what happened" history).
    if (body.list !== card.list) {
      const fromTitle = getList(board, card.list)?.title || card.list;
      const toTitle = getList(board, body.list)?.title || body.list;
      const recovered = card.list === "needs-attention" && body.list !== "needs-attention";
      next.events = withEvent(card, {
        at: new Date().toISOString(),
        kind: recovered ? "recovered" : "moved",
        message: recovered ? `Recovered: moved ${listProseLabel(fromTitle)} → ${listProseLabel(toTitle)}` : `Moved ${listProseLabel(fromTitle)} → ${listProseLabel(toTitle)}`
      });
    }
    // Recovery: moving a card OUT of the needs-attention column is a fresh retry.
    if (card.list === "needs-attention" && body.list !== "needs-attention") {
      Object.assign(next, unparkRecoveryFields(card));
      if (card.retryKeepsContext) {
        next.events = withEvent(next, {
          at: new Date().toISOString(),
          kind: "retry-keeps-context",
          message: "Retry preserves prior context (phase runDir + iteration logs kept)"
        });
      }
    }
    // Auto-link a Discuss brief: when a card LEAVES the interactive Discuss list,
    // look for the brief the Discuss duty was asked to write (briefs/<slug>.md — the
    // buildDiscussUrl convention) and link it onto the card if present + not already
    // linked. The card LINKS the brief (FINDING 10); it never inlines it. This keeps
    // the web channel generic — the BOARD does the linking, not the channel — so a
    // brief shows on the card without a manual POST /cards/:id/brief.
    const fromList = getList(board, card.list);
    if (body.list !== card.list && fromList && isInteractive(fromList) && !next.briefPath) {
      // The brief is card-owned + deterministic (<root>/cards/<id>/brief.md). If Discuss
      // wrote it during Discuss, mark it on the card (a root-relative pointer) so the
      // card shows a brief link and the engine folds it into the build.
      const abs = cardBriefFile(kanbanRoot(), card.id);
      if (isReadableFile(abs)) next.briefPath = cardBriefRel(card.id);
    }
  }
  // Title/description are editable so a card can be CORRECTED after creation —
  // the omi wake bus creates a card within ~45s so it can be seen, then revises
  // it from what the user said next ("no, make that Wednesday"). The
  // engine-owned guard above still applies, so a running card is not rewritten
  // underneath its own run.
  if (typeof body.title === "string" && body.title.trim()) next.title = body.title.trim();
  if (typeof body.description === "string") next.description = body.description;
  const patchesProject = typeof body.project === "string";
  const patchesScope = body.scope !== undefined;
  if (patchesProject || patchesScope) {
    const priorProject = typeof card.project === "string" && card.project.trim() ? card.project.trim() : null;
    const priorScope = cardScope(card);
    const requestedProject = patchesProject ? (body.project.trim() || null) : priorProject;
    let requestedScope = patchesScope ? body.scope : priorScope;

    // Personal is independent of execution location: assigning/clearing a project
    // without an explicit scope edit preserves the personal label. Non-personal
    // cards derive project vs unscoped from the actual project value.
    if (!patchesScope && priorScope !== "personal") requestedScope = requestedProject ? "project" : "unscoped";
    if (requestedScope === "project" && !requestedProject) {
      return jsonRes(res, 400, { error: "project scope requires a project" });
    }
    if (requestedScope === "unscoped" && requestedProject) {
      return jsonRes(res, 400, { error: "unscoped scope cannot also carry a project" });
    }

    next.project = requestedProject;
    next.scope = requestedScope;

    // A top-level project correction is the normal card UI path. Unless the same
    // PATCH explicitly replaces the run spec, remove its stale project override so
    // the corrected card project genuinely becomes the next turn's cwd.
    if (patchesProject && body.routing === undefined && next.routing?.project) {
      const { project: _staleProject, ...rest } = next.routing;
      next.routing = sanitiseCardRouting(rest);
    }

    const changed = priorProject !== next.project || priorScope !== next.scope;
    if (changed) {
      if (next.scope === "personal" && priorScope !== "personal") {
        next.events = withEvent(next, {
          at: new Date().toISOString(),
          kind: "inference",
          message: `Marked as a personal task${next.project ? ` (project ${next.project})` : " - automatic project inference is off"}`
        });
      } else if (priorScope === "personal" && next.scope !== "personal") {
        next.events = withEvent(next, {
          at: new Date().toISOString(),
          kind: "inference",
          message: next.project ? `Personal label removed (project ${next.project})` : "Personal label removed - project is unscoped"
        });
      } else if (priorProject !== next.project) {
        next.events = withEvent(next, {
          at: new Date().toISOString(),
          kind: "inference",
          message: next.project
            ? priorProject ? `Project changed manually: ${priorProject} → ${next.project}` : `Project set manually: ${next.project}`
            : `Project cleared manually${priorProject ? ` (was ${priorProject})` : ""}`
        });
      }
      if (priorProject !== next.project) {
        next.inferState = next.project ? "manual" : next.scope === "personal" ? "suppressed" : "none";
      } else if (next.scope === "personal" && !next.project) {
        next.inferState = "suppressed";
      } else if (priorScope === "personal" && next.scope === "unscoped") {
        next.inferState = "none";
      }
    }
  }
  if (typeof body.goalMode === "boolean") next.goalMode = body.goalMode;
  if (typeof body.sliceId === "string") {
    const s = body.sliceId.trim();
    if (s && !isValidSliceId(s)) return jsonRes(res, 400, { error: "invalid sliceId (no path separators or ..)" });
    next.sliceId = s || null;
  }
  if (typeof body.acceptance === "string") next.acceptance = body.acceptance;
  // RUN-SPEC-V1: the card's explicit run spec is EDITABLE, unlike the create-only
  // flow/tier/duty it partly supersedes. A control you can set once and never
  // correct is not a control - and the common case is exactly "this parked card
  // should have run on opus". Engine-owned cards are already refused above
  // (isEngineOwned), so this can only reach a card the human still holds.
  //
  // Whole-object replace, not a merge: `null` on a field means "back to automatic",
  // and a merge could never express that. Sending `routing: null` clears the lot.
  if (body.routing !== undefined) {
    next.routing = patchedRouting;
    // The three fields the card ALSO stores flat (they are read by railForCard and
    // the classification hint) are re-derived, or the two copies disagree the
    // moment a spec is edited.
    next.flow = next.routing?.flow ?? null;
    next.tier = next.routing?.tier ?? null;
    next.phases = phaseTogglesFromCsv(next.routing?.phasesOff);
  }
  // Outpost Dispatch: WHERE the card runs. `host` (the default) means the local
  // operative; any other value names a paired machine that must pull the card
  // via the dispatch API. Editable by a human ONLY before a worker has claimed
  // it — moving a card mid-run to another machine would leave the current worker
  // holding a claim on a card that now belongs elsewhere. The engine is exempt:
  // reclaiming a dead machine's card clears placement precisely while `dispatch`
  // is still set.
  if (body.placement !== undefined) {
    const heldByWorker = card.dispatch && card.dispatch.state !== "done" && card.dispatch.state !== "failed";
    if (heldByWorker && !isEngineRequest(req)) {
      return jsonRes(res, 409, {
        error: "dispatch-held",
        message: `Card is claimed by ${card.dispatch.machine} — placement cannot change mid-run. Wait for it to finish, or resolve it from needs-attention.`
      });
    }
    const requestedPlacement = normalisePlacement(body.placement);
    if (!isEngineRequest(req)) {
      const placementPreflight = await remotePlacementPreflight({
        placement: requestedPlacement,
        project: typeof next.project === "string" ? next.project : null,
        scope: cardScope(next),
        dispatchCommand: typeof next.dispatchCommand === "string" ? next.dispatchCommand : "",
        duty: next.duty ?? null,
        level: next.level ?? null,
        sequence: next.sequence ?? null,
        routing: next.routing ?? null,
        list: next.list
      }, opts);
      if (!placementPreflight.ok) {
        return jsonRes(res, placementPreflight.status, {
          error: placementPreflight.code,
          message: placementPreflight.detail
        });
      }
    }
    next.placement = requestedPlacement;
    // A placement edit completes the one-way compatibility migration.
    next.outpost = null;
  }
  // Card scheduling. `schedule` is authoritative; scheduledFor/scheduleAction
  // remain a one-shot compatibility alias. Setting a schedule moves the card to
  // the fixed Scheduled column and remembers its release target. Clearing moves
  // it back to that target. Refused while running: there is nothing left to hold.
  if (body.schedule !== undefined || body.scheduledFor !== undefined) {
    if (card.status === "running") {
      return jsonRes(res, 409, { error: "running", message: "the card is running — a schedule can only hold a card that has not started" });
    }
    if (body.list !== undefined) {
      return jsonRes(res, 400, { error: "change list and schedule in separate requests" });
    }
    const clearing = body.schedule === null || body.scheduledFor === null || body.scheduledFor === "";
    if (clearing) {
      const release = card.schedule?.targetList;
      if (card.list === "scheduled") next.list = release && getList(board, release) ? release : "backlog";
      next.schedule = null;
      next.scheduledFor = null;
      next.scheduleAction = null;
      next.scheduleNotifiedAt = null;
      next.scheduleDelivery = null;
      if (card.schedule || card.scheduledFor) {
        next.events = withEvent(next, { at: new Date().toISOString(), kind: "schedule-cleared", message: `Schedule cleared${card.list === "scheduled" ? `; returned to ${next.list}` : ""}` });
      }
    } else {
      const releaseTarget = card.list === "scheduled" ? card.schedule?.targetList ?? "backlog" : card.list;
      const rawSchedule = body.schedule !== undefined
        ? body.schedule
        : {
            kind: "once",
            action: body.scheduleAction ?? card.schedule?.action ?? card.scheduleAction ?? "notify",
            at: body.scheduledFor,
            timezone: card.schedule?.timezone ?? "Europe/Lisbon",
            enabled: true,
            targetList: releaseTarget
          };
      // The Morning briefing replacement is deliberately seeded paused while
      // the legacy raw scheduler job still exists. It may be exercised through
      // Run now, but must not be resumed through the generic editor: doing so
      // would create two regular deliveries during the verification window.
      // `kanban.mjs --setup` is the only cutover seam; after the old job is
      // removed it clears this receipt and restores the legacy enabled state.
      if (card.schedule?.cutoverPending === true && rawSchedule?.enabled !== false) {
        return jsonRes(res, 409, {
          error: "schedule-cutover-pending",
          message: "Morning briefing is paused while the legacy scheduler job is still present. Verify it with Run now, remove the legacy job, then rerun kanban setup to activate the recurring template."
        });
      }
      const error = scheduleValidationError(rawSchedule);
      if (error) return jsonRes(res, 400, { error });
      const scheduleTarget = getList(board, rawSchedule.targetList);
      if (!scheduleTarget || scheduleTarget.id === "scheduled" || scheduleTarget.kind !== "manual" || scheduleTarget.terminal) {
        return jsonRes(res, 400, { error: `unknown or invalid schedule target list: ${rawSchedule.targetList}` });
      }
      const schedule = normaliseCardSchedule(rawSchedule, {
        scheduledFor: body.scheduledFor ?? null,
        scheduleAction: body.scheduleAction ?? null,
        targetList: releaseTarget
      });
      if (!schedule) return jsonRes(res, 400, { error: "schedule could not be normalised" });
      next.schedule = schedule;
      next.scheduledFor = schedule.enabled ? schedule.nextAt : null;
      next.scheduleAction = schedule.action;
      next.scheduleNotifiedAt = null;
      next.scheduleDelivery = null;
      next.list = "scheduled";
      next.status = "ok";
      next.events = withEvent(next, {
        at: new Date().toISOString(),
        kind: schedule.kind === "cron" ? "schedule-recurring" : "schedule-set",
        message: schedule.kind === "cron"
          ? `Recurring schedule ${schedule.cron} (${schedule.timezone}); next ${schedule.nextAt ?? "paused"}`
          : `Scheduled for ${schedule.nextAt} (${schedule.action === "run" ? "auto-run" : "notify"})`
      });
    }
  } else if (body.scheduleAction !== undefined && (card.schedule || card.scheduledFor)) {
    const action = normaliseScheduleAction(body.scheduleAction);
    next.scheduleAction = action;
    if (card.schedule) next.schedule = { ...card.schedule, action };
    next.scheduleDelivery = null;
  }
  // Within-list ordering: the drag-reorder writes ONE card's position (a float
  // midpoint between its new neighbours). Null resets to created order.
  if (body.position !== undefined) {
    if (body.position === null) next.position = null;
    else if (typeof body.position === "number" && Number.isFinite(body.position)) next.position = body.position;
    else return jsonRes(res, 400, { error: "position must be a finite number or null" });
  }
  // Checklist: whole-array replace (items are tiny and human-edited); the
  // normaliser drops malformed items and stamps doneAt.
  if (body.checklist !== undefined) {
    next.checklist = body.checklist === null ? null : normaliseChecklist(body.checklist);
  }
  // The dispatch record is ENGINE-ONLY: it is the claim ledger (who holds this
  // card, and when they last checked in). A hand-edited claim would let any
  // caller steal or forge a lease.
  if (isEngineRequest(req) && body.dispatch !== undefined) {
    next.dispatch = body.dispatch === null ? null : body.dispatch;
  }
  if (isEngineRequest(req) && body.dispatchRun && typeof body.dispatchRun === "object") {
    next.dispatchRuns = appendDispatchRunProvenance(next, body.dispatchRun);
  }
  // A claimed card must READ as running on the board, or a card being worked on
  // by a Mac looks idle here. Safe to set only because isOrphanedRun now skips a
  // card held by a live dispatch claim — otherwise the local orphan sweep would
  // reclaim a perfectly healthy remote run once it passed the single-turn age
  // ceiling (the runOwner pid belongs to another host, so its liveness check is
  // meaningless there).
  if (isEngineRequest(req) && typeof body.status === "string") {
    next.status = body.status;
  }
  if (isEngineRequest(req) && body.runningSince !== undefined) {
    next.runningSince = typeof body.runningSince === "string" ? body.runningSince : null;
  }
  if (isEngineRequest(req) && body.runDir !== undefined) {
    next.runDir = typeof body.runDir === "string" ? body.runDir : null;
  }
  if (isEngineRequest(req) && typeof body.attentionReason === "string") {
    next.attentionReason = body.attentionReason;
  }
  if (isEngineRequest(req) && typeof body.attentionKind === "string") {
    next.attentionKind = body.attentionKind;
  }
  if (isEngineRequest(req) && body.parkedFrom !== undefined) {
    next.parkedFrom = typeof body.parkedFrom === "string" ? body.parkedFrom : null;
  }
  if (isEngineRequest(req) && typeof body.retryKeepsContext === "boolean") {
    next.retryKeepsContext = body.retryKeepsContext;
  }
  if (isEngineRequest(req) && body.lastDispatchError !== undefined) {
    next.lastDispatchError = body.lastDispatchError && typeof body.lastDispatchError === "object"
      ? body.lastDispatchError
      : null;
  }
  // The level chain's runtime escalation (level-resolution.mjs step 3). The
  // gateway's POST /escalate resolves it, writes the decision record, and lands
  // the result here.
  //
  // Engine context only: this changes what a phase will EXECUTE at, so it is not
  // a human-editable card field - a person raises a level by re-pinning the run
  // spec, which goes through `routing`. And the raise-only rule is enforced here
  // as well as in the resolver, because this is the storage boundary: a caller
  // that never went through `escalateDuty` must not be able to walk a level back
  // down.
  if (body.dutyLevels !== undefined) {
    if (!isEngineRequest(req)) {
      return jsonRes(res, 403, {
        error: "engine-only",
        message: "dutyLevels is resolved by the router - escalate through the gateway's /escalate route."
      });
    }
    const patch = validateDutyLevels(body.dutyLevels);
    if (patch.error) return jsonRes(res, 400, { error: patch.error });
    if (patch.value) {
      const merged = mergeDutyLevels(card.dutyLevels, patch.value);
      // 400, not 409: a 409 from this endpoint means "the card changed under
      // you, re-read and retry", and a raise-only refusal must never be retried
      // into the same refusal.
      if (merged.error) return jsonRes(res, 400, { error: "duty-level-lowered", message: merged.error });
      const raised = Object.entries(patch.value).filter(([duty, level]) => (card.dutyLevels || {})[duty] !== level);
      next.dutyLevels = merged.value;
      if (raised.length) {
        // The reason is the caller's words but the MESSAGE is built here, so a
        // card event can never be arbitrary caller-authored text.
        const reason = typeof body.escalationReason === "string"
          ? body.escalationReason.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)
          : "";
        next.events = withEvent(next, {
          at: new Date().toISOString(),
          kind: "escalation",
          message:
            raised.map(([duty, level]) => `Escalated ${duty} L${(card.dutyLevels || {})[duty] ?? card.level ?? "?"} → L${level}`).join("; ") +
            (reason ? `: ${reason}` : "")
        });
      }
    }
  }
  if (isEngineRequest(req) && body.routeEvidence) {
    const event = quickRouteEvent(body.routeEvidence);
    if (event) {
      next.events = withEvent(next, event);
      if (event.detail) next.lastReply = event.detail;
    }
  }
  const movedLists = typeof body.list === "string" && next.list !== card.list;
  const landedTerminal = movedLists && Boolean(getList(board, next.list)?.terminal || next.list === "done");
  // §7.1: MOVING a held card IS the go. The router parked it in the capture list
  // and asked; taking it out of that list is the human answering with their hands
  // instead of their words, and it releases the hold in the SAME CAS write that
  // performs the move - so a card can never be simultaneously moved and still
  // held, which is the state a separate clearing write would leave behind on a
  // lost race.
  //
  // Deliberately different from `discussHeld`, which is never cleared: that flag
  // is inert once the card leaves Discuss, because its guard is list-scoped. This
  // one is not - a held card sits on whatever list it was parked in, so the flag
  // itself has to go or the guards below would hold it forever.
  const releasedAutonomyHold = movedLists && card.autonomyHeld === true;
  if (releasedAutonomyHold) {
    next.autonomyHeld = false;
    next.events = withEvent(next, {
      at: new Date().toISOString(),
      kind: "autonomy-go",
      message: `Released to ${listProseLabel(getList(board, next.list)?.title || next.list)} - the hold was answered`,
      detail: card.autonomyAsk?.question ?? null
    });
  }
  const expectedRev = Number.isInteger(body.rev) ? body.rev : (card.rev ?? 0);
  const commitPatch = async () => {
    if (needsImplicitMovePosition) next.position = await topOfListPosition(root, next.list);
    else if (typeof next.position === "number" && body.position !== undefined) {
      next.position = await collisionFreePosition(root, next.list, id, next.position);
    }
    return saveCardCASWithHooks(root, next, expectedRev, new Date().toISOString(), {
      // Existence + rev are checked before this hook while the external lifecycle
      // lock is held, so a losing PATCH cannot mint leases/intent for a transition
      // that never commits.
      beforeWrite: movedLists && shouldRecoverCoordinationHold(board, card, next)
        ? ({ next: lockedNext }) => prepareRecoveredCoordinationHold(board, lockedNext)
        : undefined,
      // Closure cleanup runs after the card write but before releasing that same
      // lifecycle lock; a concurrent reopen cannot slip between the two.
      afterWrite: landedTerminal
        ? ({ disk, next: lockedNext }) => cleanupClosedCoordinationHold(root, board, lockedNext, disk)
        : undefined
    });
  };
  const needsOrderLock = needsImplicitMovePosition || (typeof body.position === "number" && Number.isFinite(body.position));
  const commitWithOrder = () => needsOrderLock
    ? withCardOrderLock(root, commitPatch)
    : commitPatch();
  const touchesSchedule = body.schedule !== undefined || body.scheduledFor !== undefined || body.scheduleAction !== undefined;
  // Schedule mutation and the due sweep share one lock. The card CAS remains
  // authoritative, but this closes the final intent-check -> occurrence-create
  // window where a pause could otherwise commit between those two operations.
  const result = touchesSchedule
    ? await withFileLock(path.join(root, ".schedule-sweep.lock"), "schedule sweep", commitWithOrder)
    : await commitWithOrder();
  if (result.precondition) return coordinationRecoveryConflict(res, result.detail);
  if (result.deleted) return jsonRes(res, 404, { error: "card was deleted while you were editing it" });
  if (!result.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(result.card) });

  // "Moving to Plan starts planning": when the card is MOVED onto an immediate agent
  // list, dispatch its run now (fire-and-forget — the run goes through the gateway in
  // the background, the card flips to `running` and is watchable; the PATCH returns at
  // once). A manual / interactive (Discuss) / scheduler-beat (Test) target just moves.
  //
  // BUT an ENGINE request (x-garrison-engine: the garrison doorway positioning the
  // card, then driving it in-session via advanceCardPhase) must NOT also fire a
  // background processChain — that double-drives the card (background flow races the
  // in-session driver → invalid-verdict/park). The header now genuinely suppresses
  // auto-dispatch, matching the doorway's intent + engine.mjs's own claim (rev2-s567 S5-2).
  // S3d (D9b): a clarity-GATED card moved onto the interactive Discuss list IS
  // dispatched (the discuss duty runs a scope-Q&A session → brief → plan). This is
  // the intended run, so it fires even for an engine-header move (the gateway's
  // carding move carries x-garrison-engine) - unlike a normal engine move, which the
  // doorway drives itself. A human Discuss card (no gate marker) still just
  // moves (shouldAutoDispatch is false for the interactive list).
  const movedToGatedDiscuss =
    typeof body.list === "string" && isGatedDiscuss(result.card, getList(board, body.list));
  // An engine-context request suppresses the background chain UNLESS it explicitly
  // hands progression to the board. The garrison doorway omits that intent because
  // it drives in-session via advanceCardPhase; quick gateway cards omit it because
  // they run inline. Significant gateway registrations include it because they
  // return after registration and otherwise leave the card stranded until a tick or
  // manual Run press.
  const callerOwnsProgression = isEngineRequest(req) && !requestsAutoDispatch(req);
  // §7.1: releasing an autonomy hold IS the authorisation to progress, so it
  // dispatches even from an engine-context move. The gateway's channel-agnostic
  // "go" resume moves the card with the engine header and no dispatch intent
  // (moveCardEngine has one shape), and without this the answered card would sit
  // on Plan until a tick noticed it - which reads to the person who just said
  // "go" as nothing happening.
  const autoDispatch =
    movedToGatedDiscuss ||
    (releasedAutonomyHold && typeof body.list === "string" && shouldAutoDispatch(board, body.list)) ||
    (typeof body.list === "string" && shouldAutoDispatch(board, body.list) && !callerOwnsProgression);
  if (autoDispatch && opts.gatewayUrl) {
    // Coordination (GARRISON-FLOW-V2 S1) gates, applied the same way the tick does
    // before dispatching: a card deferred behind an overlapping run does NOT
    // auto-dispatch on move; and when coordination's substrate is degraded, the
    // serialize gate lets only the oldest live card per project proceed. Both leave
    // the card on its (already-moved) list, to be released/retried by a later tick.
    if (result.card.waitingOn) {
      const w = result.card.waitingOn;
      return jsonRes(res, 200, {
        card: cardSummary(result.card),
        dispatched: false,
        note: `waiting on ${w.cardTitle || w.cardId} (${w.until}) — will dispatch when released`
      });
    }
    const coordCfg = coordinationConfig(loadPolicy());
    if (coordCfg.enabled && coordCfg.serializeWhenUnavailable && !coordinationAvailability().ok) {
      const allCards = await loadAllCards(root);
      const gate = serializeGate(allCards, result.card, board);
      if (!gate.allowed) {
        return jsonRes(res, 200, { card: cardSummary(result.card), dispatched: false, note: gate.reason });
      }
    }
    if (await gatewayReachable(opts.gatewayUrl)) {
      // processChain runs the AUTOMATED FLOW: this list, then the next immediate
      // agent list, and so on (Plan → Implement → Review → …) without waiting for a
      // Start press or the next tick. Fire-and-forget — the card flips to running and
      // is watchable; the PATCH returns at once.
      void processChain({ root, board, card: result.card, runFn: gatewayRunFn(opts.gatewayUrl), cap: opts.cap, cwd: opts.cwd, onDutyBoundary: compactBoundaryFn(opts.gatewayUrl) })
        .catch((err) => console.error(`[kanban-loop] auto-dispatch on move failed for ${id}:`, err?.message || err));
      return jsonRes(res, 200, { card: cardSummary(result.card), dispatched: true });
    }
    // Gateway down: the card stays on the target list (already moved, status ok) and
    // WAITS — it dispatches on the next tick or via Start once an operative is up. We
    // do NOT fire a doomed run that would park it in needs-attention just for moving.
    // Persist the reason on the card so the UI can render a visible badge instead of
    // leaving the user to discover a silent failure in the patch response.
    const withError = {
      ...result.card,
      lastDispatchError: {
        at: new Date().toISOString(),
        reason: "gateway-unavailable",
        listId: body.list,
        message: "gateway not reachable — start an operative (composition up) and Retry"
      }
    };
    const errSave = await saveCardCAS(root, withError, result.card.rev ?? 0);
    const finalCard = errSave.ok ? errSave.card : result.card;
    return jsonRes(res, 200, { card: cardSummary(finalCard), dispatched: false, note: "gateway not reachable — card waits on this list until an operative is up" });
  }
  jsonRes(res, 200, {
    card: cardSummary(result.card),
    ...(result.postCommitError ? { coordinationCleanupPending: true } : {})
  });
}

// DELETE /cards/:id — delete the card AND the artifacts it produced that are safe to
// remove. WHAT gets deleted (decided here, not asked):
//   - the card's own dir (cards/<id>/: card.json + every log-<n>.md) — always;
//   - the run directory it produced (docs/autothing/runs/<runId>/: the plan + gate
//     scratch) — only the card's OWN minted ULID runId, confined under the project's
//     runs dir so it can never delete an unrelated/timestamped garrison run;
//   - its Discuss brief (card.briefPath) — confined under the briefs dir.
// What is NEVER deleted: the Claude Code session transcripts (shared ~/.claude), the
// external walkthrough video, and any code the operative committed to the repo (that
// lives in version control, not "the card's" to remove). originAllowed guard like the
// other mutating routes; the id is already validated (clean ULID) by the router.
async function handleDeleteCard(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin delete rejected" });
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id
  // D16: an engine-owned card (on an autonomous list) cannot be deleted
  // mid-run — resolve it via needs-attention first.
  const boardForLock = await loadBoard(opts.root);
  if (isEngineOwned(boardForLock, card) && !isEngineRequest(req)) {
    return jsonRes(res, 403, {
      error: "engine-owned",
      message: `Card is on the autonomous list "${card.list}" — engine-owned (D16). Let the run finish or resolve it from needs-attention, then delete.`
    });
  }
  const removed = [];

  // 1. The card's own directory (always).
  const deleted = await deleteCard(opts.root, id, card.rev ?? 0, {
    afterDelete: ({ disk }) => cleanupClosedCoordinationHold(opts.root, boardForLock, disk, card)
  });
  if (deleted) {
    removed.push(`cards/${id}`);
  } else {
    let fresh = null;
    try { fresh = await loadCard(opts.root, id); } catch { /* concurrently deleted */ }
    if (fresh) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(fresh) });
    return jsonRes(res, 404, { error: `card not found: ${id}` });
  }

  // 2. The run directory it produced — only the card's own ULID runId, confined
  // to the evidence home (~/.garrison/runs/, D19). Legacy repo-relative runDirs
  // (pre-S6 cards) are ALSO handled, confined to the old docs/autothing/runs.
  if (card.runId && isValidCardId(card.runId)) {
    const runsHome = process.env.GARRISON_RUNS_DIR
      || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "runs");
    const legacyRoot = path.resolve(projectRoot(), "docs", "autothing", "runs");
    const candidates = [];
    if (typeof card.runDir === "string" && path.isAbsolute(card.runDir)) {
      const confined = confinePath(path.resolve(card.runDir), [runsHome]);
      if (confined) candidates.push({ abs: confined, label: card.runDir });
    }
    const legacy = confinePath(path.resolve(legacyRoot, card.runId), [legacyRoot]);
    if (legacy) candidates.push({ abs: legacy, label: `docs/autothing/runs/${card.runId}` });
    for (const c of candidates) {
      if (existsSync(c.abs)) {
        try { await rm(c.abs, { recursive: true, force: true }); removed.push(c.label); }
        catch { /* best-effort */ }
      }
    }
  }

  // 3. Its Discuss brief — confined under the briefs dir.
  if (typeof card.briefPath === "string" && card.briefPath) {
    const briefsDir = (opts.briefsPath || process.env.KANBAN_BRIEFS_PATH || "./briefs/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    const briefsRoot = path.resolve(projectRoot(), briefsDir);
    const confined = confinePath(path.resolve(projectRoot(), card.briefPath), [briefsRoot]);
    if (confined && existsSync(confined) && statSync(confined).isFile()) {
      try { await unlink(confined); removed.push(card.briefPath); }
      catch { /* best-effort */ }
    }
  }

  jsonRes(res, 200, { ok: true, deleted: id, removed });
}

// Where a card's prepared-revert descriptor is persisted durably (S2, Q7): a sibling
// of the run's other coordination evidence. atomicWriteJSON mkdir -p's the dir, so a
// runDir without a coordination/ subdir yet is fine.
function preparedRevertFile(runDir) {
  return path.join(runDir, "coordination", "prepared-revert.json");
}

// POST /cards/:id/abandon — abandonment revert (S2, Q7, D8). A HUMAN-ONLY action:
// the run engine's own moves carry x-garrison-engine and are rejected (the engine
// never abandons a card; a person decides to). It builds a PREPARED (not applied)
// revert descriptor from the card's trailer-attributed commits, persists it durably +
// onto the card, releases the card's coordination holds (ledger intents + exclusive
// leases), and PARKS the card in needs-attention with the abandoned flag set. Setting
// `abandoned` is what releases any terminal-waiters on the next engine reevaluation
// (reevaluateWaiting treats an abandoned blocker as gone) and frees the card's
// serialize-gate slot — the revert itself is NEVER applied here (that is the separate,
// explicitly-confirmed /revert step).
async function handleAbandonCard(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin abandon rejected" });
  if (isEngineRequest(req)) {
    return jsonRes(res, 403, {
      error: "human-only",
      message: "Abandonment is a human decision — the run engine never abandons a card. Abandon it from needs-attention in the UI."
    });
  }
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id
  const board = await loadBoard(root);
  const repoPath = repoPathForProject(card.project, board);
  const at = new Date().toISOString();

  // Build the prepared-revert descriptor (read-only on git). An unresolvable repo
  // yields an honest empty descriptor (0 commits) so abandonment still parks the card.
  const descriptor = prepareRevert({ repoPath, card }) || {
    cardId: id,
    project: card.project ?? null,
    repoPath: repoPath ?? null,
    commits: [],
    preparedAt: at,
    conflictRisk: [],
    state: "prepared"
  };

  const n = descriptor.commits.length;
  const reason = `Abandoned - prepared revert of ${n} commit${n === 1 ? "" : "s"} ready; confirm to apply`;
  const target = {
    ...card,
    // Park it in needs-attention (a real list move). Preserve an existing parkedFrom
    // when the card was ALREADY parked (don't overwrite it with needs-attention).
    ...parkFields(card, card.list === ATTENTION_LIST ? undefined : card.list, reason),
    abandoned: true,
    preparedRevert: descriptor,
    // An abandoned card is no longer waiting on anyone — drop its own wait if it had one.
    waitingOn: null,
    events: withEvent(card, {
      at,
      kind: "coordination",
      message: `Abandoned by request - prepared revert of ${n} commit(s) ready to apply`,
      detail: descriptor.commits.length ? descriptor.commits.map((s) => String(s).slice(0, 10)).join("\n") : null
    })
  };
  const transition = await saveCardCASWithHooks(root, target, card.rev ?? 0, at, {
    afterWrite: async ({ disk, next }) => {
      // Evidence + owner-scoped cleanup happen only after abandonment commits,
      // while a reopen/delete is still excluded by the lifecycle lock.
      if (next.runDir) {
        try { await atomicWriteJSON(preparedRevertFile(next.runDir), descriptor); }
        catch { /* the card copy remains authoritative */ }
      }
      cleanupClosedCoordinationHold(root, board, next, disk);
    }
  });
  if (transition.deleted) return jsonRes(res, 404, { error: `card not found: ${id}` });
  if (!transition.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(transition.card || card) });
  const updated = transition.card;
  return jsonRes(res, 200, {
    card: cardSummary(updated),
    preparedRevert: cardSummary(updated).preparedRevert,
    ...(transition.postCommitError ? { coordinationCleanupPending: true } : {})
  });
}

// POST /cards/:id/drill — hand this card's change to Drill: plan the checks for it,
// run them, and notify when the verdict is in. Human-only and `done`-only: the point
// is "the change landed, now prove it works", and a card that has not landed has no
// change to test. Idempotent-ish by way of Drill's own per-card in-flight guard — a
// second press while a job runs joins that job (started:false) instead of starting a
// competing plan against the same repo.
async function handleSendToDrill(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin drill dispatch rejected" });
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id;

  const eligible = drillEligibility(card);
  if (!eligible.ok) return jsonRes(res, 400, { error: eligible.reason });

  // A card's `project` is a LABEL ("garrison"), not necessarily a path. Drill
  // pins its plan + run to an absolute root and rejects anything else, so
  // resolve the label here through the board's own project resolution.
  const board = await loadBoard(root);
  const resolved = resolveDrillProject(card, board, repoPathForProject);
  if (resolved.error) return jsonRes(res, 400, { error: resolved.error });

  let handoff;
  try {
    handoff = await sendCardToDrill(root, card, { repoPath: resolved.repoPath });
  } catch (err) {
    // A failed handoff is stamped on the card, not just returned: the user
    // pressed a button and walked away, and "it never went" has to be visible
    // on the board too, not only in the toast they may not have seen.
    const message = err?.message || String(err);
    await updateCard(root, id, (c) => ({
      ...c,
      drill: drillStamp({ state: "error", error: message }),
      events: withEvent(c, { at: new Date().toISOString(), kind: "dispatch", message: `Send to Drill failed — ${message}` })
    }));
    return jsonRes(res, 502, { error: message });
  }

  const job = handoff.job ?? null;
  const updated = await updateCard(root, id, (c) => ({
    ...c,
    drill: drillStamp({
      state: job?.state ?? "planning",
      jobId: job?.id ?? null,
      // No per-job route exists in Drill's UI (it routes ?view=…&run=…), so
      // while the job is still planning the link is Drill's Run & results view.
      // Once the run exists, drill-result replaces this with the run's own URL.
      drillUrl: handoff.drillUrl,
      jobUrl: `${handoff.drillUrl}/?view=results`
    }),
    events: withEvent(c, {
      at: new Date().toISOString(),
      kind: "dispatch",
      message: handoff.started
        ? "Sent to Drill — planning the test for this change, then running it"
        : "Already being drilled — joined the in-flight job"
    })
  }));
  return jsonRes(res, 200, { card: cardSummary(updated ?? card), job, started: handoff.started });
}

// POST /cards/:id/drill-result — Drill's completion callback, and one of the four
// notification means (broadcast.mjs): the verdict lands back ON the card, so the
// board shows it without opening Drill. Engine-context (Drill posts it), never a
// human action.
async function handleDrillResult(req, res, opts, id) {
  const root = opts.root;
  const body = (await readBody(req)) ?? {};
  const state = ["passed", "partial", "failed", "error"].includes(body.state) ? body.state : null;
  if (!state) return jsonRes(res, 400, { error: "state must be passed | partial | failed | error" });

  const text = (v, max = 400) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const findings = num(body.findings) ?? 0;
  const headline = text(body.headline, 1200);
  const unproven = num(body.unproven) ?? 0;
  const message =
    state === "passed"
      ? "Drill passed — every check on this change's pages passed"
      : state === "partial"
        ? `Drill passed what it could prove — ${unproven} check${unproven === 1 ? "" : "s"} unproven, so this change is not fully verified`
        : state === "failed"
          ? `Drill found ${findings} issue${findings === 1 ? "" : "s"} on this change`
          : "Drill could not finish this change's test run";

  const updated = await updateCard(root, id, (c) => ({
    ...c,
    drill: drillStamp({
      state,
      jobId: text(body.jobId, 64),
      runId: text(body.runId, 64),
      runUrl: text(body.runUrl, 500),
      findings,
      checks: num(body.checks),
      failed: num(body.failed),
      unproven,
      // Keep the dispatch link so the card can still reach Drill after the job ends.
      drillUrl: typeof c.drill?.drillUrl === "string" ? c.drill.drillUrl : null
    }),
    events: withEvent(c, { at: new Date().toISOString(), kind: state === "passed" ? "dispatch" : "failed", message, detail: headline })
  }));
  if (!updated) return jsonRes(res, 404, { error: `card not found: ${id}` });
  return jsonRes(res, 200, { card: cardSummary(updated) });
}

// POST /cards/:id/revert — apply a card's prepared revert (S2, Q7, D8). Requires an
// EXPLICIT { confirm: true } body — anything else is a 400 (the revert is NEVER
// auto-applied). Runs only when a descriptor in state "prepared" exists; a
// non-prepared descriptor (already applied, or a prior conflict) is a 409 (the lib
// never retries a revert silently). On success the descriptor flips to "applied" +
// the revert commits land (carrying Garrison-Card / Garrison-Revert trailers) and the
// card stays parked for the user to archive; on ANY conflict executeRevert aborts
// cleanly (nothing half-applied) and we persist state "conflict" + a 409.
async function handleRevertCard(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin revert rejected" });
  const body = (await readBody(req)) || {};
  if (body.confirm !== true) {
    return jsonRes(res, 400, { error: "revert requires an explicit { confirm: true } — it is never auto-applied" });
  }
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id
  const pr = card.preparedRevert;
  if (!pr) return jsonRes(res, 400, { error: "no prepared revert — abandon the card first to prepare one" });
  if (pr.state !== "prepared") {
    return jsonRes(res, 409, { error: `revert is not in a confirmable state (state: ${pr.state})`, card: cardSummary(card) });
  }

  const at = new Date().toISOString();
  const result = executeRevert({ repoPath: pr.repoPath, cardId: id, commits: pr.commits });

  if (result.state === "conflict") {
    const next = { ...pr, state: "conflict", conflictAt: at, conflictSha: result.sha ?? null, error: result.error ?? null };
    if (card.runDir) { try { await atomicWriteJSON(preparedRevertFile(card.runDir), next); } catch { /* best-effort */ } }
    const updated = await updateCard(root, id, (c) => ({
      ...c,
      preparedRevert: next,
      // Refresh the parked reason so the callout stops saying "confirm to apply".
      attentionReason: "Revert hit a conflict - aborted cleanly; resolve manually",
      events: withEvent(c, {
        at,
        kind: "coordination",
        message: `Revert conflicted${result.sha ? ` at ${String(result.sha).slice(0, 10)}` : ""} - aborted cleanly, nothing applied`,
        detail: result.error ?? null
      })
    }));
    const finalCard = updated ?? card;
    return jsonRes(res, 409, {
      error: "revert conflicted - aborted cleanly, nothing was applied",
      card: cardSummary(finalCard),
      preparedRevert: cardSummary(finalCard).preparedRevert
    });
  }

  // applied (or noop: no attributed commits — trivially done, recorded honestly)
  const revertCommits = Array.isArray(result.revertCommits) ? result.revertCommits : [];
  const next = { ...pr, state: "applied", appliedAt: at, revertCommits };
  if (card.runDir) { try { await atomicWriteJSON(preparedRevertFile(card.runDir), next); } catch { /* best-effort */ } }
  const message = result.state === "noop"
    ? "Revert confirmed - no attributed commits to revert, nothing to apply"
    : `Revert applied - ${revertCommits.length} revert commit(s) landed`;
  // Refresh the parked reason so the callout stops saying "confirm to apply".
  const attentionReason = result.state === "noop"
    ? "Revert confirmed - no commits to revert"
    : `Revert applied - ${revertCommits.length} commit${revertCommits.length === 1 ? "" : "s"} reverted`;
  const updated = await updateCard(root, id, (c) => ({
    ...c,
    preparedRevert: next,
    attentionReason,
    events: withEvent(c, {
      at,
      kind: "coordination",
      message,
      detail: revertCommits.length ? revertCommits.map((s) => String(s).slice(0, 10)).join("\n") : null
    })
  }));
  const finalCard = updated ?? card;
  return jsonRes(res, 200, {
    card: cardSummary(finalCard),
    preparedRevert: cardSummary(finalCard).preparedRevert,
    reverted: revertCommits
  });
}

// POST /cards/:id/brief — record the Discuss brief path onto the card
// (the link-never-duplicate write side: the card LINKS the brief, never inlines
// its body — FINDING 10). Body: { briefPath } — a relative path under briefs_path.
// recordBrief validates the path is safe (relative, no `..`/absolute escape) and
// CAS-sets card.briefPath. Same originAllowed + isValidCardId guards as the other
// mutating routes (the id is already validated by the router before this runs).
async function handleBriefCard(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin brief write rejected" });
  const body = (await readBody(req)) || {};
  const briefPath = typeof body.briefPath === "string" ? body.briefPath.trim() : "";
  if (!briefPath) return jsonRes(res, 400, { error: "briefPath required" });
  try {
    // Confine the recorded brief to the configured briefs dir (modes briefs_path,
    // default ./briefs/) so the link can only point at a brief under that dir.
    const briefsPath = opts.briefsPath || process.env.KANBAN_BRIEFS_PATH || "./briefs/";
    const updated = await recordBrief(opts.root, id, briefPath, { briefsPath });
    return jsonRes(res, 200, { card: cardSummary(updated) });
  } catch (err) {
    if (err && err.conflict) return jsonRes(res, 409, { error: err.message, card: cardSummary(err.card) });
    // A bad id / unsafe path is a client error; a missing card is a 404.
    if (/invalid card id|unsafe brief path/.test(String(err?.message))) {
      return jsonRes(res, 400, { error: err.message });
    }
    return jsonRes(res, 404, { error: `card not found: ${id}` });
  }
}

// POST /cards/:id/start — Start/Advance. On a MANUAL list, Start moves the card
// to its first validNext (the "move a card out of a manual column" path). On an
// AGENT list, Start dispatches the card through the engine (processCard) using
// the live gateway, exactly as --tick would. An interactive list (Discuss) is
// never auto-dispatched.
// POST /cards/:id/snooze - the human/Zeca verb for "push the schedule out".
// Accepts { minutes } (relative) or { until } (ISO), optional { action }.
// Works on a card with no schedule too (snooze = schedule from now).
async function handleSnoozeCard(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin snooze rejected" });
  return withFileLock(path.join(opts.root, ".schedule-sweep.lock"), "schedule sweep", async () => {
    const body = (await readBody(req)) || {};
    const root = opts.root;
    let card;
    try { card = await loadCard(root, id); }
    catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
    card.id = id;
    if (card.status === "running") {
      return jsonRes(res, 409, { error: "running", message: "the card is running - snooze can only hold a card that has not started" });
    }
    let untilIso = null;
    if (typeof body.until === "string" && Number.isFinite(Date.parse(body.until))) {
      untilIso = new Date(Date.parse(body.until)).toISOString();
    } else if (Number.isFinite(Number(body.minutes)) && Number(body.minutes) > 0) {
      // Cap a relative snooze at one year - a typo'd "200000 minutes" should not
      // quietly bury a card into 2027.
      untilIso = new Date(Date.now() + Math.min(Number(body.minutes), 60 * 24 * 366) * 60000).toISOString();
    }
    if (!untilIso) return jsonRes(res, 400, { error: "pass minutes (a positive number) or until (a parseable ISO date-time)" });
    const action = normaliseScheduleAction(body.action ?? card.schedule?.action ?? card.scheduleAction);
    const targetList = card.list === "scheduled" ? card.schedule?.targetList ?? "backlog" : card.list;
    const updated = await updateCard(root, id, (c) => ({
      ...c,
      list: "scheduled",
      status: "ok",
      schedule: c.schedule?.kind === "cron"
        ? { ...c.schedule, action, enabled: true, nextAt: untilIso, snoozedUntil: untilIso }
        : normaliseCardSchedule({
            kind: "once", action, at: untilIso, timezone: c.schedule?.timezone ?? "Europe/Lisbon",
            enabled: true, targetList
          }),
      scheduledFor: untilIso,
      scheduleAction: action,
      scheduleNotifiedAt: null,
      scheduleDelivery: null,
      events: withEvent(c, {
        at: new Date().toISOString(),
        kind: "moved",
        message: `Snoozed until ${untilIso} (${action === "run" ? "auto-run" : "notify"})`
      })
    }));
    if (!updated) return jsonRes(res, 409, { error: "card changed under you" });
    return jsonRes(res, 200, { card: cardSummary(updated) });
  });
}

// POST /cards/:id/run-now — recurring templates create an extra linked
// occurrence without moving their regular nextAt. A one-shot is pulled due and
// released through the same sweep as the scheduler tick.
async function handleRunScheduleNow(req, res, opts, id) {
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  const board = await loadBoard(opts.root);
  if (card.schedule?.kind === "cron") {
    try {
      const result = await runScheduleNow(opts.root, board, id);
      return jsonRes(res, 200, { card: cardSummary(result.card), occurrence: true, created: result.created });
    } catch (error) {
      return jsonRes(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (card.schedule?.kind === "once" || card.scheduledFor) {
    const stamp = new Date().toISOString();
    await updateCard(opts.root, id, (current) => {
      const schedule = current.schedule ?? normaliseCardSchedule(null, {
        scheduledFor: current.scheduledFor,
        scheduleAction: "run",
        targetList: current.list
      });
      if (!schedule) return current;
      return {
        ...current,
        schedule: { ...schedule, action: "run", enabled: true, nextAt: stamp },
        scheduledFor: stamp,
        scheduleAction: "run",
        scheduleNotifiedAt: null
      };
    });
    await sweepDueSchedules(opts.root, board, { now: () => stamp, at: () => Date.parse(stamp) });
    const updated = await loadCard(opts.root, id);
    return jsonRes(res, 200, { card: cardSummary(updated), occurrence: false, created: false });
  }
  return jsonRes(res, 409, { error: "card has no active schedule" });
}

// POST /cards/:id/attachments { filename, content_base64 } - card-owned upload
// into cards/<id>/attachments/. Same JSON-base64 wire shape as the gateway's
// /attachments; 10 MB decoded cap; plain filenames only. The listing is derived
// by readdir (never stored on the card), the serve side is the opaque
// `attachment:<name>` artifact ref, and the engine folds the absolute paths
// into the dispatch prompt.
const MAX_CARD_ATTACHMENT_BYTES = 10 * 1024 * 1024;
async function handleAttachmentUpload(req, res, opts, id) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin upload rejected" });
  const root = opts.root;
  try { await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  const body = (await readBody(req)) || {};
  const rawName = typeof body.filename === "string" ? path.basename(body.filename.trim()) : "";
  const name = rawName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  if (!name || !isSafeEvidenceName(name)) return jsonRes(res, 400, { error: "filename must reduce to a plain file name" });
  if (typeof body.content_base64 !== "string" || !body.content_base64) {
    return jsonRes(res, 400, { error: "content_base64 required" });
  }
  const bytes = Buffer.from(body.content_base64, "base64");
  if (!bytes.length) return jsonRes(res, 400, { error: "empty file" });
  if (bytes.length > MAX_CARD_ATTACHMENT_BYTES) return jsonRes(res, 413, { error: "attachment exceeds the 10 MB cap" });
  const dir = cardAttachmentsDir(root, id);
  await mkdir(dir, { recursive: true });
  // Never overwrite silently: an existing name gains a numeric suffix.
  let finalName = name;
  for (let n = 2; existsSync(path.join(dir, finalName)); n++) {
    const ext = path.extname(name);
    finalName = `${path.basename(name, ext)}-${n}${ext}`;
  }
  const abs = path.join(dir, finalName);
  await writeFile(abs, bytes);
  return jsonRes(res, 200, {
    name: finalName,
    bytes: bytes.length,
    path: abs,
    url: `/cards/${encodeURIComponent(id)}/artifact?ref=${encodeURIComponent(`attachment:${finalName}`)}`
  });
}

// DELETE /cards/:id/attachments?name=<file> - remove ONE card-owned upload.
// Only the card's own attachments dir; the legacy description-block paths are
// not files the board owns, so they cannot be deleted here.
async function handleAttachmentRemove(req, res, opts, id, name) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin attachment delete rejected" });
  const root = opts.root;
  try { await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  const n = typeof name === "string" ? name : "";
  if (!isSafeEvidenceName(n)) return jsonRes(res, 400, { error: "bad attachment name" });
  const abs = path.join(cardAttachmentsDir(root, id), n);
  if (!existsSync(abs)) return jsonRes(res, 404, { error: "no such attachment" });
  await unlink(abs);
  return jsonRes(res, 200, { ok: true, removed: n });
}

// GET /cards/resolve?ref=<token> - resolve a human/spoken card handle to a
// card. Accepts a full ULID, a ULID suffix (>= 3 chars - the notification's
// short ref), or a case-insensitive title fragment. Ambiguity is an answer
// (409 with candidates), never a guess - this is what the wake bus and the
// operative's card tools call before acting on "run card 7Q2M".
async function handleResolveCard(req, res, opts, query) {
  const raw = typeof query?.ref === "string" ? query.ref.trim() : "";
  if (!raw) return jsonRes(res, 400, { error: "pass ?ref=<card id, id suffix, or title fragment>" });
  const cards = await loadAllCards(opts.root);
  const upper = raw.toUpperCase();
  let matches = [];
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(upper)) matches = cards.filter((c) => c.id === upper);
  if (!matches.length && /^[0-9A-HJKMNP-TV-Z]{3,25}$/.test(upper)) matches = cards.filter((c) => c.id.endsWith(upper));
  if (!matches.length) {
    const needle = raw.toLowerCase();
    matches = cards.filter((c) => String(c.title || "").toLowerCase().includes(needle));
  }
  // Prefer live cards when the ref is ambiguous only because of done ones.
  if (matches.length > 1) {
    const live = matches.filter((c) => c.list !== "done");
    if (live.length) matches = live;
  }
  if (!matches.length) return jsonRes(res, 404, { error: `no card matches "${raw}"` });
  if (matches.length > 1) {
    return jsonRes(res, 409, {
      error: `"${raw}" is ambiguous`,
      candidates: matches.slice(0, 8).map((c) => ({ id: c.id, title: c.title, list: c.list }))
    });
  }
  return jsonRes(res, 200, { card: cardSummary(matches[0]) });
}

// POST /reconcile - live board reconcile against the CURRENT resolved model
// (model.json): the same add/drop/refresh the setup hook performs, callable by
// the shell right after a duty create/remove so a new list appears without an
// operative restart. Stranded cards are parked; scheduler beats re-sync.
async function handleReconcile(req, res, opts) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin reconcile rejected" });
  const root = opts.root;
  const model = loadResolvedModel(root);
  if (!model) return jsonRes(res, 409, { error: "no resolved model on disk (run a composition up first)" });
  const existing = await loadBoard(root).catch(() => null);
  if (!existing) return jsonRes(res, 409, { error: "no board on disk" });
  const { board, removed, added, updated } = reconcileExistingBoard(existing, model);
  let moved = [];
  if (removed.length || added.length || updated.length) {
    await atomicWriteJSON(path.join(root, "board.json"), board);
    moved = await relocateStrandedCards(root, board, removed);
    try { await registerSchedulerBeats(); } catch { /* beat sync is best-effort here */ }
  }
  return jsonRes(res, 200, { ok: true, added, removed, updated, movedToAttention: moved });
}

async function handleStartCard(req, res, opts, id) {
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — saveCardCAS/processCard write under this id
  const board = await loadBoard(root);
  const list = getList(board, card.list);
  if (!list) return jsonRes(res, 400, { error: `card on unknown list: ${card.list}` });

  // An INTERACTIVE list (Discuss) advances ONLY by a manual Move (PATCH) — never
  // by Start/Advance (brief decision 8: the advance is manual). Reject it here so
  // a Start cannot skip the brief-to-disk hand-off. EXCEPTION (S3d): a clarity-gated
  // discuss card runs the discuss duty as a real session, so Start dispatches it
  // like any agent list; a human Discuss card (no gate marker) stays manual.
  if (isInteractive(list) && !isGatedDiscuss(card, list)) {
    return jsonRes(res, 400, {
      error: "interactive list (Discuss) advances by manual Move, not Start — open the web chat, then Move when ready"
    });
  }

  // Manual columns normally advance to their first valid edge. Needs-attention
  // instead resumes its still-valid parkedFrom phase, preserving the failed
  // phase's run context. A gated Discuss card falls through to agent dispatch.
  if (list.kind !== "agent" && !isGatedDiscuss(card, list)) {
    // A manual-only rail (empty phase plan — the personal/channel kinds, or a
    // card with every phase toggled off) never advances INTO the dev pipeline:
    // its journey is the manual head/tail, so Advance targets the manual
    // subset of the list's exits, or Done when the pipeline was the only exit.
    // parkedFrom resume is skipped too — there is no phase context to preserve.
    const manualOnly = railIsManualOnly(railForCard(loadPolicy(), card));
    let targets = validNextFor(board, card.list);
    if (manualOnly) {
      const manual = targets.filter((t) => getList(board, t)?.kind === "manual");
      targets = manual.length ? manual : ["done"];
    }
    const parkedTarget =
      !manualOnly &&
      card.list === ATTENTION_LIST &&
      typeof card.parkedFrom === "string" &&
      card.parkedFrom !== ATTENTION_LIST &&
      getList(board, card.parkedFrom)
        ? card.parkedFrom
        : null;
    const target = parkedTarget ?? targets[0];
    if (!target) return jsonRes(res, 400, { error: `nothing to advance to from ${card.list}` });
    const recovering = card.list === ATTENTION_LIST;
    const landedTerminal = Boolean(getList(board, target)?.terminal || target === "done");
    const at = new Date().toISOString();
    const overridden = consumeStartOverrides(card, at);
    const recover = recovering ? unparkRecoveryFields(card) : {};
    const fromTitle = list.title || card.list;
    const toTitle = getList(board, target)?.title || target;
    let events = withEvent(overridden, {
      at,
      kind: recovering ? "recovered" : "moved",
      message: recovering ? `Recovered: advanced ${listProseLabel(fromTitle)} → ${listProseLabel(toTitle)}` : `Advanced ${listProseLabel(fromTitle)} → ${listProseLabel(toTitle)}`
    });
    if (recovering && card.retryKeepsContext) {
      events = withEvent({ events }, {
        at,
        kind: "retry-keeps-context",
        message: "Retry preserves prior context (phase runDir + iteration logs kept)"
      });
    }
    const next = { ...overridden, list: target, status: "ok", events, ...recover };
    const result = await saveCardCASWithHooks(root, next, card.rev ?? 0, at, {
      beforeWrite: isHumanHeld(card, board) && !landedTerminal
        ? ({ next: lockedNext }) => prepareRecoveredCoordinationHold(board, lockedNext)
        : undefined,
      afterWrite: landedTerminal
        ? ({ disk, next: lockedNext }) => cleanupClosedCoordinationHold(root, board, lockedNext, disk)
        : undefined
    });
    if (result.precondition) return coordinationRecoveryConflict(res, result.detail);
    if (result.deleted) return jsonRes(res, 404, { error: "card was deleted while you were editing it" });
    if (!result.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(result.card) });
    // If we advanced onto an immediate agent list, kick the automated flow.
    if (shouldAutoDispatch(board, target) && opts.gatewayUrl && (await gatewayReachable(opts.gatewayUrl))) {
      void processChain({ root, board, card: result.card, runFn: gatewayRunFn(opts.gatewayUrl), cap: opts.cap, cwd: opts.cwd, onDutyBoundary: compactBoundaryFn(opts.gatewayUrl) })
        .catch((err) => console.error(`[kanban-loop] advance-chain failed for ${id}:`, err?.message || err));
    }
    return jsonRes(res, 200, {
      card: cardSummary(result.card),
      advanced: target,
      ...(result.postCommitError ? { coordinationCleanupPending: true } : {})
    });
  }

  // Agent list: dispatch through the engine. Requires a LIVE gateway — PING it first
  // so an explicit Start while no operative is up returns a clear 503 (telling the
  // user to start an operative) instead of firing a doomed run that parks the card.
  const gatewayUrl = opts.gatewayUrl;
  if (!gatewayUrl || !(await gatewayReachable(gatewayUrl))) {
    return jsonRes(res, 503, { error: "gateway not reachable — start an operative (composition up) before dispatching an agent list" });
  }
  // Coordination serialize gate (GARRISON-FLOW-V2 S1, Q8): when coordination is
  // enabled but its substrate is degraded, only the oldest live card per project may
  // dispatch — the same choke the tick applies. Start authorizes a waiting-card
  // override, but the engine consumes it only in the eventual run-acquire CAS.
  {
    const coordCfg = coordinationConfig(loadPolicy());
    if (coordCfg.enabled && coordCfg.serializeWhenUnavailable && !coordinationAvailability().ok) {
      const allCards = await loadAllCards(root);
      const gate = serializeGate(allCards, card, board);
      if (!gate.allowed) return jsonRes(res, 409, { error: gate.reason, card: cardSummary(card) });
    }
  }
  // Do not consume wait/schedule in a standalone save here. The engine folds the
  // explicit override into the exact status:"running" acquire CAS; every
  // pre-acquire refusal/race therefore leaves both holds untouched.
  const manualStart = Boolean(card.waitingOn || card.scheduledFor);
  const cap = opts.cap;

  // A BATCHED list (Test) runs one session per PROJECT with a per-card-verdict router
  // format, so a manual Run must drive the BATCHED path — not the per-card chain (whose
  // single-card reply can't satisfy the batch router prompt). Run just THIS card's
  // project group, exactly as the scheduler beat would. This is what makes "Run" work
  // on Test without waiting for the beat or fiddling with the trigger.
  if (list.batched) {
    const all = await loadAllCards(root);
    const projectKey = card.project || "(no-project)";
    const projectCards = all.filter((c) => c.list === card.list && (c.project || "(no-project)") === projectKey);
    void processBatch({
      root,
      board,
      listId: card.list,
      cards: projectCards,
      batchRunFn: batchGatewayRunFn(gatewayUrl),
      cap,
      cwd: opts.cwd,
      manualStartIds: manualStart ? [card.id] : []
    })
      .catch((err) => console.error(`[kanban-loop] start/batch failed for ${id}:`, err?.message || err));
    return jsonRes(res, 200, { card: cardSummary({ ...card, status: "running" }), dispatched: true, batched: true });
  }

  // Run the AUTOMATED FLOW fire-and-forget (a real chain is minutes long — never block
  // the HTTP response on it). The card flips to running and is watchable; the response
  // returns at once. This is the manual Run / Retry path (the UI shows it on any agent
  // list card that isn't already running; immediate agent lists also auto-run on entry).
  void processChain({
    root,
    board,
    card,
    runFn: gatewayRunFn(gatewayUrl),
    cap,
    cwd: opts.cwd,
    onDutyBoundary: compactBoundaryFn(gatewayUrl),
    manualStart
  })
    .catch((err) => console.error(`[kanban-loop] start/chain failed for ${id}:`, err?.message || err));
  // This response is already an accepted-dispatch projection (the chain is
  // intentionally fire-and-forget). Reflect the same override that the acquire
  // CAS will consume, without writing it early: a failed acquire still leaves
  // the durable wait/schedule untouched for a safe retry.
  const acceptedCard = manualStart
    ? consumeStartOverrides({ ...card, status: "running" }, new Date().toISOString())
    : { ...card, status: "running" };
  jsonRes(res, 200, { card: cardSummary(acceptedCard), dispatched: true });
}

// POST /cards/:id/panic — stop only the gateway turn that proves it owns this
// card. The endpoint intentionally does NOT mutate the card: processCard/processBatch
// still owns the status:"running" CAS and will atomically park the interrupted
// result. Writing here would bump rev, race the terminal save, and recreate the
// running-card wedge this engine's rebase discipline exists to prevent.
async function handlePanicCard(req, res, opts, id) {
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  if (card.status !== "running") {
    const message = "Panic only stops an active runtime turn. This card is no longer running; refresh the board before retrying.";
    return jsonRes(res, 409, {
      code: "card-not-running",
      error: message,
      message
    });
  }
  const remoteClaim = card.dispatch
    && typeof card.dispatch === "object"
    && card.dispatch.state !== "done"
    && card.dispatch.state !== "failed"
    && typeof card.dispatch.machine === "string";
  if (remoteClaim) {
    const waitMs = Number.isFinite(opts?.remoteCancelWaitMs) && opts.remoteCancelWaitMs > 0
      ? Math.min(30_000, Math.max(250, opts.remoteCancelWaitMs))
      : 12_000;
    const runId = String(card.dispatch.runId || "");
    const requestedAt = new Date().toISOString();
    const existingCancellation = card.dispatch.state === "cancelling" && card.dispatch.cancellation
      ? card.dispatch.cancellation
      : null;
    const deadlineAt = existingCancellation?.deadlineAt || new Date(Date.now() + waitMs).toISOString();
    if (!existingCancellation) {
      const requested = {
        ...card,
        dispatch: {
          ...card.dispatch,
          state: "cancelling",
          detail: "Stop & reroute requested; waiting for the worker to confirm its process group stopped",
          cancellation: { state: "requested", requestedAt, deadlineAt }
        },
        events: withEvent(card, {
          at: requestedAt,
          kind: "interrupt-requested",
          message: `Requested stop of remote run on ${card.dispatch.machine}`,
          detail: "Placement and lease remain locked until the worker acknowledges process termination."
        })
      };
      const saved = await saveCardCASWithHooks(opts.root, requested, card.rev ?? 0, requestedAt);
      if (!saved.ok) return jsonRes(res, 409, { error: "card changed while requesting stop", card: cardSummary(saved.card || card) });
      card = saved.card;
    }

    const deadline = Date.parse(deadlineAt);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      let fresh;
      try { fresh = await loadCard(opts.root, id); }
      catch { return jsonRes(res, 404, { error: `card not found while waiting for cancellation: ${id}` }); }
      if (fresh.dispatch?.runId !== runId) {
        return jsonRes(res, 409, { error: "dispatch claim changed while waiting for cancellation acknowledgement", card: cardSummary(fresh) });
      }
      if (fresh.dispatch?.cancellation?.state === "acknowledged" && fresh.dispatch?.releasedAt) {
        const message = `Stopped remote run on ${fresh.dispatch.machine}; the worker acknowledged process termination and the card is ready to reroute.`;
        return jsonRes(res, 200, {
          ok: true,
          stopped: true,
          acknowledged: true,
          remote: true,
          machine: fresh.dispatch.machine,
          card: cardSummary(fresh),
          message
        });
      }
    }

    // Timeout is a durable, fail-closed state — NOT a lease release. The worker
    // may still acknowledge later, but until it does this card cannot be placed
    // or reclaimed onto another machine.
    let timedOut = await loadCard(opts.root, id).catch(() => card);
    if (timedOut.dispatch?.runId === runId && timedOut.dispatch?.state === "cancelling") {
      const at = new Date().toISOString();
      const next = {
        ...timedOut,
        dispatch: {
          ...timedOut.dispatch,
          cancellation: {
            ...(timedOut.dispatch.cancellation || { requestedAt, deadlineAt }),
            state: "timeout",
            detail: "worker did not acknowledge process termination before the bounded wait expired"
          },
          detail: "Cancellation acknowledgement timed out; lease remains locked"
        }
      };
      const saved = await saveCardCASWithHooks(opts.root, next, timedOut.rev ?? 0, at);
      if (saved.ok) timedOut = saved.card;
    }
    const message = `The worker on ${card.dispatch.machine} did not acknowledge cancellation in ${Math.ceil(waitMs / 1000)}s. Its lease and placement remain locked to prevent overlapping work.`;
    return jsonRes(res, 504, {
      ok: false,
      stopped: false,
      acknowledged: false,
      released: false,
      pending: true,
      remote: true,
      code: "remote-cancel-timeout",
      error: message,
      message,
      card: cardSummary(timedOut)
    });
  }
  if (!opts.gatewayUrl) {
    const message = "No gateway is configured for this board, so there is no runtime turn to stop.";
    return jsonRes(res, 503, {
      code: "gateway-not-configured",
      error: message,
      message
    });
  }

  let result;
  try {
    result = await interruptCardTurn(opts.gatewayUrl, id);
  } catch (err) {
    const message = `Could not reach the gateway to stop this card: ${err?.message || err}`;
    return jsonRes(res, 503, {
      code: "gateway-unreachable",
      error: message,
      message
    });
  }
  if (result.status !== 200) {
    const upstream = result.body && typeof result.body === "object" ? result.body : {};
    const message = upstream.error === "active-turn-belongs-to-another-card"
      ? "This card is marked running but is not the gateway's active turn (it may still be queued). Nothing else was stopped."
      : upstream.error === "no-active-turn"
        ? "The gateway has no active turn for this card. It may have finished already; refresh the board."
        : upstream.error === "lane-has-no-cancel-primitive"
          ? "This card's runtime has not exposed a safe stop primitive yet. Try Panic again once the turn starts producing output."
          : upstream.error === "cancel-primitive-did-not-stop"
            ? "This card's runtime declined the stop request. Nothing was marked interrupted; try again or wait for the turn to settle."
          : "The gateway could not stop this card's active turn.";
    return jsonRes(res, result.status, {
      ...upstream,
      code: upstream.error ?? "interrupt-refused",
      error: message,
      message
    });
  }

  const affectedCardIds = Array.isArray(result.body?.cardIds) ? result.body.cardIds : [id];
  const shared = affectedCardIds.length > 1;
  return jsonRes(res, 200, {
    ok: true,
    stopped: result.body?.stopped !== false,
    lane: result.body?.lane ?? null,
    affectedCardIds,
    sharedBatch: shared,
    message: shared
      ? `Stop sent. This was a shared batch turn, so all ${affectedCardIds.length} cards in it will park in Needs attention; no partial verdict will be used.`
      : "Stop sent. The card will park in Needs attention; no partial verdict will be used."
  });
}

// Host-authoritative completion seam for a pull-based Outpost worker. The
// Next host API has already authenticated the machine and verified the evidence
// manifest; this board-side seam rechecks the durable claim identity and then
// uses advanceCardPhase so remote work cannot bypass gate, evidence,
// coordination, cleanup, or terminal hooks.
async function handleDispatchComplete(req, res, opts, id) {
  if (!isEngineRequest(req)) return jsonRes(res, 403, { error: "engine authentication required" });
  const body = (await readBody(req)) || {};
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  const dispatch = card.dispatch && typeof card.dispatch === "object" ? card.dispatch : null;
  if (!dispatch || dispatch.runId !== body.runId || dispatch.routingToken !== body.routingToken) {
    return jsonRes(res, 409, { error: "dispatch claim identity changed" });
  }
  if (dispatch.releasedAt || dispatch.state === "done" || dispatch.state === "failed") {
    return jsonRes(res, 409, { error: "dispatch claim is no longer active" });
  }
  if (dispatch.phase !== body.phase || card.list !== body.phase) {
    return jsonRes(res, 409, { error: `card phase changed from ${body.phase || "unknown"} to ${card.list}` });
  }
  if (!Number.isInteger(dispatch.claimRevision)
      || !Number.isInteger(body.rev)
      || body.rev !== dispatch.claimRevision
      || body.rev !== (card.rev ?? 0)) {
    return jsonRes(res, 409, { error: "card revision changed", card: cardSummary(card) });
  }
  if (typeof body.verdict !== "string" || !body.verdict.trim()) {
    return jsonRes(res, 400, { error: "verdict is required" });
  }
  const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 2000) : "completed on outpost";
  const evidenceRunKey = createHash("sha256").update(String(body.runId)).digest("hex").slice(0, 32);
  const completed = {
    ...card,
    // Absolute and host-owned. The evidence endpoint writes the phase sidecar
    // and tangible evidence here before this request is accepted.
    runDir: path.join(opts.root, "cards", id, "dispatch", "runs", evidenceRunKey),
    lastReply: summary || card.lastReply || null,
    dispatch: {
      ...dispatch,
      state: "done",
      heartbeatAt: new Date().toISOString(),
      detail: summary || "completed on outpost",
      requestedTransition: body.verdict,
      ...(typeof body.sessionId === "string" && body.sessionId ? { sessionId: body.sessionId } : {}),
      logCursor: Number.isSafeInteger(body.logCursor) ? body.logCursor : 0,
      evidenceManifest: Array.isArray(body.evidenceManifest) ? body.evidenceManifest : []
    },
    dispatchRuns: appendDispatchRunProvenance(card, {
      runId: body.runId,
      machine: dispatch.machine,
      workerId: dispatch.workerId,
      phase: body.phase,
      state: "done",
      claimedAt: dispatch.claimedAt,
      completedAt: new Date().toISOString(),
      logIndex: dispatch.logIndex,
      sessionId: body.sessionId,
      logCursor: body.logCursor,
      evidenceManifest: body.evidenceManifest
    })
  };
  const result = await advanceCardPhase({
    root: opts.root,
    board: await loadBoard(opts.root),
    card: completed,
    verdict: body.verdict.trim(),
    cwd: opts.cwd,
    onDutyBoundary: opts.gatewayUrl ? compactBoundaryFn(opts.gatewayUrl) : undefined
  });
  if (result?.outcome?.status !== "moved") {
    return jsonRes(res, 422, {
      error: `remote phase was not advanced: ${result?.outcome?.reason || result?.outcome?.status || "unknown"}`,
      outcome: result?.outcome || null,
      card: result?.card ? cardSummary(result.card) : cardSummary(card)
    });
  }
  return jsonRes(res, 200, {
    ok: true,
    advanced: result.outcome.to,
    outcome: result.outcome,
    card: cardSummary(result.card)
  });
}

async function handleDispatchCancelAck(req, res, opts, id) {
  if (!isEngineRequest(req)) return jsonRes(res, 403, { error: "engine authentication required" });
  const body = (await readBody(req)) || {};
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  const dispatch = card.dispatch && typeof card.dispatch === "object" ? card.dispatch : null;
  const owned = dispatch
    && dispatch.machine === body.machine
    && dispatch.workerId === body.workerId
    && dispatch.runId === body.runId
    && dispatch.routingToken === body.routingToken;
  if (!owned || dispatch.state !== "cancelling" || !dispatch.cancellation) {
    return jsonRes(res, 409, { error: "dispatch cancellation identity changed or is no longer pending" });
  }
  if (body.stopped !== true) return jsonRes(res, 400, { error: "stopped:true acknowledgement is required" });
  if (!Number.isInteger(body.rev) || body.rev !== (card.rev ?? 0)) {
    return jsonRes(res, 409, { error: "card revision changed while acknowledging cancellation", card: cardSummary(card) });
  }
  const at = new Date().toISOString();
  const phase = dispatch.phase || card.list;
  const evidenceRunKey = createHash("sha256").update(String(dispatch.runId || "")).digest("hex").slice(0, 32);
  const summary = typeof body.summary === "string" && body.summary.trim()
    ? body.summary.trim().slice(0, 1000)
    : "remote process group stopped";
  const next = {
    ...card,
    list: ATTENTION_LIST,
    status: "needs-attention",
    runningSince: null,
    ...(dispatch.runId ? { runDir: path.join(opts.root, "cards", id, "dispatch", "runs", evidenceRunKey) } : {}),
    parkedFrom: phase,
    retryKeepsContext: true,
    attentionKind: "interrupted",
    attentionReason: `Stopped remote run on ${dispatch.machine}; process termination was acknowledged and partial evidence was retained.`,
    dispatch: {
      ...dispatch,
      state: "failed",
      releasedAt: at,
      heartbeatAt: at,
      detail: "stopped by user; choose a placement and retry",
      logCursor: Number.isSafeInteger(body.logCursor) ? body.logCursor : 0,
      evidenceManifest: Array.isArray(body.evidenceManifest) ? body.evidenceManifest : [],
      cancellation: {
        ...dispatch.cancellation,
        state: "acknowledged",
        acknowledgedAt: at,
        detail: summary
      }
    },
    dispatchRuns: appendDispatchRunProvenance(card, {
      runId: dispatch.runId,
      machine: dispatch.machine,
      workerId: dispatch.workerId,
      phase,
      state: "cancelled",
      claimedAt: dispatch.claimedAt,
      completedAt: at,
      logIndex: dispatch.logIndex,
      logCursor: body.logCursor,
      evidenceManifest: body.evidenceManifest
    }),
    events: withEvent(card, {
      at,
      kind: "interrupted",
      message: `Stopped remote run on ${dispatch.machine}`,
      detail: "Worker acknowledged process termination; lease released for rerouting."
    })
  };
  const saved = await saveCardCASWithHooks(opts.root, next, card.rev ?? 0, at);
  if (!saved.ok) return jsonRes(res, 409, { error: "card changed while acknowledging cancellation", card: cardSummary(saved.card || card) });
  return jsonRes(res, 200, { ok: true, stopped: true, acknowledged: true, card: cardSummary(saved.card) });
}

// Dispatch goes through the shared, transport-aware gateway client (lib/gateway-client.mjs)
// so the board + the scheduler tick use one wire shape + one failure classification (a
// transient gateway failure must REVERT a card, not park it).

// GET /cards/:id/watch — SSE. For a LIVE run (card.status === "running") it tails
// the latest monotonic log-N.md as it grows; otherwise it sends the linked
// static logs once and closes. There is NO tmux attach — the pooled gateway
// operative is raw node-pty (v4 wireframe §4 + the board-ui non-negotiable):
// Watch is the card's log via SSE for a live run, the web chat for an
// interactive list (the UI opens that), or the linked static logs when nothing
// is live.
async function handleWatchCard(req, res, opts, id) {
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const latestN = latestCardLogNumber(root, card);
  const activeRemoteLog = card.status === "running"
    && card.dispatch
    && (card.dispatch.state === "claimed" || card.dispatch.state === "running")
    && Number.isInteger(card.dispatch.logIndex)
    && card.dispatch.logIndex > 0
      ? card.dispatch.logIndex
      : null;
  // A losing claim reservation can leave a higher empty log-N. For an active
  // remote claim, its durable dispatch.logIndex is authoritative; max(filename)
  // is only the historical/static fallback.
  const n = activeRemoteLog ?? latestN;
  const live = card.status === "running" && n > 0;
  const logFile = path.join(root, "cards", id, `log-${n}.md`);

  if (!live) {
    // Nothing running: replay every linked static log, then close. (link-never-
    // duplicate: these are the card's own log-N.md files, read in place.)
    send("mode", { live: false, status: card.status ?? "ok" });
    for (let i = 1; i <= latestN; i++) {
      const f = path.join(root, "cards", id, `log-${i}.md`);
      if (isReadableFile(f)) {
        const text = await readFile(f, "utf8").catch(() => "");
        send("log", { n: i, text });
      }
    }
    send("end", { reason: "no-live-run" });
    return res.end();
  }

  // Live: the engine OVERWRITES log-<n>.md with the operative's growing reply as
  // chunks stream in (atomic temp+rename), so we re-read the whole file each poll and
  // send the full current text with replace:true — the UI replaces its pane. (Offset
  // tailing would break on an overwrite that re-flows or shrinks.)
  send("mode", { live: true, status: "running", n });
  let lastSent = null;
  const pump = async () => {
    if (isReadableFile(logFile)) {
      try {
        const text = await readFile(logFile, "utf8");
        if (text !== lastSent) {
          send("log", { n, text, replace: true });
          lastSent = text;
        }
      } catch {}
    }
    // Stop tailing once the card is no longer running (the engine moved/parked it).
    try {
      const fresh = await loadCard(root, id);
      if (fresh.status !== "running") {
        send("end", { reason: "run-finished", status: fresh.status, list: fresh.list });
        cleanup();
        return res.end();
      }
    } catch {}
  };
  await pump();
  const timer = setInterval(pump, 1000);
  const cleanup = () => clearInterval(timer);
  req.on("close", cleanup);
}

// GET /operative/screen - SSE proxy of the gateway's /screen/stream (the
// operative PTY's rendered terminal). The board UI stays same-origin; a
// gateway that is down or has no live session surfaces as mode {live:false}
// rather than an error, so the Watch sheet can say so calmly.
async function handleOperativeScreen(req, res, opts) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  if (!opts.gatewayUrl) {
    send("mode", { live: false, reason: "no gateway configured" });
    return res.end();
  }
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  let upstream;
  try {
    upstream = await fetch(`${opts.gatewayUrl}/screen/stream`, { signal: abort.signal });
  } catch {
    send("mode", { live: false, reason: "gateway unreachable" });
    return res.end();
  }
  if (!upstream.ok || !upstream.body) {
    send("mode", { live: false, reason: `gateway ${upstream.status}` });
    return res.end();
  }
  try {
    // Pipe the SSE bytes through verbatim - the gateway already speaks the
    // event framing the board's EventSource expects.
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch {
    /* upstream ended or client left */
  }
  try { res.end(); } catch {}
}

// GET /cards/:id/session-stream?i=<n>|live=1[&task=<public-id>] — the
// @garrison/claude-chat SessionStream contract. `live=1` resolves the current
// generation's ephemeral journal pointer, which exists before card.sessionIds can
// be committed; numbered sessions resolve the durable pointers after completion.
// Default-message SSE frames are {type:init|events|end}, exactly like Web Channel.
// Find <sessionId>.jsonl by globbing every ~/.claude/projects/* dir. Session ids
// are globally unique, so this sidesteps the cwd-encoding of claudeProjectDirForCwd:
// the operative journals its transcript under ITS OWN cwd (the composition dir for
// the default agent-sdk operative), which needn't match the board's projectRoot().
// Without this, the rich Log's resolveArtifactRef("session:i") missed and the UI
// always fell back to Raw in the default composition.
function findTranscriptBySession(sessionId) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) return null;
  const root = claudeProjectsDir();
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function subagentsDirFor(parentTranscript) {
  return parentTranscript.endsWith(".jsonl")
    ? path.join(path.dirname(parentTranscript), path.basename(parentTranscript, ".jsonl"), "subagents")
    : null;
}

function confinedSubagentTranscript(parentTranscript, agentId) {
  const safe = typeof agentId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(agentId) ? agentId : null;
  const root = subagentsDirFor(parentTranscript);
  if (!safe || !root) return null;
  const candidate = confinePath(path.join(root, `agent-${safe}.jsonl`), [root]);
  return candidate && isReadableFile(candidate) ? candidate : null;
}

function relatedTaskStreamUrl(parentTranscript, baseQuery, task) {
  if (!confinedSubagentTranscript(parentTranscript, task?.agentId)) return null;
  return `/cards/${encodeURIComponent(baseQuery.cardId)}/session-stream?${baseQuery.selector}&task=${encodeURIComponent(task.taskId)}`;
}

function findRelatedTaskTranscript(parentTranscript, publicTaskId) {
  if (typeof publicTaskId !== "string" || !/^task-[A-Za-z0-9_-]{1,133}$/.test(publicTaskId)) return null;
  const root = subagentsDirFor(parentTranscript);
  const journals = [parentTranscript];
  if (root) {
    let names = [];
    try { names = readdirSync(root); } catch { /* no children */ }
    for (const name of names) {
      if (!/^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(name)) continue;
      const confined = confinePath(path.join(root, name), [root]);
      if (confined && isReadableFile(confined)) journals.push(confined);
    }
  }
  for (const journal of journals) {
    let lines = [];
    try { lines = readFileSync(journal, "utf8").split("\n").filter((line) => line.trim()); } catch { continue; }
    const task = extractRelatedTaskRecords(lines).find((candidate) => candidate.taskId === publicTaskId);
    if (!task?.agentId) continue;
    const child = confinedSubagentTranscript(parentTranscript, task.agentId);
    if (child) return child;
  }
  return null;
}

async function handleSessionStream(req, res, opts, id, i) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin session read rejected" });
  const query = url.parse(req.url || "", true).query;
  const wantsLive = query.live === "1";
  const requestedRemoteRunId = typeof query.run === "string" && query.run.trim()
    ? query.run.trim()
    : null;
  const publicTaskId = typeof query.task === "string" ? query.task : null;
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — the session ref must not trust a tampered on-disk id

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => { closed = true; });
  const emit = (payload) => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { closed = true; }
  };
  // A 15s keep-alive comment keeps intermediaries from dropping an idle stream.
  const keepAlive = setInterval(() => {
    if (closed) return;
    try { res.write(": keep-alive\n\n"); } catch { closed = true; }
  }, 15_000);
  keepAlive.unref?.();

  const finish = () => {
    clearInterval(keepAlive);
    emit({ type: "end" });
    try { res.end(); } catch { /* already closed */ }
  };

  // Remote Agent SDK output already arrives as ordered, immutable dispatch
  // events. Adapt those events to the SAME default-message SessionStream wire
  // contract Web Channel renders, so Watch opens on a live rich Log instead of
  // an empty session tab that forces the user over to Raw.
  const currentRemoteDispatch = card.dispatch
    && typeof card.dispatch === "object"
    && typeof card.dispatch.runId === "string"
    ? card.dispatch
    : null;
  const durableRemoteRuns = Array.isArray(card.dispatchRuns) ? card.dispatchRuns : [];
  const remoteDispatch = requestedRemoteRunId
    ? durableRemoteRuns.find((run) => run?.runId === requestedRemoteRunId)
      || (currentRemoteDispatch?.runId === requestedRemoteRunId ? currentRemoteDispatch : null)
    : wantsLive
      ? currentRemoteDispatch
      : null;
  if (remoteDispatch) {
    const remoteLive = currentRemoteDispatch?.runId === remoteDispatch.runId
      && card.status === "running"
      && ["claimed", "running", "cancelling"].includes(currentRemoteDispatch.state);
    const key = createHash("sha256").update(remoteDispatch.runId).digest("hex").slice(0, 32);
    const dir = path.join(opts.root, "cards", id, "dispatch", "streams", key);
    let lastEncoded = null;
    const readRemoteEvents = () => {
      let names = [];
      try { names = readdirSync(dir).filter((name) => /^\d{10}\.json$/.test(name)).sort(); } catch {}
      const items = [];
      for (const name of names) {
        try {
          const item = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
          if (typeof item.text !== "string") continue;
          items.push(item);
        } catch {}
      }
      const hasJournal = items.some((item) => item.channel === "journal");
      const events = [];
      for (const item of items) {
        const eventId = Number.isSafeInteger(Number(item.eventId)) ? Number(item.eventId) : events.length + 1;
        const at = Date.parse(item.at || "");
        const id = `outpost-${remoteDispatch.runId}-${eventId}`;
        if (item.channel === "journal") {
          let journal;
          try { journal = JSON.parse(item.text); } catch { continue; }
          if (!journal || !Array.isArray(journal.blocks)) continue;
          const blocks = journal.blocks.map((block) => {
            if (!block || typeof block !== "object") return null;
            if (block.type === "text" || block.type === "thinking") {
              return { type: block.type, text: typeof block.text === "string" ? block.text.slice(0, 20_000) : "" };
            }
            if (block.type === "tool_use") {
              return {
                type: "tool_use",
                toolUseId: typeof block.toolUseId === "string" ? block.toolUseId.slice(0, 160) : null,
                name: typeof block.name === "string" ? block.name.slice(0, 160) : "tool",
                input: typeof block.input === "string" ? block.input.slice(0, 20_000) : ""
              };
            }
            if (block.type === "tool_result") {
              const images = Array.isArray(block.images) ? block.images.flatMap((image) => {
                const mediaType = typeof image?.mediaType === "string" ? image.mediaType : "";
                const data = typeof image?.data === "string" ? image.data : "";
                return /^(image\/(png|jpeg|webp|gif))$/.test(mediaType) && /^[A-Za-z0-9+/=\r\n]+$/.test(data)
                  ? [{ mediaType, data }]
                  : [];
              }) : [];
              return {
                type: "tool_result",
                toolUseId: typeof block.toolUseId === "string" ? block.toolUseId.slice(0, 160) : null,
                isError: block.isError === true,
                text: typeof block.text === "string" ? block.text.slice(0, 20_000) : "",
                images
              };
            }
            return null;
          }).filter(Boolean);
          if (!blocks.length) continue;
          events.push({
            id,
            role: journal.role === "user" ? "user" : "assistant",
            ts: Number.isFinite(at) ? at : null,
            ...(blocks.every((block) => block.type === "tool_result") ? { toolResultsOnly: true } : {}),
            blocks
          });
          continue;
        }
        // Agent stdout duplicates assistant text already carried in the rich
        // journal. Keep it as the Raw log, but avoid doubling it in Log.
        if (hasJournal && item.channel === "stdout") {
          // Replace a stdout fallback that may have been emitted before the
          // first journal row arrived; mergeSessionEvents is id-based.
          events.push({ id, role: "assistant", ts: Number.isFinite(at) ? at : null, blocks: [{ type: "text", text: "" }] });
          continue;
        }
        const prefix = item.channel === "stderr" ? "[stderr] " : item.channel === "status" ? "[status] " : "";
        events.push({
          id,
          role: "assistant",
          ts: Number.isFinite(at) ? at : null,
          blocks: [{ type: "text", text: prefix + item.text }]
        });
      }
      return events;
    };
    const initial = readRemoteEvents();
    emit({
      type: "init",
      title: `Outpost · ${remoteDispatch.machine || "remote"}`,
      events: initial,
      live: remoteLive,
      available: true
    });
    lastEncoded = JSON.stringify(initial);
    if (!remoteLive) return finish();
    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (closed) break;
      const event = readRemoteEvents();
      const encoded = JSON.stringify(event);
      if (encoded !== lastEncoded) {
        emit({ type: "events", events: event });
        lastEncoded = encoded;
      }
      try {
        const fresh = await loadCard(opts.root, id);
        if (fresh.status !== "running" || fresh.dispatch?.runId !== remoteDispatch.runId) break;
      } catch { break; }
    }
    return finish();
  }

  const pointer = wantsLive ? await readLiveSessionPointer(opts.root, card) : null;
  const durableIds = Array.isArray(card.sessionIds) ? card.sessionIds : [];
  const durableIndex = Number.isInteger(i) && i >= 0 ? i : -1;
  // If the UI raced the final card commit, `live=1` gracefully falls back to the
  // latest durable session rather than turning a just-finished journal invisible.
  const sessionId = pointer?.sessionId ?? (wantsLive ? durableIds.at(-1) : durableIds[durableIndex]) ?? null;
  let absPath = pointer?.transcriptPath ?? null;
  if (!absPath && !wantsLive && durableIndex >= 0) {
    absPath = resolveArtifactRef(card, `session:${durableIndex}`, { root: opts.root, cwd: opts.cwd });
  }
  if (!absPath || !isReadableFile(absPath)) absPath = findTranscriptBySession(sessionId);
  const parent = absPath ? confinePath(absPath, allowedRoots(opts.cwd, opts.root)) : null;
  const confined = parent && publicTaskId ? findRelatedTaskTranscript(parent, publicTaskId) : parent;
  if (!confined || !isReadableFile(confined)) {
    emit({ type: "init", title: null, available: false, live: false, events: [] });
    return finish();
  }

  try {
    let read = await readJsonlLines(confined, 0);
    let offset = read.offset;
    let journalLines = read.lines.slice();
    const parsed = parseTranscriptLines(read.lines);
    const baseQuery = { cardId: id, selector: wantsLive ? "live=1" : `i=${durableIndex}` };
    const safeRelated = () => parent
      ? relatedTaskEvents(journalLines, {
          streamUrlFor: (task) => relatedTaskStreamUrl(parent, baseQuery, task)
        })
      : [];
    const related = safeRelated();
    let relatedById = new Map(related.map((event) => [event.id, JSON.stringify(event)]));
    const liveGeneration = pointer?.runSeq ?? null;
    const streamLive = Boolean(wantsLive && pointer && card.status === "running");
    emit({
      type: "init",
      title: parsed.title,
      events: [...parsed.events, ...related],
      live: streamLive,
      available: true
    });
    while (!closed && streamLive && card.status === "running" && card.runSeq === liveGeneration) {
      await new Promise((r) => setTimeout(r, 800));
      if (closed) break;
      try {
        read = await readJsonlLines(confined, offset);
        if (read.lines.length) {
          offset = read.offset;
          journalLines.push(...read.lines);
          const chunk = parseTranscriptLines(read.lines);
          const nextRelated = new Map();
          const changedRelated = [];
          for (const event of safeRelated()) {
            const encoded = JSON.stringify(event);
            nextRelated.set(event.id, encoded);
            if (relatedById.get(event.id) !== encoded) changedRelated.push(event);
          }
          relatedById = nextRelated;
          if (chunk.events.length || changedRelated.length || chunk.title) {
            emit({ type: "events", title: chunk.title, events: [...chunk.events, ...changedRelated] });
          }
        }
      } catch { /* transient read failure — keep polling */ }
      try { card = await loadCard(opts.root, id); card.id = id; }
      catch { break; }
    }
  } catch { /* fall through to end */ }
  finish();
}

// GET /cards/:id/attachment?i=<n> — read-only serve of a file the user attached
// through ClaudeChat (parsed out of the card description, issue #2). Its OWN
// narrow confine set (uploadsDir only) — NEVER the wider artifact allowedRoots.
async function handleAttachment(req, res, opts, id, i) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin attachment read rejected" });
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  const idx = Number(i);
  const a = parseAttachments(card.description)[Number.isInteger(idx) ? idx : -1];
  if (!a) return jsonRes(res, 404, { error: "no such attachment" });
  const confined = confinePath(a.path, [uploadsDir()]);
  if (!confined) return jsonRes(res, 403, { error: "attachment outside the uploads dir" });
  if (!isReadableFile(confined)) return jsonRes(res, 404, { error: "not a readable file" });
  return serveConfinedFile(res, confined);
}

// GET /host-map — the localPort → HTTPS tailnet URL map (from `tailscale serve
// status`), so the board UI can rewrite loopback URLs baked into card bodies to
// a form the remote client can actually reach (ui/host-rewrite.ts). Empty map
// when tailscale isn't installed / nothing is serve-mapped.
async function handleHostMap(req, res) {
  let map = {};
  try { map = Object.fromEntries(await getTailnetServeMap()); } catch { map = {}; }
  jsonRes(res, 200, { map });
}

// GET /file?path=<abs> — read-only serve of an absolute file path surfaced in a
// card body (a run artifact or an uploaded attachment linkified in the UI).
// Confined by realpath to the artifact allowed roots PLUS the uploads dir; a
// `..` / symlink escape or an unreadable/sensitive file is refused.
async function handleFile(req, res, opts, query) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin file read rejected" });
  const raw = typeof query?.path === "string" ? query.path : "";
  if (!raw || !path.isAbsolute(raw) || raw.includes("\0")) return jsonRes(res, 400, { error: "absolute path required" });
  // Reject a lexical `..` outright before realpath (defense in depth; confinePath
  // re-checks the canonical path too).
  if (raw.split("/").includes("..")) return jsonRes(res, 403, { error: "path traversal rejected" });
  const roots = [...allowedRoots(opts.cwd, opts.root), uploadsDir()];
  const confined = confinePath(raw, roots);
  if (!confined) return jsonRes(res, 403, { error: "path outside allowed roots" });
  if (!isReadableFile(confined)) return jsonRes(res, 404, { error: "not a readable file" });
  // Refuse obviously-sensitive names even inside a root (dotfiles carrying creds).
  const base = path.basename(confined);
  if (/^\.(env|git|npmrc|netrc)$/i.test(base) || base === ".env") {
    return jsonRes(res, 403, { error: "refusing to serve a sensitive file" });
  }
  return serveConfinedFile(res, confined);
}

// GET /cards/:id/artifact?ref=<refToken> — read-only serve of a card's linked
// artifact (plan / gate markers / brief / transcript / log). The client names a
// card id + an OPAQUE ref token; the server re-derives the absolute path from the
// card's OWN stored pointers (resolveArtifactRef) — it NEVER accepts a client path
// — then confines (realpath) + requires a readable regular file. Same-origin only
// (the board is served + fetched on this port); a cross-origin read is rejected.
// This is the link-never-duplicate read side: one source per artifact, in place.
async function handleArtifact(req, res, opts, cardId, ref) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin artifact read rejected" });
  if (!ref) return jsonRes(res, 400, { error: "ref required" });
  let card;
  try { card = await loadCard(opts.root, cardId); }
  catch { return jsonRes(res, 404, { error: "no such card" }); }
  card.id = cardId; // pin to the validated route id — the log: ref must not trust a tampered on-disk id
  const absPath = resolveArtifactRef(card, ref, { root: opts.root, cwd: opts.cwd });
  if (!absPath) return jsonRes(res, 400, { error: "unknown or out-of-range artifact ref" });
  const confined = confinePath(absPath, allowedRoots(opts.cwd, opts.root));
  if (!confined) return jsonRes(res, 403, { error: "path outside allowed roots" });
  if (!isReadableFile(confined)) return jsonRes(res, 404, { error: "not a readable file" });
  // WS2 (WS5 evidence dependency): append the fetch to the card's append-only fetch
  // log. Fire-and-forget — a log-write failure must never affect the artifact serve.
  void appendFile(
    path.join(opts.root, "cards", cardId, "fetch-log.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ref, ua: req.headers?.["user-agent"] || null }) + "\n"
  ).catch(() => {});
  return serveConfinedFile(res, confined);
}

// Serve an already-confined, readable regular file with the board's defense-in-
// depth headers (nosniff + a `sandbox` CSP, so a served artifact/upload navigated
// to as a document can neither script nor reach the network), and SVG/unknown
// types delivered inert (attachment). The confinement decision belongs to the
// CALLER — this only writes bytes + headers for a path already proven safe.
// Factored out of handleArtifact so handleAttachment / handleFile reuse it.
export function serveConfinedFile(res, confined) {
  const ext = path.extname(confined).toLowerCase();
  const ct = {
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  res.statusCode = 200;
  // Defense-in-depth for served files (evidence + uploads are "whatever the operative
  // wrote / the user attached", and the operative processes untrusted repos/pages — so
  // treat them as untrusted content): never let the browser sniff a different type, and
  // fully sandbox the response if it is ever navigated to as a document (no script,
  // no network).
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cache-Control", "no-store");
  // An SVG can carry <script>/onload; serving it as a navigable image/svg+xml document on
  // the board origin would be stored-XSS. Serve it (and any unknown/active type) as an
  // inert download — text for svg so it's readable, attachment so a top-level click can
  // never execute it as a document.
  if (ext === ".svg") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment");
  } else {
    res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
    if (!ct[ext]) res.setHeader("Content-Disposition", "attachment");
  }
  createReadStream(confined).pipe(res);
}

// Which artifact refs are EDITABLE (text the user authored/owns): the card-owned brief,
// the plan, and the per-card iteration logs. Machine-generated JSON (gate markers,
// evidence index), evidence files, session transcripts, and the video stay read-only.
function isEditableArtifactRef(ref) {
  return ref === "brief" || ref === "plan" || /^log:\d+$/.test(ref);
}

// PUT /cards/:id/artifact?ref=<ref> — write an editable text artifact. Confined to the
// SAME allowed roots as the read side; only .md/.txt editable refs are accepted. Writing
// the brief also marks it on the card (a pointer) so the link + build pick it up.
async function handleArtifactWrite(req, res, opts, cardId, ref) {
  if (typeof ref !== "string" || !isEditableArtifactRef(ref)) {
    return jsonRes(res, 400, { error: "this artifact is not editable" });
  }
  let card;
  try { card = await loadCard(opts.root, cardId); }
  catch { return jsonRes(res, 404, { error: "no such card" }); }
  card.id = cardId;
  // D16: editing an engine-owned card's plan/brief/log mid-run is a manual edit
  // — rejected like PATCH (rev-s4 finding #4). Start/Infer stay human-usable by
  // design (they delegate to the engine); artifact WRITES change run inputs.
  const boardForLock = await loadBoard(opts.root);
  if (isEngineOwned(boardForLock, card) && !isEngineRequest(req)) {
    return jsonRes(res, 403, {
      error: "engine-owned",
      message: `Card is on the autonomous list "${card.list}" — its run inputs are engine-owned (D16). Edit from needs-attention if it parks.`
    });
  }
  const absPath = resolveArtifactRef(card, ref, { root: opts.root, cwd: opts.cwd });
  if (!absPath) return jsonRes(res, 400, { error: "unknown or out-of-range artifact ref" });
  const confined = confinePath(absPath, allowedRoots(opts.cwd, opts.root));
  if (!confined) return jsonRes(res, 403, { error: "path outside allowed roots" });
  const ext = path.extname(confined).toLowerCase();
  if (ext !== ".md" && ext !== ".txt") return jsonRes(res, 400, { error: "only .md/.txt artifacts are editable" });
  const body = (await readBody(req)) || {};
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > 512 * 1024) return jsonRes(res, 413, { error: "artifact too large (512 KB cap)" });
  try {
    await mkdir(path.dirname(confined), { recursive: true });
    await writeFile(confined, content, "utf8");
    if (ref === "brief" && !card.briefPath) {
      try { await saveCardCAS(opts.root, { ...card, briefPath: cardBriefRel(cardId) }, card.rev ?? 0); } catch { /* best-effort marker */ }
    }
    jsonRes(res, 200, { ok: true, ref });
  } catch (err) {
    jsonRes(res, 500, { error: err.message });
  }
}

// GET /lists — the list defs (config) for the list-config UI. Same shape the
// board view already exposes per list (skill / trigger / prompts / validNext /
// mode / taskType / tier / kind / interactive), but without the cards, so the
// config surface can read + edit the lists without a board round-trip. The full
// prompts are included here (the board view omits the execute/router prompt
// bodies) because the editor needs them.
async function handleGetLists(req, res, opts) {
  const board = await loadBoard(opts.root);
  const boardRev = Number.isInteger(board.rev) ? board.rev : 0;
  const lists = (board.lists || [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((l) => ({
      id: l.id,
      title: l.title,
      order: l.order ?? 0,
      kind: l.kind || "manual",
      trigger: triggerFor(l),
      beatCron: l.beatCron ?? null,
      interactive: Boolean(isInteractive(l)),
      terminal: Boolean(l.terminal),
      system: Boolean(l.system),
      // D15: a list maps to a phase name and nothing else; skill/taskType/
      // tier/mode resolve from the compiled Orchestrator policy.
      phase: l.phase ?? (l.kind === "agent" ? l.id : null),
      executePrompt: l.executePrompt ?? "",
      routerPrompt: l.routerPrompt ?? "",
      validNext: Array.isArray(l.validNext) ? l.validNext : []
    }));
  jsonRes(res, 200, { version: board.version ?? 2, rev: boardRev, lists });
}

// PATCH /lists/:listId — configure a list. originAllowed guard (same as the
// other mutating routes), then read-fresh loadBoard → applyListConfig (pure
// validate + update) → on error 400 → saveBoard (atomic temp+rename) → return
// the updated list. The list id is validated by the router before this runs; a
// bad patch (unknown list, bad trigger, validNext to a non-existent list,
// newline/traversal in a field, or an agent-only field on a manual list) is a
// 400 with the validator's message.
async function handlePatchList(req, res, opts, listId) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin list config rejected" });
  if (listId === "scheduled") return jsonRes(res, 400, { error: "Scheduled is a fixed system column and cannot be configured" });
  const body = (await readBody(req)) || {};
  // `rev` is the optimistic-concurrency token, NOT a list field — split it out
  // before applyListConfig (which would reject an unknown field on a manual list).
  const { rev: clientRev, ...patch } = body;
  // True board-level CAS: saveBoardCAS runs the read→check-rev→apply→write inside an
  // exclusive board lock, so two concurrent edits can't both read the same rev and
  // both save (the lost-update race a bare load+check+save leaves open). The pure
  // applyListConfig validates + mutates the FRESH board the lock just read. A client
  // that omits rev opts out of the conflict check (e.g. a script); the UI sends it.
  const expectedRev = Number.isInteger(clientRev) ? clientRev : undefined;
  const result = await saveBoardCAS(opts.root, expectedRev, (board) => applyListConfig(board, listId, patch));
  if (result.conflict) return jsonRes(res, 409, { error: "board changed under you — reload the list config", rev: result.rev });
  if (result.error) return jsonRes(res, 400, { error: result.error });
  // If the trigger or schedule changed, (re)register or remove this list's scheduler
  // beat NOW so a UI edit takes effect immediately — not only at the next --setup.
  // Fire-and-forget (spawnSync inside): the save already succeeded; don't block the
  // response on the scheduler CLI.
  if ("trigger" in patch || "beatCron" in patch) {
    void syncListBeat(result.list).catch((err) =>
      console.error(`[kanban-loop] beat sync for ${listId} failed:`, err?.message || err));
  }
  jsonRes(res, 200, { list: result.list, rev: result.rev });
}

// GET /projects — the git repos under the dev-root (dev-env parity), for the New Card
// project picker, plus the board's explicit label→path mappings. Returns
// { devRoot, projects:[{name,path}], mapped:{label:{path}} }. Read-only + best-effort:
// a missing dev-root just yields an empty list (the UI still offers a custom path).
async function handleProjects(req, res, opts) {
  const devRoot = readDevRoot();
  let projects = [];
  try { projects = listProjects(devRoot); } catch { projects = []; }
  let mapped = {};
  try { mapped = (await loadBoard(opts.root))?.projects || {}; } catch { mapped = {}; }
  jsonRes(res, 200, { devRoot, projects, mapped });
}

// The pure half of the mapping write: set (path string) or remove (null) one
// label in board.projects, never touching anything else on the board. Exported
// for tests, exactly like applyListConfig.
export function applyProjectMapping(board, label, targetOrNull) {
  const projects = { ...(board?.projects || {}) };
  if (targetOrNull === null) delete projects[label];
  else projects[label] = { ...(projects[label] || {}), path: targetOrNull };
  return { ...board, projects };
}

// The label discipline for a mapping key: a path-ish label is already handled
// by repoPathForProject's absolute-path branch and must not become a key.
export function isValidProjectLabel(label) {
  return typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label.trim()) && label.trim() === label;
}

// PUT /projects/:label — the ONE writer for board.projects, the explicit
// label→repo-path map that repoPathForProject consults FIRST. Until this
// existed the map had readers and no writer, so it was empty on every box and
// any card whose project label differed from its dev-root DIRECTORY name
// (agent-garrison vs garrison) ran unfenced with no revert target (F7).
// Body {path: "/abs/repo"} sets the mapping; {path: null} removes it. The path
// must exist on THIS machine — a mapping to nowhere would turn every fence into
// a git error instead of an honest skip. rev is the usual optional CAS token.
async function handlePutProjectMapping(req, res, opts, label) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin project mapping rejected" });
  const name = String(label || "").trim();
  // Same character discipline as project labels elsewhere: a path-ish label is
  // already handled by repoPathForProject's absolute-path branch and must not
  // become a mapping key.
  if (!isValidProjectLabel(name)) {
    return jsonRes(res, 400, { error: "invalid project label" });
  }
  const body = (await readBody(req)) || {};
  const { rev: clientRev, path: rawPath } = body;
  const remove = rawPath === null;
  let target = null;
  if (!remove) {
    target = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!target || !path.isAbsolute(target)) return jsonRes(res, 400, { error: "path must be an absolute path (or null to remove)" });
    if (!existsSync(target)) return jsonRes(res, 400, { error: `path does not exist on this machine: ${target}` });
    target = path.resolve(target);
  }
  const expectedRev = Number.isInteger(clientRev) ? clientRev : undefined;
  // saveBoardCAS's mutator contract is {board, list?, error?} - the pure helper
  // returns the next board, so wrap it (returning the board bare leaves
  // result.board undefined and the rev stamp throws).
  const result = await saveBoardCAS(opts.root, expectedRev, (board) => ({
    board: applyProjectMapping(board, name, remove ? null : target)
  }));
  if (result.conflict) return jsonRes(res, 409, { error: "board changed under you — retry the mapping", rev: result.rev });
  if (result.error) return jsonRes(res, 400, { error: result.error });
  jsonRes(res, 200, { label: name, path: target, removed: remove, rev: result.rev });
}

// A remote project card is not placeable until the host can prove its Loadout
// is complete and every declared vault name resolves.  The authoring seed is
// deliberately conservative: Git supplies only facts it already knows (the
// origin URL and origin/HEAD).  Setup, verification and env-var names stay
// blank rather than being guessed from package files or copied from a shell.
function gitFact(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

export function projectLoadoutPrefill(projectId, { devRoot = readDevRoot() } = {}) {
  const repo = resolveProjectName(projectId, { devRoot });
  if (!repo) return null;
  const repoRemote = gitFact(repo, ["remote", "get-url", "origin"]);
  const remoteHead = gitFact(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : "";
  return {
    id: projectId,
    repo_remote: repoRemote,
    default_branch: defaultBranch,
    setup_commands: [],
    env_vars: [],
    verify_command: ""
  };
}

function loadoutAppUrl(opts) {
  return String(opts?.appUrl || process.env.GARRISON_APP_URL || "").trim().replace(/\/+$/, "");
}

// Placement is a security/execution boundary, so the browser's readiness UI is
// advisory only. Recheck the worker pulse and the host-side Loadout/vault dry
// run on every create or placement PATCH before persisting a remote target.
export async function remotePlacementPreflight(input, opts = {}) {
  const placement = normalisePlacement(input?.placement);
  if (placement.target === "host") return { ok: true, status: 200, code: "ready", detail: "host placement" };

  const isCommand = typeof input?.dispatchCommand === "string" && input.dispatchCommand.trim().length > 0;
  const project = typeof input?.project === "string" && input.project.trim() ? input.project.trim() : null;
  const personalWorkspace = input?.scope === "personal" && !project;
  if (!project && !isCommand && !personalWorkspace) {
    return {
      ok: false,
      status: 409,
      code: "remote-project-required",
      detail: "Choose the project explicitly before assigning this card to an Outpost, so its Loadout can be verified."
    };
  }

  const runtimeRequirement = isCommand
    ? null
    : remoteRuntimeRequirement(input, resolvedModelCached(opts?.root || kanbanRoot()));
  if (!isCommand && !runtimeRequirement) {
    return {
      ok: false,
      status: 409,
      code: "remote-runtime-unresolved",
      detail: "The active composition has no resolved execution cell for this card's next phase; choose Run on host or fix its duty/level routing."
    };
  }

  const appUrl = loadoutAppUrl(opts);
  if (!appUrl) {
    return { ok: false, status: 503, code: "remote-preflight-unavailable", detail: "Remote placement is unavailable until GARRISON_APP_URL is projected." };
  }
  let machinesResponse;
  try {
    machinesResponse = await fetch(`${appUrl}/api/dispatch/machines`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000)
    });
  } catch (error) {
    return { ok: false, status: 503, code: "worker-preflight-unavailable", detail: `Worker readiness could not be checked: ${String(error?.message || error).slice(0, 180)}` };
  }
  let machinesBody = {};
  try { machinesBody = await machinesResponse.json(); } catch { machinesBody = {}; }
  const machine = Array.isArray(machinesBody?.machines)
    ? machinesBody.machines.find((candidate) => candidate?.name === placement.target)
    : null;
  const worker = machine?.worker;
  if (!machinesResponse.ok || !worker || worker.ready !== true || worker.stale === true) {
    return {
      ok: false,
      status: 409,
      code: "worker-not-ready",
      detail: worker?.detail || `Enable/Repair the task runner on ${placement.target} before assigning work to it.`
    };
  }
  if (runtimeRequirement && (!Array.isArray(worker.runtimes) || !worker.runtimes.includes(runtimeRequirement.key))) {
    return {
      ok: false,
      status: 409,
      code: "worker-runtime-unsupported",
      detail: `${placement.target} does not advertise ${runtimeRequirement.key}, required by ${runtimeRequirement.duty}/L${runtimeRequirement.level}/${runtimeRequirement.phase} (${runtimeRequirement.targetId}).`
    };
  }
  if (!project) {
    return {
      ok: true,
      status: 200,
      code: "ready",
      detail: personalWorkspace ? "worker ready; the card will use its managed personal workspace" : "command worker ready"
    };
  }

  if (!resolveProjectName(project, { devRoot: opts?.devRoot || readDevRoot() })) {
    return { ok: false, status: 409, code: "unknown-project", detail: "Choose a Git repository under the configured dev root before assigning an Outpost." };
  }
  let loadoutResponse;
  try {
    loadoutResponse = await fetch(`${appUrl}/api/loadouts/${encodeURIComponent(project)}?dryRun=1`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000)
    });
  } catch (error) {
    return { ok: false, status: 503, code: "loadout-preflight-unavailable", detail: `Loadout preflight could not reach the host API: ${String(error?.message || error).slice(0, 180)}` };
  }
  let loadoutBody = {};
  try { loadoutBody = await loadoutResponse.json(); } catch { loadoutBody = {}; }
  if (!loadoutResponse.ok) {
    return {
      ok: false,
      status: 409,
      code: loadoutResponse.status === 404 ? "loadout-missing" : loadoutResponse.status === 409 ? "loadout-vault-locked" : "loadout-invalid",
      detail: loadoutBody?.detail || loadoutBody?.error || `Loadout preflight failed (HTTP ${loadoutResponse.status}).`
    };
  }
  const missing = Array.isArray(loadoutBody?.missing) ? loadoutBody.missing.filter((name) => typeof name === "string") : [];
  if (missing.length) {
    return { ok: false, status: 409, code: "loadout-incomplete", detail: `Vault values are missing for: ${missing.join(", ")}.` };
  }
  return { ok: true, status: 200, code: "ready", detail: "worker and Loadout preflight passed" };
}

async function handleLoadoutReadiness(req, res, opts, projectId) {
  const prefill = projectLoadoutPrefill(projectId, { devRoot: opts?.devRoot || readDevRoot() });
  if (!prefill) {
    return jsonRes(res, 404, {
      project: projectId,
      ready: false,
      status: "unknown-project",
      detail: "Choose a Git repository under the configured dev root before assigning an Outpost."
    });
  }
  const appUrl = loadoutAppUrl(opts);
  if (!appUrl) {
    return jsonRes(res, 503, {
      project: projectId,
      ready: false,
      status: "unavailable",
      detail: "Loadout preflight is unavailable until this composition projects GARRISON_APP_URL.",
      editor: prefill
    });
  }

  let upstream;
  try {
    upstream = await fetch(`${appUrl}/api/loadouts/${encodeURIComponent(projectId)}?dryRun=1`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000)
    });
  } catch (error) {
    return jsonRes(res, 503, {
      project: projectId,
      ready: false,
      status: "unavailable",
      detail: `Loadout preflight could not reach the host API: ${String(error?.message || error).slice(0, 180)}`,
      editor: prefill
    });
  }

  let body = {};
  try { body = await upstream.json(); } catch { body = {}; }
  if (upstream.status === 404) {
    const missingFacts = [
      !prefill.repo_remote ? "origin remote" : null,
      !prefill.default_branch ? "origin default branch" : null
    ].filter(Boolean);
    return jsonRes(res, 200, {
      project: projectId,
      ready: false,
      status: "missing",
      detail: missingFacts.length
        ? `No Loadout is authored, and Git does not expose: ${missingFacts.join(", ")}. Fill those fields explicitly; Garrison will not guess them.`
        : "No Loadout is authored. Confirm the repository facts, add explicit setup/verify instructions, and declare vault variable names only.",
      missing: [],
      editor: prefill
    });
  }

  const authored = body?.loadout && typeof body.loadout === "object" ? body.loadout : prefill;
  if (upstream.status === 409) {
    return jsonRes(res, 200, {
      project: projectId,
      ready: false,
      status: "vault-locked",
      detail: body?.detail || "Unlock the host vault before assigning this project to an Outpost.",
      missing: [],
      editor: authored
    });
  }
  if (!upstream.ok) {
    return jsonRes(res, 200, {
      project: projectId,
      ready: false,
      status: "invalid",
      detail: typeof body?.error === "string" ? body.error : `Loadout validation failed (HTTP ${upstream.status}).`,
      missing: [],
      editor: authored
    });
  }

  const missing = Array.isArray(body?.missing) ? body.missing.filter((name) => typeof name === "string") : [];
  return jsonRes(res, 200, {
    project: projectId,
    ready: missing.length === 0,
    status: missing.length === 0 ? "ready" : "missing-vault-values",
    detail: missing.length === 0
      ? "Loadout and vault preflight passed for remote execution."
      : `Vault values are missing for: ${missing.join(", ")}. Add them in Vault; values never enter this editor.`,
    missing,
    editor: authored
  });
}

async function handleSaveLoadout(req, res, opts, projectId) {
  const repo = resolveProjectName(projectId, { devRoot: opts?.devRoot || readDevRoot() });
  if (!repo) return jsonRes(res, 404, { error: "project is not a Git repository under the configured dev root" });
  const appUrl = loadoutAppUrl(opts);
  if (!appUrl) return jsonRes(res, 503, { error: "Loadout authoring is unavailable until this composition projects GARRISON_APP_URL" });
  const body = (await readBody(req)) || {};
  try {
    const upstream = await fetch(`${appUrl}/api/loadouts`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...body, id: projectId }),
      signal: AbortSignal.timeout(3000)
    });
    let response = {};
    try { response = await upstream.json(); } catch { response = {}; }
    return jsonRes(res, upstream.status, response);
  } catch (error) {
    return jsonRes(res, 503, { error: `Loadout authoring could not reach the host API: ${String(error?.message || error).slice(0, 180)}` });
  }
}

// Same-origin proxy of the gateway's route-options vocabulary (RUN-SPEC-V1).
//
// Short-TTL cached: the New Card sheet fetches it on every open, and the menu
// vocabulary changes only when the composition is recomposed. A DEGRADED answer
// (gateway down) is cached far more briefly - the usual cause is a fitting still
// coming up, and pinning "nothing available" for a full TTL reads as a broken UI.
//
// `sources.gateway: false` is the honest signal the UI renders as "start the
// operative to choose a runtime" instead of drawing empty dropdowns.
const ROUTE_OPTIONS_TTL_MS = 10_000;
const ROUTE_OPTIONS_DEGRADED_TTL_MS = 2_000;
let routeOptionsCache = null; // { expiresAt, body }

async function handleRouteOptions(req, res, opts) {
  const refresh = /[?&]refresh=(1|true)\b/.test(req.url || "");
  if (!refresh && routeOptionsCache && routeOptionsCache.expiresAt > Date.now()) {
    return jsonRes(res, 200, routeOptionsCache.body);
  }
  let gateway = null;
  if (opts?.gatewayUrl) {
    try {
      const target = new URL("/route/options", opts.gatewayUrl);
      const r = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j === "object" && !Array.isArray(j)) gateway = j;
      }
    } catch {
      gateway = null; // gateway down → a degraded, honest answer, never a 500
    }
  }
  const body = {
    targets: [],
    duties: [],
    efforts: [],
    accounts: [],
    tiers: [],
    flows: [],
    defaultFlow: null,
    projects: [],
    ...(gateway ?? {}),
    sources: { gateway: gateway !== null }
  };
  routeOptionsCache = {
    expiresAt: Date.now() + (gateway ? ROUTE_OPTIONS_TTL_MS : ROUTE_OPTIONS_DEGRADED_TTL_MS),
    body
  };
  jsonRes(res, 200, body);
}

// GET /skills — the skills installed under ~/.claude/skills, for the list-config skill
// field. Returns { skills:[{name,description}] }. Best-effort (empty when none found).
function handleSkills(req, res) {
  let skills = [];
  try { skills = listSkills(); } catch { skills = []; }
  jsonRes(res, 200, { skills });
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, fittingId: FITTING_ID, port: opts.port, pid: process.pid });
}

// GET /board/runtime — runtime context the UI needs to wire deep-links the
// composition's actual fittings serve. Channel embed id is NOT hardcoded
// (`web-channel-default` is just the seed name); we scan the
// ~/.garrison/ui-fittings/ status files and pick the first one whose fittingId
// starts with `web-channel` (the channel id convention) and which carries a
// reachable live URL. Returns:
//   - webChannelEmbedId   the fitting id (e.g. "web-channel-default") whose
//                         /embed/<id> route the board UI should link to. null
//                         when no web channel is installed/running, so the
//                         Discuss WatchSheet can show "no web channel
//                         installed" instead of a dead `<a>`.
//   - webChannelUrl       the channel's live own-port URL (for callers that
//                         want the direct, non-embedded URL).
//   - gatewayBaseUrl      the gateway URL injected by the runner.
//   - noGateway           true when no GARRISON_GATEWAY_URL is set at all,
//                         so the UI can render a global "no gateway running"
//                         banner without polling /health.
export async function readWebChannelStatus(statusDir = STATUS_ROOT) {
  try {
    const dir = statusDir;
    const fs = await import("node:fs/promises");
    let names;
    try { names = await fs.readdir(dir); } catch { return { id: null, url: null }; }
    // Prefer the conventional name when present so the test surface is stable.
    const preferred = "web-channel-default.json";
    const sorted = names
      .filter((n) => n.endsWith(".json") && n.startsWith("web-channel"))
      .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)));
    for (const name of sorted) {
      try {
        const raw = await fs.readFile(path.join(dir, name), "utf8");
        const parsed = JSON.parse(raw);
        const fittingId = typeof parsed?.fittingId === "string" ? parsed.fittingId : null;
        const url = typeof parsed?.url === "string" ? parsed.url : null;
        // Trust the status file's own pid liveness check: if the pid is dead
        // the runner's startup sweep removes the file, so a present file is
        // good enough for a UI hint. We don't HEAD the URL here — the WatchSheet
        // navigates to /embed/<id> on the parent Next app, not directly to the
        // channel's port, so a live status file means /embed/<id> will resolve.
        if (fittingId && fittingId.startsWith("web-channel")) {
          return { id: fittingId, url };
        }
      } catch { /* ignore one bad file */ }
    }
  } catch { /* ignore */ }
  return { id: null, url: null };
}

async function handleBoardRuntime(req, res, opts) {
  const channel = await readWebChannelStatus();
  // Absolute kanban-store cards dir, so the board can hand the web channel an absolute,
  // card-owned briefAbsPath (<cardsAbsDir>/<cardId>/brief.md) for the Brief editor — the
  // same file the Discuss duty writes and the engine reads. Deterministic; no project-dir guessing.
  const cardsAbsDir = path.join(kanbanRoot(), "cards");
  jsonRes(res, 200, {
    webChannelEmbedId: channel.id,
    webChannelUrl: channel.url,
    gatewayBaseUrl: opts.gatewayUrl || null,
    noGateway: !opts.gatewayUrl,
    cardsAbsDir
  });
}

// ─────────────────────────── static serve + bootstrap

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(distDir)) { res.statusCode = 403; return res.end("forbidden"); }
  if (!existsSync(filePath)) {
    const idx = path.join(distDir, "index.html");
    if (existsSync(idx)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      return createReadStream(idx).pipe(res);
    }
    res.statusCode = 404;
    return res.end("not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  const ct = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json" };
  res.statusCode = 200;
  res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The status file is a single tracking slot. If it names another live process,
// this boot is a duplicate - refuse instead of silently stealing the slot.
function assertStatusSlotFree() {
  let recorded;
  try { recorded = JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return; }
  const pid = Number(recorded?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
    console.error(`[kanban-loop] ${STATUS_FILE} is held by live pid ${pid} - refusing to overwrite another instance's status file`);
    process.exit(1);
  }
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    // "/" serves the visual board UI; "/board" is the JSON API. The status
    // file's route is what Garrison EMBEDS for the sidebar View - pointing it
    // at /board rendered raw JSON in the Views pane (dogfood finding).
    route: "/",
    views: [{ id: "board", title: "Kanban", route: "/" }]
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

function parseArgs(argv) {
  const out = {
    // Port precedence (house convention, same as improver/ports-default):
    // runner-projected composition config first (per-instance, e.g. main=7089
    // vs codex=27089), then the legacy explicit env (tests), then the default.
    port: Number(process.env.GARRISON_KANBANLOOP_PORT || process.env.KANBAN_UI_PORT || DEFAULT_PORT),
    host: process.env.GARRISON_KANBANLOOP_BIND_HOST || process.env.KANBAN_UI_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1",
    root: kanbanRoot(),
    cwd: projectRoot(),
    // The gateway this instance dispatches through. NO literal port fallback (HARD
    // RULE: never hardcode a port) — the old default was :4777, the DEV gateway, so a
    // prod/codex board that lost its env would have silently dispatched into another
    // instance's operative rather than failing visibly. A null here disables Start on
    // agent lists (handled downstream) and is logged at boot.
    gatewayUrl:
      (process.env.GARRISON_GATEWAY_URL || "").trim() ||
      (/^[0-9]+$/.test(String(process.env.GARRISON_GATEWAY_PORT || "").trim())
        ? `http://127.0.0.1:${String(process.env.GARRISON_GATEWAY_PORT).trim()}`
        : null),
    cap: Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
  }
  return out;
}

// Build the request router. Returned separately from startServer so it stays a
// pure function of `opts` (the live opts carry root/cwd/gateway/cap), keeping the
// handlers testable.
export function makeRequestHandler(opts, distDir) {
  return async (req, res) => {
    try {
      // No Access-Control-Allow-Origin: the board UI is served AND fetched on this
      // same port (and embedded via an iframe whose document is loaded from here),
      // so every legitimate request is same-origin. Omitting CORS means a
      // cross-origin page in the user's browser cannot read this server's responses
      // (it serves files), and mutating routes additionally enforce originAllowed.
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (method !== "GET" && !originAllowed(req)) {
        return jsonRes(res, 403, { error: "cross-origin mutation rejected" });
      }

      if (pathname === "/health") return await handleHealth(req, res, opts);
      if (pathname === "/board" && method === "GET") return await handleBoard(req, res, opts);
      if (pathname === "/board/runtime" && method === "GET") return await handleBoardRuntime(req, res, opts);
      if (pathname === "/lists" && method === "GET") return await handleGetLists(req, res, opts);
      // GET /machines — the placement picker's vocabulary: the host plus every
      // paired outpost with its live connected state. Same-origin proxy of the
      // outpost daemon, exactly as /route-options proxies the gateway, so the
      // browser never needs to reach the daemon (which binds loopback) and the
      // picker cannot offer a machine the dispatcher would then refuse.
      //
      // The daemon URL is INSTANCE-SPECIFIC and arrives already port-shifted as
      // GARRISON_KANBANLOOP_OUTPOST_HOST_URL. No literal fallback: the old one
      // named the codex port and every probe silently failed.
      if (pathname === "/machines" && method === "GET") {
        const defaultRuntime = remoteRuntimeRequirement({}, resolvedModelCached(opts.root || kanbanRoot()));
        const host = { name: "host", label: "This machine (Garrison host)", connected: true, isHost: true, bridge: "connected", worker: { state: "ready", ready: true, runtimes: [] } };
        const daemon = (process.env.GARRISON_OUTPOST_URL
          || process.env.GARRISON_KANBANLOOP_OUTPOST_HOST_URL
          || "").trim();
        const appUrl = (process.env.GARRISON_APP_URL || "").trim();
        if (!daemon && !appUrl) return jsonRes(res, 200, { machines: [host], outpostsAvailable: false, defaultRuntime, reason: "outpost registry is not configured for this instance" });
        try {
          const [bridgeResponse, workerResponse] = await Promise.all([
            daemon
              ? fetch(`${daemon}/outposts`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
              : Promise.resolve(null),
            appUrl
              ? fetch(`${appUrl.replace(/\/+$/, "")}/api/dispatch/machines`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
              : Promise.resolve(null)
          ]);
          const bridges = bridgeResponse?.ok ? ((await bridgeResponse.json()).outposts || []) : [];
          const dispatchMachines = workerResponse?.ok ? ((await workerResponse.json()).machines || []) : [];
          const bridgeByName = new Map(bridges.map((machine) => [machine.name, machine]));
          const dispatchByName = new Map(dispatchMachines.map((machine) => [machine.name, machine]));
          const names = [...new Set([...bridgeByName.keys(), ...dispatchByName.keys()])].filter((name) => typeof name === "string" && name !== "host").sort();
          const machines = [host, ...names.map((name) => {
            const bridge = bridgeByName.get(name);
            const dispatchMachine = dispatchByName.get(name);
            const worker = dispatchMachine?.worker || {
              state: "offline", ready: false, stale: true, runtimes: [],
              detail: "Task runner has not checked in", error: null
            };
            return {
              name,
              label: name,
              connected: Boolean(bridge?.connected),
              bridge: bridge?.connected ? "connected" : "offline",
              pending: Boolean(bridge?.pending ?? dispatchMachine?.pending),
              worker,
              isHost: false
            };
          })];
          return jsonRes(res, 200, { machines, outpostsAvailable: true, defaultRuntime });
        } catch (e) {
          // The daemon being down must not break card creation — degrade to
          // host-only and SAY why, rather than rendering an empty picker.
          return jsonRes(res, 200, {
            machines: [host],
            outpostsAvailable: false,
            defaultRuntime,
            reason: `outpost registry unavailable: ${e instanceof Error ? e.message : String(e)}`
          });
        }
      }
      // GET /policy — read-only passthrough of the compiled Orchestrator policy
      // (flows, phase plans, skill bindings) so the card-create UI can
      // offer flows + per-card phase toggles (D17). 404 when Garrison has
      // not compiled one yet; the UI degrades to plain creation.
      if (pathname === "/policy" && method === "GET") {
        const policy = loadPolicy();
        if (!policy) return jsonRes(res, 404, { error: "no compiled policy (start Garrison / the Orchestrator fitting)" });
        return jsonRes(res, 200, {
          flows: policy.flows || {},
          phasePlans: policy.phasePlans || {},
          defaultFlow: policy.defaultFlow || null,
          phases: policy.phases || [],
          phaseSkills: policy.phaseSkills || { bindings: {}, overrides: {} }
        });
      }
      // GET /route-options — same-origin PROXY of the gateway's GET /route/options,
      // exactly as the web channel does it. The run-spec dropdowns on the New Card
      // sheet are populated from the SAME vocabulary the gateway validates a pin
      // against, so the form can never offer a target/tier/flow that would then
      // be refused. Deliberately a proxy and not a second reader of policy.json:
      // two shapes over one file is how the two surfaces drift apart.
      if (pathname === "/route-options" && method === "GET") return await handleRouteOptions(req, res, opts);
      if (pathname === "/projects" && method === "GET") return await handleProjects(req, res, opts);
      const projectMappingMatch = pathname.match(/^\/projects\/([^/]+)$/);
      if (projectMappingMatch && method === "PUT") {
        return await handlePutProjectMapping(req, res, opts, decodeURIComponent(projectMappingMatch[1]));
      }
      if (pathname === "/skills" && method === "GET") return await handleSkills(req, res);
      // Project Loadout preflight/authoring stays same-origin. The browser sees
      // readiness and secret NAMES only; the host API remains the authority for
      // vault resolution and never returns a secret value.
      const loadoutMatch = pathname.match(/^\/loadouts\/([^/]+)$/);
      if (loadoutMatch && (method === "GET" || method === "POST")) {
        let projectId;
        try { projectId = decodeURIComponent(loadoutMatch[1]); }
        catch { return jsonRes(res, 400, { error: "invalid project id" }); }
        if (method === "GET") return await handleLoadoutReadiness(req, res, opts, projectId);
        return await handleSaveLoadout(req, res, opts, projectId);
      }
      // Same-origin SSE proxy of the gateway's live operative terminal screen
      // (Watch's Terminal tab). Proxied rather than CORS-opened: the board
      // deliberately serves and fetches everything on this one port.
      if (pathname === "/operative/screen" && method === "GET") return await handleOperativeScreen(req, res, opts);
      // Host-aware URL rewriting for card bodies (loopback → tailnet) and the
      // same-origin serve of absolute file paths / attachments surfaced in them.
      if (pathname === "/host-map" && method === "GET") return await handleHostMap(req, res);
      if (pathname === "/file" && method === "GET") return await handleFile(req, res, opts, parsed.query);
      if (pathname === "/cards" && method === "POST") return await handleCreateCard(req, res, opts);
      if (pathname === "/cards" && method === "GET") return await handleListCards(req, res, opts, parsed.query);

      // PATCH /lists/:listId — configure a list. Validate the id (clean kebab,
      // no traversal) before it reaches the board.
      const listMatch = pathname.match(/^\/lists\/([^/]+)$/);
      if (listMatch && method === "PATCH") {
        const listId = decodeURIComponent(listMatch[1]);
        if (!isValidListId(listId)) return jsonRes(res, 400, { error: "invalid list id" });
        return await handlePatchList(req, res, opts, listId);
      }

      // POST /lists { title, id?, description?, target?, effort? } - create a
      // new column = create a composition-local DUTY. The board never writes
      // apm.yml itself: it proxies to the shell (the single composition
      // writer), which appends the duty + selection, reprojects model.json,
      // and calls back POST /reconcile so the column appears live.
      // DELETE /lists/:id - the inverse (deselect + delete the duty definition);
      // the shell's reconcile callback parks any cards stranded on the list.
      if (pathname === "/lists" && method === "POST") {
        if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin list create rejected" });
        const appUrl = (process.env.GARRISON_APP_URL || "").trim();
        if (!appUrl) return jsonRes(res, 503, { error: "no GARRISON_APP_URL in this fitting's env - re-up the composition so the runner projects it" });
        const body = (await readBody(req)) || {};
        try {
          const r = await fetch(`${appUrl}/api/muster/duty`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "create",
              dutyId: body.id,
              title: body.title,
              description: body.description,
              target: body.target,
              effort: body.effort
            }),
            signal: AbortSignal.timeout(20000)
          });
          const doc = await r.json().catch(() => ({}));
          return jsonRes(res, r.status, doc);
        } catch (e) {
          return jsonRes(res, 502, { error: `shell unreachable for duty create: ${e?.message || e}` });
        }
      }
      if (listMatch && method === "DELETE") {
        if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin list delete rejected" });
        const listId = decodeURIComponent(listMatch[1]);
        if (!isValidListId(listId)) return jsonRes(res, 400, { error: "invalid list id" });
        const appUrl = (process.env.GARRISON_APP_URL || "").trim();
        if (!appUrl) return jsonRes(res, 503, { error: "no GARRISON_APP_URL in this fitting's env - re-up the composition so the runner projects it" });
        try {
          const r = await fetch(`${appUrl}/api/muster/duty`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "delete", dutyId: listId }),
            signal: AbortSignal.timeout(20000)
          });
          const doc = await r.json().catch(() => ({}));
          return jsonRes(res, r.status, doc);
        } catch (e) {
          return jsonRes(res, 502, { error: `shell unreachable for duty delete: ${e?.message || e}` });
        }
      }

      // GET /origins/:originId[/events] (S3e) - the durable per-origin event log +
      // record, for PULL delivery (skill/terminal sessions poll_origin_events). The id
      // is sanitised by safeOriginId before it touches the store (no traversal).
      const originMatch = pathname.match(/^\/origins\/([^/]+)(\/events)?$/);
      if (originMatch && method === "GET") {
        const originId = decodeURIComponent(originMatch[1]);
        if (originMatch[2] === "/events") return await handleGetOriginEvents(req, res, opts, originId, parsed.query);
        return await handleGetOrigin(req, res, opts, originId);
      }

      // GET /cards/resolve - the spoken/short-ref card resolver. MUST precede
      // the /cards/:id match ("resolve" is not a ULID).
      if (pathname === "/cards/resolve" && method === "GET") {
        return await handleResolveCard(req, res, opts, parsed.query);
      }

      // Card export / import (Item 4). Both MUST precede the /cards/:id match below
      // ("export"/"import" are not ULIDs, exactly like /cards/resolve). Non-GET is
      // already behind the originAllowed guard at the top of the handler.
      if (pathname === "/cards/export" && method === "GET") {
        return await handleExportCards(req, res, opts, parsed.query);
      }
      if (pathname === "/cards/import" && method === "POST") {
        return await handleImportCards(req, res, opts);
      }

      // POST /reconcile - live board reconcile from model.json (the shell calls
      // this right after a duty create/remove).
      if (pathname === "/reconcile" && method === "POST") {
        return await handleReconcile(req, res, opts);
      }

      // POST /lists/reorder { order: [listIds], rev } - persist a column drag
      // as the operator-owned userOrder (survives the duty reconcile, which
      // only rewrites engine-owned fields). Ids not named keep their place at
      // the tail in current order.
      if (pathname === "/lists/reorder" && method === "POST") {
        if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin reorder rejected" });
        const body = (await readBody(req)) || {};
        const order = Array.isArray(body.order) ? body.order.filter((x) => typeof x === "string" && x !== "scheduled") : null;
        if (!order || !order.length) return jsonRes(res, 400, { error: "pass order: [listId, ...]" });
        const expectedRev = Number.isInteger(body.rev) ? body.rev : null;
        const root = opts.root;
        const board = await loadBoard(root);
        if (expectedRev !== null && (board.rev ?? 0) !== expectedRev) {
          return jsonRes(res, 409, { error: "board changed under you" });
        }
        const rank = new Map([["scheduled", -1], ...order.map((id, i) => [id, i])]);
        const current = (board.lists || [])
          .slice()
          .sort((a, b) => (a.userOrder ?? a.order ?? 0) - (b.userOrder ?? b.order ?? 0));
        // Unnamed lists keep their relative order after the named ones.
        let tail = order.length;
        for (const list of current) {
          if (!rank.has(list.id)) rank.set(list.id, tail++);
        }
        const saved = await saveBoardCAS(root, board.rev ?? 0, (b) => ({
          board: { ...b, lists: (b.lists || []).map((l) => ({ ...l, userOrder: l.id === "scheduled" ? -1 : rank.get(l.id) ?? 0 })) }
        }));
        if (!saved.ok) return jsonRes(res, 409, { error: saved.error || "board changed under you" });
        return jsonRes(res, 200, { ok: true, order: [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id) });
      }

      // Any /cards/:id route: decode + VALIDATE the id (a clean ULID) before it can
      // reach the filesystem, so an encoded `..%2f` id cannot traverse out of the
      // board root via loadCard/saveCardCAS/appendCardLog.
      const idMatch = pathname.match(/^\/cards\/([^/]+)(\/artifact|\/attachments|\/attachment|\/session-stream|\/start|\/panic|\/dispatch-complete|\/dispatch-cancel|\/snooze|\/run-now|\/watch|\/brief|\/infer-project|\/abandon|\/revert|\/handoff|\/steer|\/drill|\/drill-result)?$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const sub = idMatch[2] || "";
        if (!isValidCardId(id)) return jsonRes(res, 400, { error: "invalid card id" });
        if (sub === "/snooze" && method === "POST") return await handleSnoozeCard(req, res, opts, id);
        if (sub === "/run-now" && method === "POST") return await handleRunScheduleNow(req, res, opts, id);
        if (sub === "/attachments" && method === "POST") return await handleAttachmentUpload(req, res, opts, id);
        if (sub === "/attachments" && method === "DELETE") return await handleAttachmentRemove(req, res, opts, id, parsed.query.name);
        if (sub === "/artifact" && method === "GET") return await handleArtifact(req, res, opts, id, parsed.query.ref);
        if (sub === "/artifact" && method === "PUT") return await handleArtifactWrite(req, res, opts, id, parsed.query.ref);
        if (sub === "/attachment" && method === "GET") return await handleAttachment(req, res, opts, id, parsed.query.i);
        if (sub === "/session-stream" && method === "GET") return await handleSessionStream(req, res, opts, id, Number(parsed.query.i ?? 0));
        if (sub === "/start" && method === "POST") return await handleStartCard(req, res, opts, id);
        if (sub === "/panic" && method === "POST") return await handlePanicCard(req, res, opts, id);
        if (sub === "/dispatch-complete" && method === "POST") return await handleDispatchComplete(req, res, opts, id);
        if (sub === "/dispatch-cancel" && method === "POST") return await handleDispatchCancelAck(req, res, opts, id);
        if (sub === "/abandon" && method === "POST") return await handleAbandonCard(req, res, opts, id);
        if (sub === "/revert" && method === "POST") return await handleRevertCard(req, res, opts, id);
        if (sub === "/brief" && method === "POST") return await handleBriefCard(req, res, opts, id);
        if (sub === "/infer-project" && method === "POST") return await handleInferProject(req, res, opts, id);
        if (sub === "/watch" && method === "GET") return await handleWatchCard(req, res, opts, id);
        if (sub === "/handoff" && method === "GET") return await handleGetHandoff(req, res, opts, id);
        if (sub === "/steer" && method === "POST") return await handleSteerCard(req, res, opts, id);
        if (sub === "/drill" && method === "POST") return await handleSendToDrill(req, res, opts, id);
        if (sub === "/drill-result" && method === "POST") return await handleDrillResult(req, res, opts, id);
        if (sub === "" && method === "GET") return await handleGetCard(req, res, opts, id);
        if (sub === "" && method === "PATCH") return await handlePatchCard(req, res, opts, id);
        if (sub === "" && method === "DELETE") return await handleDeleteCard(req, res, opts, id);
      }

      return serveStatic(req, res, distDir);
    } catch (err) {
      if (err?.code === "BODY_TOO_LARGE") {
        return jsonRes(res, 413, { error: "request JSON exceeds the 16 MB limit" });
      }
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");
  assertStatusSlotFree();
  const liveOpts = { ...opts };

  // Recover cards stranded "running" by a mid-run restart — their dispatch died
  // with the previous process, so nothing will ever finish or revert them.
  try {
    const recovered = await recoverInterruptedRuns(liveOpts.root);
    if (recovered.length) {
      console.log(`[kanban-loop] recovered ${recovered.length} interrupted run(s): ${recovered.join(", ")}`);
    }
  } catch (err) {
    console.error("[kanban-loop] interrupted-run recovery failed:", err?.message || err);
  }

  // Repair the narrow post-commit window where a process could die after a
  // personal card reached Done but before its neutral memory packet landed.
  // This only touches the Kanban outbox; Basic Memory consumes it separately.
  try {
    const repaired = await reconcilePersonalCompletionOutbox(liveOpts.root);
    if (repaired.emitted) {
      console.log(`[kanban-loop] repaired ${repaired.emitted} missing personal completion packet(s)`);
    }
    for (const failure of repaired.errors) {
      console.error(`[kanban-loop] personal completion reconcile failed for ${failure.cardId}: ${failure.error}`);
    }
  } catch (err) {
    console.error("[kanban-loop] personal completion reconciliation failed:", err?.message || err);
  }

  // The terminal transition deliberately does not wait for channel I/O. Repair
  // any process-death window from the durable per-channel receipts before this
  // server starts accepting new board work. Every delivery uses a destination-
  // scoped idempotency key, so replay cannot append a second message.
  try {
    const repaired = await reconcileMorningBriefDeliveries(liveOpts.root);
    if (repaired.completed) {
      console.log(`[kanban-loop] repaired ${repaired.completed} Morning briefing delivery receipt(s)`);
    }
    for (const failure of repaired.errors) {
      console.error(`[kanban-loop] Morning briefing reconcile failed for ${failure.cardId}: ${failure.error}`);
    }
  } catch (err) {
    console.error("[kanban-loop] Morning briefing reconciliation failed:", err?.message || err);
  }

  // Re-register the scheduler tick from HERE, where this instance's gateway URL is
  // actually in scope. The job command is PERSISTED in the scheduler's jobs file, so
  // a job registered once — by the apm.yml setup hook, which never sees a gateway URL
  // — stays wrong forever. That is how prod ended up ticking against the DEV gateway
  // (:4777) indefinitely: every 2 minutes it logged "gateway not reachable" and did
  // nothing, so no card was ever dispatched, advanced or swept by the tick.
  // Registration is idempotent (remove + add), so doing it on every boot makes a
  // stale job self-healing on restart instead of needing a manual repair.
  if (liveOpts.gatewayUrl) {
    try {
      const { registerTick } = await import("./kanban.mjs");
      const { syncAllBeats } = await import("../lib/scheduler-beats.mjs");
      process.env.GARRISON_GATEWAY_URL = process.env.GARRISON_GATEWAY_URL || liveOpts.gatewayUrl;
      await registerTick();
      // The per-list BEATS (the Test list) have the identical problem and the identical
      // fix: only the setup hook ever registered them, and it has no gateway URL, so
      // kanban-test-beat was as dead as the tick was.
      await syncAllBeats(await loadBoard(liveOpts.root), { log: () => {} }).catch(() => {});
    } catch (err) {
      console.error("[kanban-loop] tick re-registration failed:", err?.message || err);
    }
  } else {
    console.warn("[kanban-loop] no gateway URL — the scheduler tick was NOT re-registered and cannot dispatch");
  }

  const server = http.createServer(makeRequestHandler(liveOpts, distDir));
  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[kanban-loop] port ${liveOpts.port} is already in use - refusing to start on a shifted port (the configured port is canonical)`);
      process.exit(1);
    }
    throw err;
  });

  // WebSocket /io — the card Terminal modal's interactive shell PTY. The init
  // frame names the PTY id `card-<cardId>-shell`; the shell opens at that card's
  // project cwd (cardWorkdir). Same-origin only: reject cross-origin upgrades
  // (originAllowed) on top of the 127.0.0.1 bind.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = url.parse(request.url || "/");
    if (pathname !== "/io") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!originAllowed(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const PTY_ID_RE = /^card-([0-9A-HJKMNP-TV-Z]{26})-shell$/;
  wss.on("connection", (ws) => {
    let ptyId = null;
    let initializing = false;
    ws.on("message", async (data, isBinary) => {
      if (!ptyId) {
        // Ignore stray frames (a ResizeObserver resize) that race the init await.
        if (initializing) return;
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
        if (msg.type !== "init" || typeof msg.sessionId !== "string") return;
        // Validate the PTY id shape (`card-<ULID>-shell`) so nothing but a real
        // card id ever reaches loadCard / the spawned shell's cwd.
        const m = PTY_ID_RE.exec(msg.sessionId);
        if (!m || !isValidCardId(m[1])) {
          try { ws.send(JSON.stringify({ type: "error", message: "invalid pty id" })); } catch {}
          ws.close();
          return;
        }
        initializing = true;
        let card;
        try { card = await loadCard(liveOpts.root, m[1]); }
        catch { card = null; }
        if (!card) {
          try { ws.send(JSON.stringify({ type: "error", message: "card not found" })); } catch {}
          ws.close();
          return;
        }
        card.id = m[1];
        let workdir;
        try {
          workdir = cardWorkdir(card, liveOpts);
        } catch (err) {
          try { ws.send(JSON.stringify({ type: "error", message: String(err?.message || err) })); } catch {}
          ws.close();
          return;
        }
        const rec = spawnPty({ id: msg.sessionId, cwd: workdir });
        rec.ws = ws;
        ptyId = rec.id;
        // Size the PTY to the connecting client BEFORE replaying, so a full-width
        // TUI box isn't drawn wider than the xterm viewport.
        if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows) && msg.cols > 0 && msg.rows > 0) {
          resizePty(rec, Math.floor(msg.cols), Math.floor(msg.rows));
        }
        try {
          ws.send(JSON.stringify({ type: "init_ack", id: rec.id, cwd: rec.cwd, shell: rec.shell, tmux: false }));
          if (rec.buffer.length > 0) ws.send(rec.buffer);
        } catch {}
        return;
      }

      const rec = getPty(ptyId);
      if (!rec || rec.state !== "running") return;
      if (isBinary) {
        try { rec.pty.write(data.toString("utf8")); rec.lastActivity = Date.now(); } catch {}
        return;
      }
      const text = data.toString("utf8");
      let frame = null;
      if (text.startsWith("{")) { try { frame = JSON.parse(text); } catch {} }
      if (frame && typeof frame === "object" && typeof frame.type === "string") {
        if (frame.type === "resize" && Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) {
          resizePty(rec, frame.cols, frame.rows);
        } else if (frame.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch {}
        } else if (frame.type === "stdin" && typeof frame.data === "string") {
          try { rec.pty.write(frame.data); rec.lastActivity = Date.now(); } catch {}
        }
        return;
      }
      try { rec.pty.write(text); rec.lastActivity = Date.now(); } catch {}
    });

    ws.on("close", () => {
      if (!ptyId) return;
      const rec = getPty(ptyId);
      if (!rec || rec.ws !== ws) return;
      // PTYs are process-lifetime persistent: just detach. No reap timer.
      rec.ws = null;
    });
  });

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[kanban-loop] board UI on http://${liveOpts.host}:${liveOpts.port}`);
      if (!liveOpts.gatewayUrl) console.warn("[kanban-loop] no GARRISON_GATEWAY_URL — Start on agent lists is disabled");
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[kanban-loop] shutdown (${signal})`);
    try { shutdownPtys(); } catch { /* best-effort PTY teardown */ }
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: liveOpts };
}

const isDirect = (() => {
  if (!import.meta.url) return false;
  try { return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || ""); } catch { return false; }
})();

if (isDirect) {
  startServer().catch((err) => { console.error("[kanban-loop] failed:", err); process.exit(1); });
}
