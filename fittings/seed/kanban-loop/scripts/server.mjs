#!/usr/bin/env node
// Kanban Loop own-port server (V1b, port 7089). Serves the responsive,
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
// Scaffolding (findFreePort, status-file registration under
// ~/.garrison/ui-fittings/<id>.json, CORS, static dist/ serve, graceful
// shutdown) follows the dev-env / web-channel own-port precedent. The pure
// request helpers (buildBoardView, resolveCardLinks, the path-confinement guard,
// isReadableFile) are EXPORTED so tests/kanban-board-ui.test.ts can unit-test
// them without a live socket.

import { createReadStream, existsSync, statSync, accessSync, realpathSync, readFileSync, readdirSync, constants as fsConstants } from "node:fs";
import { mkdir, readFile, unlink, writeFile, rm } from "node:fs/promises";
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
  cardBriefFile,
  cardBriefRel
} from "../lib/board.mjs";
import {
  getList,
  validNextFor,
  processCard,
  processChain,
  processBatch,
  triggerFor,
  isInteractive,
  withEvent,
  replySnippet
} from "../lib/engine.mjs";
import { batchGatewayRunFn } from "./kanban.mjs";
import { recordBrief, briefRelPath } from "./discuss.mjs";
import { gatewayRunFn, inferenceRunFn } from "../lib/gateway-client.mjs";
import { inferProject } from "../lib/infer-project.mjs";
import { loadPolicy } from "../lib/policy.mjs";
import { listProjects, readDevRoot, listSkills } from "../lib/discover.mjs";
import { syncListBeat } from "../lib/scheduler-beats.mjs";
import { claudeProjectDirForCwd, claudeProjectsDir } from "@garrison/claude-pty";

const FITTING_ID = "kanban-loop";
const DEFAULT_PORT = 7089;
const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);

