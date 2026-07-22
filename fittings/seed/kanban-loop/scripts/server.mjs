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
import {
  kanbanRoot,
  loadBoard,
  saveBoard,
  saveBoardCAS,
  loadAllCards,
  loadCard,
  createCard,
  saveCardCAS,
  deleteCard,
  deriveMembership,
  appendCardLog,
  latestCardLogNumber,
  cardBriefFile,
  cardBriefRel,
  atomicWriteJSON
} from "../lib/board.mjs";
// S3a: the lifecycle event router — the server emits `created` after a card is made.
import { routeOriginEvent, createdMessage } from "../lib/notify-origin.mjs";
import { readOriginRecord, readOriginEventsSince } from "../lib/origins.mjs";
// S3c: steering sidecars (steering.md guidance + steering.json revisit directive).
import { STEER_ACTIONS, appendSteeringMd, writeSteeringDirective, markSteeringApplied, readSteeringDirective, isEarlierPhase } from "../lib/steering.mjs";
import {
  getList,
  validNextFor,
  processCard,
  processChain,
  processBatch,
  recoverInterruptedRuns,
  triggerFor,
  isInteractive,
  isGatedDiscuss,
  withEvent,
  replySnippet,
  parkFields,
  ATTENTION_LIST
} from "../lib/engine.mjs";
import { batchGatewayRunFn } from "./kanban.mjs";
import { recordBrief, briefRelPath } from "./discuss.mjs";
import { gatewayRunFn, inferenceRunFn, compactBoundaryFn } from "../lib/gateway-client.mjs";
import { inferProject, explicitWorkspaceFromCard } from "../lib/infer-project.mjs";
import { loadPolicy, railForCard, railIsManualOnly } from "../lib/policy.mjs";
import {
  readTouchSet,
  coordinationConfig,
  coordinationAvailability,
  serializeGate,
  repoPathForProject,
  removeCardIntents,
  releaseLeases
} from "../lib/coordination.mjs";
import { prepareRevert, executeRevert } from "../lib/fences.mjs";
import { listProjects, readDevRoot, listSkills } from "../lib/discover.mjs";
import { syncListBeat } from "../lib/scheduler-beats.mjs";
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
import { readJsonlLines, parseTranscriptLines } from "../lib/session-transcript.mjs";
// Terminal modal: an interactive shell PTY per card over the /io WebSocket.
import { WebSocketServer } from "ws";
import { spawnPty, getPty, resizePty, killPty, shutdownPtys } from "./ptys.mjs";
// Host-aware URL rewriting: loopback ports → their HTTPS tailnet form, for the
// GET /host-map the UI reads (see ui/host-rewrite.ts).
import { getTailnetServeMap } from "../lib/tailnet-serve.mjs";

const FITTING_ID = "kanban-loop";
const DEFAULT_PORT = 27089;
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

// The working directory a card's Terminal shell opens in. An absolute existing
// project dir is used directly; a bare project NAME resolves under the same
// dev-root the /projects picker scans; otherwise the board's project root. No
// per-task branch/worktree — the shell just opens at the project root.
function cardWorkdir(card, opts) {
  const proj = typeof card?.project === "string" ? card.project.trim() : "";
  if (proj) {
    if (path.isAbsolute(proj)) {
      try { if (statSync(proj).isDirectory()) return proj; } catch { /* fall through */ }
    } else {
      const under = path.join(readDevRoot(), proj);
      try { if (statSync(under).isDirectory()) return under; } catch { /* fall through */ }
    }
  }
  return opts?.cwd || projectRoot();
}

// ─────────────────────────── pure helpers (exported, unit-tested)

