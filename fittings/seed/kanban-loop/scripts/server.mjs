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

import { createReadStream, existsSync, statSync, accessSync, realpathSync, constants as fsConstants } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  deriveMembership,
  appendCardLog
} from "../lib/board.mjs";
import {
  getList,
  validNextFor,
  processCard,
  triggerFor,
  isInteractive
} from "../lib/engine.mjs";
import { recordBrief, briefRelPath } from "./discuss.mjs";
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
      skill: list.skill ?? null,
      taskType: list.taskType ?? null,
      tier: list.tier ?? null,
      mode: list.mode ?? null,
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
    updated: card.updated ?? null
  };
}

// The decision-10 links for a card (the v4 wireframe §2 "Card open" table). Each
// is a POINTER, not a copy: a `serve` path (the server's /artifact?path= route,
// for files it can read) or an external `href` (videoUrl). The transcript path
// is resolved from the sessionId via claudeProjectDirForCwd (FINDING:
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl). `root` defaults to the
// kanban board root (where cards/<id>/log-N.md live); `cwd` is the project root
// the run + transcript resolve against.
// The roots an artifact path may live under: the project root (plan/gate/brief),
// the board root (per-card logs), and the Claude Code projects dir (session
// transcripts). A served path must be inside ONE of these — the read side
// (handleArtifact) re-confines against the SAME set.
export function allowedRoots(cwd = projectRoot(), root = kanbanRoot()) {
  return [cwd, root, claudeProjectsDir()];
}

export function resolveCardLinks(card, { root = kanbanRoot(), cwd = projectRoot() } = {}) {
  const roots = allowedRoots(cwd, root);
  const mk = (ref) => serveRef(card.id, ref, resolveArtifactRef(card, ref, { root, cwd }), roots);
  const links = {
    plan: null,
    brief: null,
    gateMarkers: null,
    evidenceIndex: null,
    sessions: [],
    video: null,
    logs: []
  };
  if (card.runDir) {
    links.plan = mk("plan");
    links.evidenceIndex = mk("evidenceIndex");
    if (card.sliceId) links.gateMarkers = mk("gateMarkers");
  }
  if (card.briefPath) links.brief = mk("brief");
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
  if (ref === "brief") return card.briefPath ? path.resolve(cwd, card.briefPath) : null;
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

// A list id is client-editable (PATCH /lists/:listId) and flows into a board
// lookup, so it MUST be a clean kebab token — no path separators or `..`. The
// list id never touches the filesystem directly (the board is one file), but the
// guard keeps the route surface uniform with the card-id guard and rejects junk
// before it reaches applyListConfig.
export function isValidListId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(s) && s.length <= 64;
}

// A single-line free-string field (taskType, tier): reject newlines and path
// separators so a value can't carry traversal/injection into a downstream prompt
// or path. Empty/whitespace collapses to null.
function cleanScalarField(v) {
  if (v == null) return { value: null };
  if (typeof v !== "string") return { error: "must be a string or null" };
  const s = v.trim();
  if (!s) return { value: null };
  if (/[\n\r\t/\\]/.test(s) || s.includes("..")) {
    return { error: "must not contain newlines, path separators or .." };
  }
  return { value: s };
}