// The working directory Kanban runs operatives in. runDir pointers are
// project-relative (docs/autothing/runs/<runId>), and the Claude Code transcript
// for a session is keyed by the encoded cwd, so both resolve against this root.
// Overridable for tests / non-default checkouts.
function projectRoot() {
  return process.env.GARRISON_KANBAN_PROJECT_ROOT || process.cwd();
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
    // The last dispatch failure (set by engine.processCard on transport defer
    // or run-failed, and by handlePatchCard when an auto-dispatch can't reach
    // the gateway). The UI renders a clear badge + Retry button when this is
    // non-null. A successful dispatch clears it back to null.
    lastDispatchError: card.lastDispatchError ?? null,
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

// The last few non-empty lines of a running card's current iteration log — the live
// "tail" the card front shows so you can see the operative WORKING without opening
// Watch. Best-effort + bounded: a missing/short log just yields "".
function liveTailFor(root, card, maxLines = 3, maxChars = 240) {
  try {
    const n = card.iterations ?? 0;
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
  for (let n = 1; n <= (card.iterations ?? 0); n++) {
    links.logs.push({ n, ...mk(`log:${n}`) });
  }
  return links;
}

// resolveArtifactRef — the READ side. Given a card and an OPAQUE ref token, derive
// the absolute path from the card's OWN stored pointers (NEVER from client input),
// or null for an unknown/out-of-range ref. handleArtifact then confines + serves
// it, so a client (which only ever names a card id + a fixed ref token) can read
// ONLY the specific files THIS card points to — not an arbitrary absolute path.
export function resolveArtifactRef(card, ref, { root = kanbanRoot(), cwd = projectRoot() } = {}) {
  if (!card || typeof ref !== "string") return null;
  if (ref === "plan") return card.runDir ? path.resolve(cwd, card.runDir, "FLOW_PLAN.md") : null;
  // Card-scoped: each card mints its own runId, so the per-run evidence index lives
  // under THIS card's run dir — not the shared project-global docs/autothing one.
  if (ref === "evidenceIndex") return card.runDir ? path.resolve(cwd, card.runDir, "evidence-index.json") : null;
  if (ref === "gateMarkers") {
    // sliceId is client-editable → reject any value with separators/`..` so the
    // read stays inside THIS card's run dir (a bad sliceId yields no ref).
    return card.runDir && isValidSliceId(card.sliceId)
      ? path.resolve(cwd, card.runDir, "slices", card.sliceId, "gate-status.json")
      : null;
  }
  if (ref === "brief") {
    // A legacy explicit briefPath (project-relative, e.g. briefs/<slug>.md) resolves
    // against the project root; the card-owned marker (cards/<id>/brief.md — kanban-root
    // relative) and the no-briefPath default both resolve to the deterministic
    // card-owned file under the board root.
    return card.briefPath && card.briefPath !== cardBriefRel(card.id)
      ? path.resolve(cwd, card.briefPath)
      : cardBriefFile(root, card.id);
  }
  // evidence:<filename> → <runDir>/evidence/<filename>. The name is guarded
  // (isSafeEvidenceName: no separators, no `..`, no leading dot) so the read stays inside
  // THIS card's evidence dir; handleArtifact re-confines the resolved path as well.
  const em = ref.match(/^evidence:(.+)$/);
  if (em) {
    return card.runDir && isSafeEvidenceName(em[1])
      ? path.resolve(cwd, card.runDir, "evidence", em[1])
      : null;
  }
  const sm = ref.match(/^session:(\d+)$/);
  if (sm) {
    const sid = (Array.isArray(card.sessionIds) ? card.sessionIds : [])[Number(sm[1])];
    return sid ? path.join(claudeProjectDirForCwd(cwd), `${sid}.jsonl`) : null;
  }
  const lm = ref.match(/^log:(\d+)$/);
  if (lm) {
    const n = Number(lm[1]);
    return n >= 1 && n <= (card.iterations ?? 0) ? path.join(root, "cards", card.id, `log-${n}.md`) : null;
  }
  return null;
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

// A slice id is client-editable (PATCH) and flows into the gate-marker path
// (<runDir>/slices/<sliceId>/gate-status.json), so it MUST NOT contain path
// separators or `..`. Restrict to a safe filename grammar — a `/` or `..` would
// otherwise steer the read to another run's (or any) gate-status.json file.
export function isValidSliceId(s) {
  return typeof s === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(s) && s !== "." && s !== "..";
}

// An evidence file name (under <runDir>/evidence/) flows into a served path, so it MUST
// be a plain filename — no separators, no `..`, no leading dot. The first-char class
// rejects ".", "..", and ".hidden"; the body allows only filename-safe chars, so a `/`
// or `\` can never appear. Belt-and-suspenders: confinePath re-checks the resolved path.
export function isSafeEvidenceName(s) {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..");
}

// The image extensions the Evidence section renders inline as a thumbnail (everything
// else — e.g. evidence.md / a .txt log — is surfaced as a link). SVG is deliberately
// EXCLUDED: an SVG can carry script, and serving it as a navigable image/svg+xml
// document on the board origin is a stored-XSS vector — evidence SVGs are served as an
// inert download instead (see handleArtifact), so they never render inline.
const EVIDENCE_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export function isEvidenceImage(name) {
  return EVIDENCE_IMAGE_EXT.has(path.extname(String(name || "")).toLowerCase());
}

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
  for (const c of cards) {
    if (c.status === "running") tails[c.id] = liveTailFor(root, c);
  }
  const patch = (cs) => { if (cs && tails[cs.id]) cs.liveTail = tails[cs.id]; };
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
  const card = await createCard(opts.root, {
    title,
    description,
    project: typeof body.project === "string" && body.project.trim() ? body.project.trim() : null,
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
    outpost: typeof body.outpost === "string" && body.outpost.trim() ? body.outpost.trim() : null
  });
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
function isEngineRequest(req) {
  return typeof req.headers["x-garrison-engine"] === "string" && req.headers["x-garrison-engine"].length > 0;
}

// D16: cards on autonomous (agent-kind) lists are ENGINE-OWNED — the board API
// rejects manual moves and edits on them. needs-attention is the one human
// touchpoint on the autonomous side; interactive + manual lists stay editable.
function isEngineOwned(board, card) {
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
    // Recovery: moving a card OUT of the needs-attention column is a fresh retry —
    // clear the park reason + the prior dispatch error and reset the iteration count
    // so a re-run isn't instantly re-capped (otherwise an iteration-cap park would
    // re-park on the very next run).
    if (card.list === "needs-attention" && body.list !== "needs-attention") {
      next.attentionReason = null;
      next.parkedFrom = null;
      next.lastDispatchError = null;
      next.iterations = 0;
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
  const expectedRev = Number.isInteger(body.rev) ? body.rev : (card.rev ?? 0);
  const result = await saveCardCAS(root, next, expectedRev);
  if (!result.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(result.card) });

  // "Moving to Plan starts planning": when the card is MOVED onto an immediate agent
  // list, dispatch its run now (fire-and-forget — the run goes through the gateway in
  // the background, the card flips to `running` and is watchable; the PATCH returns at
  // once). A manual / interactive (Discuss) / scheduler-beat (Test) target just moves.
  const autoDispatch = typeof body.list === "string" && shouldAutoDispatch(board, body.list);
  if (autoDispatch && opts.gatewayUrl) {
    if (await gatewayReachable(opts.gatewayUrl)) {
      // processChain runs the AUTOMATED FLOW: this list, then the next immediate
      // agent list, and so on (Plan → Implement → Review → …) without waiting for a
      // Start press or the next tick. Fire-and-forget — the card flips to running and
      // is watchable; the PATCH returns at once.
      void processChain({ root, board, card: result.card, runFn: gatewayRunFn(opts.gatewayUrl), cap: opts.cap, cwd: opts.cwd })
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
//     runs dir so it can never delete an unrelated/timestamped autothing run;
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

  // An INTERACTIVE list (Discuss) advances ONLY by a manual Move (PATCH) — never
  // by Start/Advance (brief decision 8: the advance is manual). Reject it here so
  // a Start cannot skip the brief-to-disk hand-off.
  if (isInteractive(list)) {
    return jsonRes(res, 400, {
      error: "interactive list (Discuss) advances by manual Move, not Start — open the web chat, then Move when ready"
    });
  }

  // Manual column: Start just advances to the first valid next (the "move a card
  // out of a manual column" path — Backlog/To Do/Done/needs-attention).
  if (list.kind !== "agent") {
    const targets = validNextFor(board, card.list);
    if (!targets.length) return jsonRes(res, 400, { error: `nothing to advance to from ${card.list}` });
    const recover = card.list === "needs-attention"
      ? { attentionReason: null, parkedFrom: null, lastDispatchError: null, iterations: 0 }
      : {};
    const fromTitle = list.title || card.list;
    const toTitle = getList(board, targets[0])?.title || targets[0];
    const advanceEvent = withEvent(card, {
      at: new Date().toISOString(),
      kind: card.list === "needs-attention" ? "recovered" : "moved",
      message: card.list === "needs-attention" ? `Recovered: advanced ${fromTitle} → ${toTitle}` : `Advanced ${fromTitle} → ${toTitle}`
    });
    const next = { ...card, list: targets[0], status: "ok", events: advanceEvent, ...recover };
    const result = await saveCardCAS(root, next, card.rev ?? 0);
    if (!result.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(result.card) });
    // If we advanced onto an immediate agent list, kick the automated flow.
    if (shouldAutoDispatch(board, targets[0]) && opts.gatewayUrl && (await gatewayReachable(opts.gatewayUrl))) {
      void processChain({ root, board, card: result.card, runFn: gatewayRunFn(opts.gatewayUrl), cap: opts.cap, cwd: opts.cwd })
        .catch((err) => console.error(`[kanban-loop] advance-chain failed for ${id}:`, err?.message || err));
    }
    return jsonRes(res, 200, { card: cardSummary(result.card), advanced: targets[0] });
  }

  // Agent list: dispatch through the engine. Requires a LIVE gateway — PING it first
  // so an explicit Start while no operative is up returns a clear 503 (telling the
  // user to start an operative) instead of firing a doomed run that parks the card.
  const gatewayUrl = opts.gatewayUrl;
  if (!gatewayUrl || !(await gatewayReachable(gatewayUrl))) {
    return jsonRes(res, 503, { error: "gateway not reachable — start an operative (composition up) before dispatching an agent list" });
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
  void processChain({ root, board, card, runFn: gatewayRunFn(gatewayUrl), cap, cwd: opts.cwd })
    .catch((err) => console.error(`[kanban-loop] start/chain failed for ${id}:`, err?.message || err));
  jsonRes(res, 200, { card: cardSummary({ ...card, status: "running" }), dispatched: true });
}

// Dispatch goes through the shared, transport-aware gateway client (lib/gateway-client.mjs)
// so the board + the scheduler tick use one wire shape + one failure classification (a
// transient gateway failure must REVERT a card, not park it).

// GET /cards/:id/watch — SSE. For a LIVE run (card.status === "running") it tails
// the latest log-<iterations>.md as it grows; otherwise it sends the linked
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

  const live = card.status === "running" && (card.iterations ?? 0) > 0;
  const n = card.iterations ?? 0;
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
  // Defense-in-depth for served artifacts (evidence files are "whatever the operative
  // wrote", and the operative processes untrusted repos/pages — so treat them as
  // untrusted content): never let the browser sniff a different type, and fully sandbox
  // the response if it is ever navigated to as a document (no script, no network).
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

async function findFreePort(startPort) {
  const net = await import("node:net");
  for (let port = startPort; port < startPort + 50; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    route: "/board",
    views: [{ id: "board", title: "Kanban", route: "/board" }]
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

function parseArgs(argv) {
  const out = {
    port: Number(process.env.KANBAN_UI_PORT || DEFAULT_PORT),
    host: process.env.KANBAN_UI_HOST || "127.0.0.1",
    root: kanbanRoot(),
    cwd: projectRoot(),
    // Default to the gateway's conventional URL (like the web channel) so the board can
    // dispatch agent-list runs even when GARRISON_GATEWAY_URL isn't explicitly injected.
    // The runner injects the live URL; this default covers the common :4777 gateway.
    gatewayUrl:
      process.env.GARRISON_GATEWAY_URL ||
      `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "4777"}`,
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

      if (pathname === "/health") return handleHealth(req, res, opts);
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
      if (pathname === "/projects" && method === "GET") return handleProjects(req, res);
      if (pathname === "/skills" && method === "GET") return handleSkills(req, res);
      if (pathname === "/cards" && method === "POST") return await handleCreateCard(req, res, opts);

      // PATCH /lists/:listId — configure a list. Validate the id (clean kebab,
      // no traversal) before it reaches the board.
      const listMatch = pathname.match(/^\/lists\/([^/]+)$/);
      if (listMatch && method === "PATCH") {
        const listId = decodeURIComponent(listMatch[1]);
        if (!isValidListId(listId)) return jsonRes(res, 400, { error: "invalid list id" });
        return await handlePatchList(req, res, opts, listId);
      }

      // Any /cards/:id route: decode + VALIDATE the id (a clean ULID) before it can
      // reach the filesystem, so an encoded `..%2f` id cannot traverse out of the
      // board root via loadCard/saveCardCAS/appendCardLog.
      const idMatch = pathname.match(/^\/cards\/([^/]+)(\/artifact|\/start|\/watch|\/brief|\/infer-project)?$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const sub = idMatch[2] || "";
        if (!isValidCardId(id)) return jsonRes(res, 400, { error: "invalid card id" });
        if (sub === "/artifact" && method === "GET") return await handleArtifact(req, res, opts, id, parsed.query.ref);
        if (sub === "/artifact" && method === "PUT") return await handleArtifactWrite(req, res, opts, id, parsed.query.ref);
        if (sub === "/start" && method === "POST") return await handleStartCard(req, res, opts, id);
        if (sub === "/brief" && method === "POST") return await handleBriefCard(req, res, opts, id);
        if (sub === "/infer-project" && method === "POST") return await handleInferProject(req, res, opts, id);
        if (sub === "/watch" && method === "GET") return await handleWatchCard(req, res, opts, id);
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
  const free = await findFreePort(opts.port);
  if (free === null) { console.error(`[kanban-loop] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };
  if (free !== opts.port) {
    console.warn(`[kanban-loop] requested port ${opts.port} busy — using ${free}`);
  }

  const server = http.createServer(makeRequestHandler(liveOpts, distDir));

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