// Build the board view the UI renders: the list defs (in order) plus the cards
// decorated with their DERIVED list membership (membership is never stored —
// board.deriveMembership scans the cards). Each list carries its cards inline so
// the phone UI renders a column per list without a second round-trip; the flat
// `cards` array is kept too for clients that prefer it.
export function buildBoardView(board, cards) {
  const membership = deriveMembership(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lists = (board.lists || [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((list) => ({
      id: list.id,
      title: list.title,
      order: list.order ?? 0,
      kind: list.kind || "manual",
      trigger: triggerFor(list),
      interactive: Boolean(isInteractive(list)),
      // D15: phase only — skill/taskType/tier/mode live in the compiled policy.
      phase: list.phase ?? (list.kind === "agent" ? list.id : null),
      terminal: Boolean(list.terminal),
      notifyOnEntry: Boolean(list.notifyOnEntry),
      validNext: Array.isArray(list.validNext) ? list.validNext : [],
      cards: (membership[list.id] || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(cardSummary)
    }));
  return { version: board.version ?? 2, lists, cards: cards.map(cardSummary) };
}

// The card fields the board front renders: title, project chip, list, iter/cap,
// goalMode, status — plus the pointer set (so the UI can show Open without a
// second fetch). It is a projection, not a copy of any artifact body.
export function cardSummary(card) {
  // The card's LATEST commit fence (S2, Q5) — the board shows only the most recent
  // one as a subtle chip; the full chain lives on the card, not in this projection.
  const fenceList = Array.isArray(card.fences) ? card.fences : [];
  const lastFence = fenceList.length ? fenceList[fenceList.length - 1] : null;
  return {
    id: card.id,
    title: card.title ?? "(untitled)",
    project: card.project ?? null,
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
    // S4 (D2/D17): the run-policy fields — the work kind naming the rail, the
    // per-card phase toggles (OFF phases render as dimmed chips: honesty), the
    // tier, and who registered the run.
    workKind: card.workKind ?? null,
    phases: card.phases ?? null,
    tier: card.tier ?? null,
    origin: card.origin ?? null,
    outpost: card.outpost ?? null,
    // D15 (S4a): the card's resolved-model journey — its duty + level and the
    // cached ordered leaf phase lists it visits (skipping the rest).
    duty: card.duty ?? null,
    level: card.level ?? null,
    sequence: Array.isArray(card.sequence) ? card.sequence : null,
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
    // null when no turn has routed yet / souls mode. The board renders a small
    // "<phase> @ <model>" chip from it.
    lastRoute: lastRouteOf(card),
    eventCount: Array.isArray(card.events) ? card.events.length : 0,
    runningSince: card.runningSince ?? null,
    // Project-inference state for a no-project card: running | done | none | skipped |
    // failed | null (never attempted). The UI shows "inferring project…" while running.
    inferState: card.inferState ?? null,
    updated: card.updated ?? null
  };
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

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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

  // (a) steering.md — always (the absorb guidance the prompt folds in).
  appendSteeringMd(opts.root, id, { at, action, message });
  // (b) steering.json — the pending revisit directive.
  if (action === "revisit" && revisitDuty) {
    writeSteeringDirective(opts.root, id, { at, action, revisitDuty, reason, applied: false });
  }
  // (c) timeline event (engine-context, rev-safe reload+retry; non-fatal).
  await updateCard(opts.root, id, (c) => ({
    ...c,
    events: withEvent(c, { at, kind: "steering", message: `Steering: ${action}${revisitDuty ? ` → ${revisitDuty}` : ""}`, detail: reason || null })
  })).catch(() => null);
  // (d) an idle card with a revisit directive re-stages IMMEDIATELY.
  let applied = false;
  if (action === "revisit" && revisitDuty && card.status !== "running") {
    const board = await loadBoard(opts.root);
    if (getList(board, revisitDuty)) {
      const moved = await updateCard(opts.root, id, (c) => ({
        ...c,
        list: revisitDuty,
        status: "ok",
        runningSince: null,
        events: withEvent(c, { at: new Date().toISOString(), kind: "steering-restage", message: `Re-staged to ${revisitDuty} (steering)` })
      }));
      if (moved) {
        applied = true;
        markSteeringApplied(opts.root, id);
      }
    }
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
    links,
    // Files the user attached via ClaudeChat (parsed from the description, issue
    // #2). Derived, not stored; each carries a same-origin serve URL.
    attachments: parseAttachments(card.description).map((a) => ({
      i: a.i,
      name: a.name,
      image: a.image,
      url: `/cards/${encodeURIComponent(id)}/attachment?i=${a.i}`
    })),
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
  // that still has no project and isn't already inferring.
  const started = await updateCard(root, id, (card) => {
    if (card.project) return null;
    if (!manual && card.inferState === "running") return null;
    return { ...card, inferState: "running", events: withEvent(card, inferEvent("inference", "Inferring the project from the title + description…")) };
  });
  if (!started || started.project) return;

  if (!gatewayUrl || !(await gatewayReachable(gatewayUrl))) {
    await updateCard(root, id, (card) => card.project ? null : ({
      ...card,
      inferState: "skipped",
      events: withEvent(card, inferEvent("inference", "Project inference skipped — no operative is running. Set a project manually, or it'll be inferred on the next run."))
    }));
    return;
  }

  try {
    const knownProjects = knownProjectsFrom(await loadAllCards(root));
    const { project, reply } = await inferProject(started, inferenceRunFn(gatewayUrl), { knownProjects });
    await updateCard(root, id, (card) => {
      if (card.project) return null; // the user set one while we inferred — respect it
      if (project) {
        return { ...card, project, inferState: "done", events: withEvent(card, inferEvent("inference", `Inferred the project: ${project}`, replySnippet(reply))) };
      }
      return { ...card, inferState: "none", events: withEvent(card, inferEvent("inference", "Couldn't confidently infer a project — left blank. Set one on the card if you know it.", replySnippet(reply))) };
    });
  } catch (err) {
    await updateCard(root, id, (card) => card.project ? null : ({
      ...card,
      inferState: "failed",
      events: withEvent(card, inferEvent("inference", "Project inference failed (the operative was busy or unavailable) — left blank.", String(err?.message || err)))
    }));
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

// POST /cards — create a card in Backlog. Body: { title?, description?, project?,
// goalMode?, acceptance? }. Title is OPTIONAL: a blank title is inferred from the
// description's first line (only when BOTH are blank is there nothing to name it by).
// A card created WITHOUT a project kicks a visible, fire-and-forget project inference
// (so the attempt shows on the card instead of nothing).
async function handleCreateCard(req, res, opts) {
  const body = (await readBody(req)) || {};
  const description = typeof body.description === "string" ? body.description : "";
  const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
  const title = rawTitle || deriveTitle(description);
  if (!title) return jsonRes(res, 400, { error: "give the card a title or a description to infer one from" });
  const suppliedProject = typeof body.project === "string" && body.project.trim() ? body.project.trim() : null;
  const explicitWorkspace = suppliedProject ? null : explicitWorkspaceFromCard({ title, description });
  const card = await createCard(opts.root, {
    title,
    description,
    project: suppliedProject || explicitWorkspace,
    list: "backlog",
    goalMode: body.goalMode === true,
    acceptance: typeof body.acceptance === "string" ? body.acceptance : null,
    // S4 (D2/D8/D17): the work kind naming the card's phase plan, the per-card
    // phase toggles merged over it, the tier (direct field or the D8 payload's
    // classification), and the origin of the registration.
    workKind: typeof body.workKind === "string" ? body.workKind : null,
    phases: body.phases && typeof body.phases === "object" ? body.phases : null,
    tier: typeof body.tier === "string" ? body.tier : (typeof body.classification?.tier === "string" ? body.classification.tier : null),
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
    outpost: typeof body.outpost === "string" && body.outpost.trim() ? body.outpost.trim() : null,
    // WS2 (D7): a continuation card references its predecessor by ULID. createCard
    // shape-validates it and stamps origin "continuation" when no origin is given.
    continues: typeof body.continues === "string" ? body.continues : null,
    // S3a (D8): an explicit origin_id (else createCard derives it from originChannel/origin).
    origin_id: typeof body.origin_id === "string" ? body.origin_id : null,
    // S3d (D9b): a board/API/gateway caller can pass the clarity verdict; a
    // needs-discuss card is dispatched through the Discuss duty first. createCard
    // normalises anything but "needs-discuss" to null. NOTE: a card is CREATED on
    // backlog (title/project inference); the clarity is stamped now, but the card only
    // REACHES Discuss when its creator moves it there (the gateway carding does this via
    // targetList "discuss"; a bare API client must issue the follow-up move itself).
    clarity: typeof body.clarity === "string" ? body.clarity : null
  });
  // D19: a quick card (the gateway's trivial-plan inline task) carries quick:true.
  // createCard's field set is frozen, so stamp it via updateCard right after create.
  if (body.quick === true) {
    const q = await updateCard(opts.root, card.id, (c) => ({ ...c, quick: true }));
    if (q) Object.assign(card, q);
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
  if (!card.project) {
    void runProjectInference(opts, card.id).catch((err) => console.error(`[kanban-loop] inference failed for ${card.id}:`, err?.message || err));
  }
  jsonRes(res, 201, { card: cardSummary(card) });
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

// PATCH /cards/:id — manual gate: Move to a list and/or set editable fields
// (project, goalMode, sliceId, acceptance). CAS against the card's rev so a
// concurrent tick is never silently overwritten. A Move target must be a real
// list id.
async function handlePatchCard(req, res, opts, id) {
  const root = opts.root;
  const body = (await readBody(req)) || {};
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — the write must never use a tampered on-disk id
  const board = await loadBoard(root);
  // D16 lock: a card on an autonomous list is engine-owned — manual moves and
  // edits are rejected in the API (the UI hides the controls too). The engine
  // and the gateway's registration flow pass x-garrison-engine.
  if (isEngineOwned(board, card) && !isEngineRequest(req)) {
    return jsonRes(res, 403, {
      error: "engine-owned",
      message: `Card is on the autonomous list "${card.list}" — it is engine-owned (D16). Wait for the run, or resolve it from needs-attention if it parks.`
    });
  }
  const next = { ...card };
  if (typeof body.list === "string") {
    if (!getList(board, body.list)) return jsonRes(res, 400, { error: `unknown list: ${body.list}` });
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
        message: recovered ? `Recovered: moved ${fromTitle} → ${toTitle}` : `Moved ${fromTitle} → ${toTitle}`
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
    // look for the brief James was asked to write (briefs/<slug>.md — the
    // buildDiscussUrl convention) and link it onto the card if present + not already
    // linked. The card LINKS the brief (FINDING 10); it never inlines it. This keeps
    // the web channel generic — the BOARD does the linking, not the channel — so a
    // brief shows on the card without a manual POST /cards/:id/brief.
    const fromList = getList(board, card.list);
    if (body.list !== card.list && fromList && isInteractive(fromList) && !next.briefPath) {
      // The brief is card-owned + deterministic (<root>/cards/<id>/brief.md). If James
      // wrote it during Discuss, mark it on the card (a root-relative pointer) so the
      // card shows a brief link and the engine folds it into the build.
      const abs = cardBriefFile(kanbanRoot(), card.id);
      if (isReadableFile(abs)) next.briefPath = cardBriefRel(card.id);
    }
  }
  if (typeof body.project === "string") next.project = body.project.trim() || null;
  if (typeof body.goalMode === "boolean") next.goalMode = body.goalMode;
  if (typeof body.sliceId === "string") {
    const s = body.sliceId.trim();
    if (s && !isValidSliceId(s)) return jsonRes(res, 400, { error: "invalid sliceId (no path separators or ..)" });
    next.sliceId = s || null;
  }
  if (typeof body.acceptance === "string") next.acceptance = body.acceptance;
  if (isEngineRequest(req) && body.routeEvidence) {
    const event = quickRouteEvent(body.routeEvidence);
    if (event) {
      next.events = withEvent(next, event);
      if (event.detail) next.lastReply = event.detail;
    }
  }
  const expectedRev = Number.isInteger(body.rev) ? body.rev : (card.rev ?? 0);
  const result = await saveCardCAS(root, next, expectedRev);
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
  // doorway drives itself. A James-mode discuss card (no gate marker) still just
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
  const autoDispatch =
    movedToGatedDiscuss ||
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
  jsonRes(res, 200, { card: cardSummary(result.card) });
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
  if (await deleteCard(opts.root, id)) removed.push(`cards/${id}`);

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

  // Persist the descriptor durably as run evidence (best-effort — the card copy below
  // is the authoritative one the UI and /revert read).
  if (card.runDir) {
    try { await atomicWriteJSON(preparedRevertFile(card.runDir), descriptor); }
    catch { /* evidence best-effort */ }
  }

  // Release the card's outward coordination holds. Both are safe on a null repo.
  try { removeCardIntents({ repoPath, cardId: id }); } catch { /* best-effort */ }
  try { releaseLeases({ repoPath, cardId: id }); } catch { /* best-effort */ }

  const n = descriptor.commits.length;
  const reason = `Abandoned - prepared revert of ${n} commit${n === 1 ? "" : "s"} ready; confirm to apply`;
  const updated = await updateCard(root, id, (c) => ({
    ...c,
    // Park it in needs-attention (a real list move). Preserve an existing parkedFrom
    // when the card was ALREADY parked (don't overwrite it with needs-attention).
    ...parkFields(c, c.list === ATTENTION_LIST ? undefined : c.list, reason),
    abandoned: true,
    preparedRevert: descriptor,
    // An abandoned card is no longer waiting on anyone — drop its own wait if it had one.
    waitingOn: null,
    events: withEvent(c, {
      at,
      kind: "coordination",
      message: `Abandoned by request - prepared revert of ${n} commit(s) ready to apply`,
      detail: descriptor.commits.length ? descriptor.commits.map((s) => String(s).slice(0, 10)).join("\n") : null
    })
  }));
  if (!updated) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(card) });
  return jsonRes(res, 200, { card: cardSummary(updated), preparedRevert: cardSummary(updated).preparedRevert });
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

// POST /cards/:id/brief — record the James-mode Discuss brief PATH onto the card
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
async function handleStartCard(req, res, opts, id) {
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — saveCardCAS/processCard write under this id
  const board = await loadBoard(root);
  const list = getList(board, card.list);
  if (!list) return jsonRes(res, 400, { error: `card on unknown list: ${card.list}` });

  // Coordination override (GARRISON-FLOW-V2 S1, Q4): a manual Start on a card that
  // is WAITING behind an overlapping run is a DELIBERATE escape hatch. Clear the
  // wait (recording it honestly on the timeline) before dispatching — there is no
  // separate override endpoint; the button press IS the override.
  if (card.waitingOn) {
    const w = card.waitingOn;
    const cleared = await updateCard(root, id, (c) => (c.waitingOn ? ({
      ...c,
      waitingOn: null,
      events: withEvent(c, {
        at: new Date().toISOString(),
        kind: "coordination",
        message: `Wait overridden manually (was waiting on ${w.cardTitle || w.cardId})`,
        detail: w.reason || null
      })
    }) : null));
    if (cleared) { card = cleared; card.id = id; }
  }

  // An INTERACTIVE list (Discuss) advances ONLY by a manual Move (PATCH) — never
  // by Start/Advance (brief decision 8: the advance is manual). Reject it here so
  // a Start cannot skip the brief-to-disk hand-off. EXCEPTION (S3d): a clarity-gated
  // discuss card runs the discuss duty as a real session, so Start dispatches it
  // like any agent list; a James-mode discuss card (no gate marker) stays manual.
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
    const recover = recovering ? unparkRecoveryFields(card) : {};
    const fromTitle = list.title || card.list;
    const toTitle = getList(board, target)?.title || target;
    let events = withEvent(card, {
      at: new Date().toISOString(),
      kind: recovering ? "recovered" : "moved",
      message: recovering ? `Recovered: advanced ${fromTitle} → ${toTitle}` : `Advanced ${fromTitle} → ${toTitle}`
    });
    if (recovering && card.retryKeepsContext) {
      events = withEvent({ events }, {
        at: new Date().toISOString(),
        kind: "retry-keeps-context",
        message: "Retry preserves prior context (phase runDir + iteration logs kept)"
      });
    }
    const next = { ...card, list: target, status: "ok", events, ...recover };
    const result = await saveCardCAS(root, next, card.rev ?? 0);
    if (!result.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(result.card) });
    // If we advanced onto an immediate agent list, kick the automated flow.
    if (shouldAutoDispatch(board, target) && opts.gatewayUrl && (await gatewayReachable(opts.gatewayUrl))) {
      void processChain({ root, board, card: result.card, runFn: gatewayRunFn(opts.gatewayUrl), cap: opts.cap, cwd: opts.cwd, onDutyBoundary: compactBoundaryFn(opts.gatewayUrl) })
        .catch((err) => console.error(`[kanban-loop] advance-chain failed for ${id}:`, err?.message || err));
    }
    return jsonRes(res, 200, { card: cardSummary(result.card), advanced: target });
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
  // dispatch — the same choke the tick applies. A waiting card already had its wait
  // cleared above (Start is the override), so this only guards the degraded fallback.
  {
    const coordCfg = coordinationConfig(loadPolicy());
    if (coordCfg.enabled && coordCfg.serializeWhenUnavailable && !coordinationAvailability().ok) {
      const allCards = await loadAllCards(root);
      const gate = serializeGate(allCards, card, board);
      if (!gate.allowed) return jsonRes(res, 409, { error: gate.reason, card: cardSummary(card) });
    }
  }
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
    void processBatch({ root, board, listId: card.list, cards: projectCards, batchRunFn: batchGatewayRunFn(gatewayUrl), cap, cwd: opts.cwd })
      .catch((err) => console.error(`[kanban-loop] start/batch failed for ${id}:`, err?.message || err));
    return jsonRes(res, 200, { card: cardSummary({ ...card, status: "running" }), dispatched: true, batched: true });
  }

  // Run the AUTOMATED FLOW fire-and-forget (a real chain is minutes long — never block
  // the HTTP response on it). The card flips to running and is watchable; the response
  // returns at once. This is the manual Run / Retry path (the UI shows it on any agent
  // list card that isn't already running; immediate agent lists also auto-run on entry).
  void processChain({ root, board, card, runFn: gatewayRunFn(gatewayUrl), cap, cwd: opts.cwd, onDutyBoundary: compactBoundaryFn(gatewayUrl) })
    .catch((err) => console.error(`[kanban-loop] start/chain failed for ${id}:`, err?.message || err));
  jsonRes(res, 200, { card: cardSummary({ ...card, status: "running" }), dispatched: true });
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

  const n = latestCardLogNumber(root, card);
  const live = card.status === "running" && n > 0;
  const logFile = path.join(root, "cards", id, `log-${n}.md`);

  if (!live) {
    // Nothing running: replay every linked static log, then close. (link-never-
    // duplicate: these are the card's own log-N.md files, read in place.)
    send("mode", { live: false, status: card.status ?? "ok" });
    for (let i = 1; i <= n; i++) {
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

// GET /cards/:id/session-stream?i=<n> — SSE rich-Log tail of the card's Nth
// Claude Code session transcript (~/.claude/projects/<encoded-cwd>/<sid>.jsonl,
// resolved server-side from the card's OWN sessionIds via the `session:<i>` ref).
// For a RUNNING card it tails new transcript lines live; otherwise it emits the
// current transcript once and ends. Drill-compatible framing: default `message`
// events with a JSON `data` payload ({type:init|events|end}).
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

async function handleSessionStream(req, res, opts, id, i) {
  if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin session read rejected" });
  let card;
  try { card = await loadCard(opts.root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — the session ref must not trust a tampered on-disk id

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
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

  // Resolve the transcript path from the card's own pointers, then confine it.
  // Primary: the cwd-encoded path (resolveArtifactRef). Fallback: glob the session
  // id across every ~/.claude/projects/* dir, which is robust to the operative's cwd
  // (agent-sdk journals under the composition dir, not the board's projectRoot()).
  let absPath = resolveArtifactRef(card, `session:${i}`, { root: opts.root, cwd: opts.cwd });
  if (!absPath || !isReadableFile(absPath)) {
    const sid = (Array.isArray(card.sessionIds) ? card.sessionIds : [])[i];
    const globbed = findTranscriptBySession(sid);
    if (globbed) absPath = globbed;
  }
  const confined = absPath ? confinePath(absPath, allowedRoots(opts.cwd, opts.root)) : null;
  if (!confined || !isReadableFile(confined)) {
    // No resolvable transcript (stale/rotated session, or the operative ran under
    // a different cwd than the board resolves against) → the UI falls back to Raw.
    emit({ type: "init", i, title: null, available: false, live: false, events: [] });
    return finish();
  }

  try {
    let read = await readJsonlLines(confined, 0);
    let offset = read.offset;
    const parsed = parseTranscriptLines(read.lines);
    emit({
      type: "init",
      i,
      title: parsed.title,
      events: parsed.events,
      live: card.status === "running",
      available: true
    });
    // Live tail: only while the card is still running. Re-load the card each tick
    // (like handleWatchCard) so a run finishing stops the tail promptly.
    while (!closed && card.status === "running") {
      await new Promise((r) => setTimeout(r, 800));
      if (closed) break;
      try {
        read = await readJsonlLines(confined, offset);
        if (read.lines.length) {
          offset = read.offset;
          const chunk = parseTranscriptLines(read.lines);
          if (chunk.events.length || chunk.title) {
            emit({ type: "events", i, title: chunk.title, events: chunk.events });
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
// project picker. Returns { devRoot, projects:[{name,path}] }. Read-only + best-effort:
// a missing dev-root just yields an empty list (the UI still offers a custom path).
function handleProjects(req, res) {
  const devRoot = readDevRoot();
  let projects = [];
  try { projects = listProjects(devRoot); } catch { projects = []; }
  jsonRes(res, 200, { devRoot, projects });
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
  // same file James writes and the engine reads. Deterministic; no project-dir guessing.
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
    host: process.env.GARRISON_KANBANLOOP_BIND_HOST || process.env.KANBAN_UI_HOST || "127.0.0.1",
    root: kanbanRoot(),
    cwd: projectRoot(),
    // Default to the gateway's conventional URL (like the web channel) so the board can
    // dispatch agent-list runs even when GARRISON_GATEWAY_URL isn't explicitly injected.
    // The runner injects the live URL; this default covers the common :24777 gateway.
    gatewayUrl:
      process.env.GARRISON_GATEWAY_URL ||
      `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "24777"}`,
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
      // GET /policy — read-only passthrough of the compiled Orchestrator policy
      // (work kinds, phase plans, skill bindings) so the card-create UI can
      // offer work kinds + per-card phase toggles (D17). 404 when Garrison has
      // not compiled one yet; the UI degrades to plain creation.
      if (pathname === "/policy" && method === "GET") {
        const policy = loadPolicy();
        if (!policy) return jsonRes(res, 404, { error: "no compiled policy (start Garrison / the Orchestrator fitting)" });
        return jsonRes(res, 200, {
          workKinds: policy.workKinds || {},
          phasePlans: policy.phasePlans || {},
          defaultWorkKind: policy.defaultWorkKind || null,
          phases: policy.phases || [],
          phaseSkills: policy.phaseSkills || { bindings: {}, overrides: {} }
        });
      }
      if (pathname === "/projects" && method === "GET") return await handleProjects(req, res);
      if (pathname === "/skills" && method === "GET") return await handleSkills(req, res);
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

      // GET /origins/:originId[/events] (S3e) - the durable per-origin event log +
      // record, for PULL delivery (skill/terminal sessions poll_origin_events). The id
      // is sanitised by safeOriginId before it touches the store (no traversal).
      const originMatch = pathname.match(/^\/origins\/([^/]+)(\/events)?$/);
      if (originMatch && method === "GET") {
        const originId = decodeURIComponent(originMatch[1]);
        if (originMatch[2] === "/events") return await handleGetOriginEvents(req, res, opts, originId, parsed.query);
        return await handleGetOrigin(req, res, opts, originId);
      }

      // Any /cards/:id route: decode + VALIDATE the id (a clean ULID) before it can
      // reach the filesystem, so an encoded `..%2f` id cannot traverse out of the
      // board root via loadCard/saveCardCAS/appendCardLog.
      const idMatch = pathname.match(/^\/cards\/([^/]+)(\/artifact|\/attachment|\/session-stream|\/start|\/watch|\/brief|\/infer-project|\/abandon|\/revert|\/handoff|\/steer)?$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const sub = idMatch[2] || "";
        if (!isValidCardId(id)) return jsonRes(res, 400, { error: "invalid card id" });
        if (sub === "/artifact" && method === "GET") return await handleArtifact(req, res, opts, id, parsed.query.ref);
        if (sub === "/artifact" && method === "PUT") return await handleArtifactWrite(req, res, opts, id, parsed.query.ref);
        if (sub === "/attachment" && method === "GET") return await handleAttachment(req, res, opts, id, parsed.query.i);
        if (sub === "/session-stream" && method === "GET") return await handleSessionStream(req, res, opts, id, Number(parsed.query.i ?? 0));
        if (sub === "/start" && method === "POST") return await handleStartCard(req, res, opts, id);
        if (sub === "/abandon" && method === "POST") return await handleAbandonCard(req, res, opts, id);
        if (sub === "/revert" && method === "POST") return await handleRevertCard(req, res, opts, id);
        if (sub === "/brief" && method === "POST") return await handleBriefCard(req, res, opts, id);
        if (sub === "/infer-project" && method === "POST") return await handleInferProject(req, res, opts, id);
        if (sub === "/watch" && method === "GET") return await handleWatchCard(req, res, opts, id);
        if (sub === "/handoff" && method === "GET") return await handleGetHandoff(req, res, opts, id);
        if (sub === "/steer" && method === "POST") return await handleSteerCard(req, res, opts, id);
        if (sub === "" && method === "GET") return await handleGetCard(req, res, opts, id);
        if (sub === "" && method === "PATCH") return await handlePatchCard(req, res, opts, id);
        if (sub === "" && method === "DELETE") return await handleDeleteCard(req, res, opts, id);
      }

      return serveStatic(req, res, distDir);
    } catch (err) {
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
        const rec = spawnPty({ id: msg.sessionId, cwd: cardWorkdir(card, liveOpts) });
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