// A skill name token: a clean skill id (e.g. autothing-plan, plugin:skill) or
// null. No whitespace / separators / `..` — it is forwarded to the gateway as a
// skill hint and must not carry traversal or shell-ish junk.
function cleanSkillField(v) {
  if (v == null) return { value: null };
  if (typeof v !== "string") return { error: "skill must be a string or null" };
  const s = v.trim();
  if (!s) return { value: null };
  if (!/^[a-z0-9][a-z0-9:-]*$/i.test(s)) {
    return { error: "skill must be a clean skill-name token" };
  }
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

// The triggers a list may carry (engine.triggerFor honors these). Editing is
// restricted to this set so a typo can't silently turn an agent list into a
// never-firing column.
const VALID_TRIGGERS = new Set(["immediate", "manual", "scheduler-beat"]);

// The fields a MANUAL / terminal list (kind "manual") may edit — it has no
// agent behavior, so only its label + routing are configurable.
const MANUAL_EDITABLE = new Set(["title", "validNext"]);
// The agent-only fields a manual list must NEVER accept (rejected with a clear
// error rather than silently ignored, so the UI can't half-configure a column).
const AGENT_ONLY_FIELDS = ["skill", "executePrompt", "routerPrompt", "trigger", "mode", "taskType", "tier"];

// applyListConfig — the pure list-config updater. Reads `listId` from `board`,
// applies ONLY the editable fields PRESENT in `patch`, validates each, and
// returns { board, list } (a NEW board object, never mutating the input) or
// { error }. Structure (id / order / kind) is never touched. Editability is
// gated by the list's kind:
//   - manual: only title + validNext (agent-only fields are REJECTED).
//   - agent-interactive (Discuss): editable like an agent list but interactive
//     stays true and mode is kept (its trigger stays manual unless explicitly set).
//   - agent: title, skill, executePrompt, routerPrompt, validNext, trigger,
//     mode, taskType, tier.
// validNext must be a subset of the board's existing list ids; trigger must be a
// known trigger; taskType/tier reject newlines + path separators; skill must be
// a clean token or null.
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

  if ("skill" in patch) {
    const r = cleanSkillField(patch.skill);
    if (r.error) return { error: `skill: ${r.error}` };
    next.skill = r.value;
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

  if ("mode" in patch) {
    const r = cleanScalarField(patch.mode);
    if (r.error) return { error: `mode: ${r.error}` };
    next.mode = r.value;
  }

  if ("taskType" in patch) {
    const r = cleanScalarField(patch.taskType);
    if (r.error) return { error: `taskType: ${r.error}` };
    next.taskType = r.value;
  }

  if ("tier" in patch) {
    const r = cleanScalarField(patch.tier);
    if (r.error) return { error: `tier: ${r.error}` };
    next.tier = r.value;
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
  jsonRes(res, 200, buildBoardView(board, cards));
}

async function handleGetCard(req, res, opts, id) {
  const root = opts.root;
  let card;
  try { card = await loadCard(root, id); }
  catch { return jsonRes(res, 404, { error: `card not found: ${id}` }); }
  card.id = id; // pin to the validated route id — never trust the on-disk id field
  const links = resolveCardLinks(card, { root, cwd: opts.cwd });
  jsonRes(res, 200, { card: cardSummary(card), links, decisionLog: card.decisionLog ?? card.runs ?? [] });
}

// POST /cards — create a card in Backlog. Body: { title, description?, project?,
// goalMode?, acceptance? }.
async function handleCreateCard(req, res, opts) {
  const body = (await readBody(req)) || {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return jsonRes(res, 400, { error: "title required" });
  const card = await createCard(opts.root, {
    title,
    description: typeof body.description === "string" ? body.description : "",
    project: typeof body.project === "string" && body.project.trim() ? body.project.trim() : null,
    list: "backlog",
    goalMode: body.goalMode === true,
    acceptance: typeof body.acceptance === "string" ? body.acceptance : null
  });
  jsonRes(res, 201, { card: cardSummary(card) });
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
  const next = { ...card };
  if (typeof body.list === "string") {
    if (!getList(board, body.list)) return jsonRes(res, 400, { error: `unknown list: ${body.list}` });
    next.list = body.list;
    next.status = "ok"; // a manual Move clears a parked/needs-attention status
    // Auto-link a Discuss brief: when a card LEAVES the interactive Discuss list,
    // look for the brief James was asked to write (briefs/<slug>.md — the
    // buildDiscussUrl convention) and link it onto the card if present + not already
    // linked. The card LINKS the brief (FINDING 10); it never inlines it. This keeps
    // the web channel generic — the BOARD does the linking, not the channel — so a
    // brief shows on the card without a manual POST /cards/:id/brief.
    const fromList = getList(board, card.list);
    if (body.list !== card.list && fromList && isInteractive(fromList) && !next.briefPath) {
      const briefsPath = opts.briefsPath || process.env.KANBAN_BRIEFS_PATH || "./briefs/";
      const rel = briefRelPath(card, { briefsPath });
      // briefSlug sanitises the title to kebab, so `rel` is traversal-free by
      // construction; confine + existence-check before linking.
      const abs = confinePath(path.resolve(projectRoot(), rel), [projectRoot()]);
      if (abs && isReadableFile(abs)) next.briefPath = rel;
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
      void processCard({ root, board, card: result.card, runFn: gatewayRunFn(opts.gatewayUrl), cap: opts.cap })
        .catch((err) => console.error(`[kanban-loop] auto-dispatch on move failed for ${id}:`, err?.message || err));
      return jsonRes(res, 200, { card: cardSummary(result.card), dispatched: true });
    }
    // Gateway down: the card stays on the target list (already moved, status ok) and
    // WAITS — it dispatches on the next tick or via Start once an operative is up. We
    // do NOT fire a doomed run that would park it in needs-attention just for moving.
    return jsonRes(res, 200, { card: cardSummary(result.card), dispatched: false, note: "gateway not reachable — card waits on this list until an operative is up" });
  }
  jsonRes(res, 200, { card: cardSummary(result.card) });
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
    const next = { ...card, list: targets[0], status: "ok" };
    const result = await saveCardCAS(root, next, card.rev ?? 0);
    if (!result.ok) return jsonRes(res, 409, { error: "card changed under you", card: cardSummary(result.card) });
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
  try {
    const { card: updated, outcome } = await processCard({
      root,
      board,
      card,
      runFn: gatewayRunFn(gatewayUrl),
      cap
    });
    jsonRes(res, 200, { card: cardSummary(updated), outcome });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Dispatch one card's combined prompt through the gateway /chat front door — the
// same wire shape kanban.mjs uses (channel "kanban", classification + skill so
// preRoute honors the {taskType,tier} hint in both gateway modes).
function gatewayRunFn(gatewayUrl) {
  return async ({ prompt, classification, list, suppressContinuations }) => {
    const r = await fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
      body: JSON.stringify({
        channel: "kanban",
        message: prompt,
        classification: classification ?? null,
        skill: list?.skill ?? null,
        suppressContinuations: suppressContinuations ?? true
      })
    });
    if (!r.ok) throw new Error(`kanban dispatch failed: HTTP ${r.status}`);
    const data = await r.json().catch(() => ({}));
    return { reply: data.reply ?? data.text ?? "" };
  };
}

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

  // Live: tail log-<n>.md. Emit what is already there, then poll for growth.
  send("mode", { live: true, status: "running", n });
  let offset = 0;
  const pump = async () => {
    if (!isReadableFile(logFile)) return;
    try {
      const text = await readFile(logFile, "utf8");
      if (text.length > offset) {
        send("log", { n, text: text.slice(offset), append: offset > 0 });
        offset = text.length;
      }
    } catch {}
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
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  createReadStream(confined).pipe(res);
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
      interactive: Boolean(isInteractive(l)),
      terminal: Boolean(l.terminal),
      skill: l.skill ?? null,
      executePrompt: l.executePrompt ?? "",
      routerPrompt: l.routerPrompt ?? "",
      mode: l.mode ?? null,
      taskType: l.taskType ?? null,
      tier: l.tier ?? null,
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
  jsonRes(res, 200, { list: result.list, rev: result.rev });
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, fittingId: FITTING_ID, port: opts.port, pid: process.pid });
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
      if (pathname === "/lists" && method === "GET") return await handleGetLists(req, res, opts);
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
      const idMatch = pathname.match(/^\/cards\/([^/]+)(\/artifact|\/start|\/watch|\/brief)?$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const sub = idMatch[2] || "";
        if (!isValidCardId(id)) return jsonRes(res, 400, { error: "invalid card id" });
        if (sub === "/artifact" && method === "GET") return await handleArtifact(req, res, opts, id, parsed.query.ref);
        if (sub === "/start" && method === "POST") return await handleStartCard(req, res, opts, id);
        if (sub === "/brief" && method === "POST") return await handleBriefCard(req, res, opts, id);
        if (sub === "/watch" && method === "GET") return await handleWatchCard(req, res, opts, id);
        if (sub === "" && method === "GET") return await handleGetCard(req, res, opts, id);
        if (sub === "" && method === "PATCH") return await handlePatchCard(req, res, opts, id);
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
