// Kanban Loop board UI — responsive, phone-first (the v4 wireframe is the spec).
// Lists are columns in a horizontally-scrollable board; each card front shows
// title, project chip, list, iter N/cap, goalMode and the actions:
// Start/Advance · Move · Watch. Clicking the card body opens its detail sheet
// (the decision-10 LINKS: plan, brief, sessions, gate markers, screenshots, video)
// + the small decision log;
// the card LINKS its artifacts, never inlines their bodies (FINDING 10). Watch
// streams the card's log over SSE for a live run, opens the web chat for an
// interactive list (Discuss), or shows the linked static logs when nothing is
// live — it never tmux-attaches (the pooled gateway operative is raw node-pty).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  pointerWithin,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import {
  api,
  type BoardView,
  type BoardRuntime,
  type CardSummary,
  type CardDetail,
  type CardEvent,
  type ChecklistItem,
  type RouteStamp,
  type ListView,
  type ListConfig,
  type ListConfigPatch,
  type ArtifactRef,
  type PolicyView,
  type CardRouting,
  type RouteOptionsView,
  type MachinesView,
  type WaitingOn,
  type DrillStamp
} from "./api";
import {
  PlayIcon,
  MoveIcon,
  WatchIcon,
  PlusIcon,
  CloseIcon,
  LinkIcon,
  GearIcon,
  ActivityIcon,
  SparkIcon,
  ChatIcon,
  TerminalIcon,
  WrenchIcon,
  DrillIcon,
  MailIcon,
  ClockIcon,
  CheckIcon,
  ArchiveIcon,
  UnarchiveIcon,
  BoardMark
} from "./icons";
import { TerminalPane } from "./terminal-pane";
import { rewriteHostUrl } from "./host-rewrite";
import { execBadges } from "./exec-badges";
import { deriveMoveTargets } from "./move-targets";
import { shouldOpenCard } from "./card-click";
// The Discuss URL contract is shared with the server (pure builder, no node
// imports — see scripts/discuss.mjs). The board hands the generic web channel
// the card as an OPAQUE context blob; James (the operative) reads it.
// @ts-expect-error — plain ESM .mjs sibling, no .d.ts; esbuild bundles it.
import { buildDiscussUrl } from "../scripts/discuss.mjs";

const ITERATION_CAP = 10;

// localPort → HTTPS tailnet URL, fetched once from the same-origin /host-map
// endpoint and read by linkifyText below. Module-level (the render is a pure
// function, not a component), with a bumping rev so the first paint's host-rebind
// fallback upgrades to the exact serve URL once the map lands. `onServeMap`
// notifies subscribers (App) to re-render.
let serveMap: Record<number, string> = {};
let serveMapRev = 0;
const serveMapSubs = new Set<() => void>();
let hostMapPromise: Promise<void> | null = null;
function loadHostMap(): Promise<void> {
  if (!hostMapPromise) {
    hostMapPromise = fetch("/host-map")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.map && typeof d.map === "object") {
          serveMap = d.map as Record<number, string>;
          serveMapRev++;
          for (const fn of serveMapSubs) { try { fn(); } catch { /* ignore */ } }
        }
      })
      .catch(() => {});
  }
  return hostMapPromise;
}
function hostCtx() {
  return {
    hostname: typeof window !== "undefined" ? window.location.hostname : "",
    protocol: typeof window !== "undefined" ? window.location.protocol : "",
    serveMap
  };
}

// The known-root substrings that gate a bare absolute path being treated as a
// servable file (so an arbitrary "/etc/passwd" in prose is NOT linkified).
const FILE_PATH_ROOT_HINTS = [".garrison/uploads/", "/runs/", "/evidence/", "/.claude/"];
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
function fileUrl(p: string): string {
  return `/file?path=${encodeURIComponent(p)}`;
}

// Bare http(s) URLs and absolute file paths inside plain-text bodies (e.g. a
// drill fix card carrying evidence links, or a ClaudeChat attachment path) render
// as real links; http(s) URLs are host-rewritten (loopback → the client's
// reachable form) and image file paths render inline. Everything else stays
// literal — the body remains plain text, never markup.
function linkifyText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match an http(s) URL OR an absolute filesystem path (no whitespace). The
  // path branch is gated below on a known root or a file extension.
  const re = /(https?:\/\/[^\s<>"')\]]+)|(\/[^\s<>"'`)\]]+)/g;
  const ctx = hostCtx();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const token = m[0];
    if (m.index > last) parts.push(text.slice(last, m.index));
    last = m.index + token.length;
    if (m[1]) {
      // http(s) URL — rewrite loopback targets to a client-reachable form.
      const href = rewriteHostUrl(token, ctx);
      if (!href) { parts.push(token); continue; } // unreachable (https page, http-only) → literal
      parts.push(
        <a key={m.index} href={href} target="_blank" rel="noopener noreferrer">{token}</a>
      );
      continue;
    }
    // Absolute path — only linkify when it looks like a real servable file:
    // under a known root OR carrying a file extension. No whitespace (the regex
    // already stops at it).
    const p = token;
    const known = FILE_PATH_ROOT_HINTS.some((h) => p.includes(h));
    if (!known && !FILE_EXT_RE.test(p)) { parts.push(token); continue; }
    if (IMG_EXT_RE.test(p)) {
      parts.push(<img key={m.index} className="linkified-img" src={fileUrl(p)} alt={p.split("/").pop() || p} loading="lazy" />);
    } else {
      parts.push(<a key={m.index} href={fileUrl(p)} target="_blank" rel="noopener noreferrer">{p.split("/").pop() || p}</a>);
    }
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Strip the ClaudeChat-appended attachment block ("\n\nAttached file(s):\n- …")
// off a description so the rendered body doesn't duplicate the Attachments
// section. Mirrors the server's parseAttachments header + contiguous-list scan.
function stripAttachmentBlock(description: string): string {
  const idx = description.search(/\n*Attached files?:\n- \//i);
  return idx >= 0 ? description.slice(0, idx).replace(/\s+$/, "") : description;
}

function listClass(list: ListView): string {
  if (list.id === "archived") return "list manual archived";
  if (list.id === "needs-attention") return "list attn";
  if (list.interactive) return "list interactive";
  if (list.phase && list.phase.includes("adversarial")) return "list codex";
  if (list.kind === "agent") return "list agent";
  return "list manual";
}

function dotClass(card: CardSummary): string {
  if (card.status === "running") return "dot run";
  if (card.status === "needs-attention") return "dot attn";
  return "dot ok";
}

// ── time + event helpers (the visibility surface) ────────────────────────────
// A card's creation instant decoded from its ULID (Crockford base32, first 10
// chars are the millisecond timestamp) - shown on every card face so cards
// with similar titles are tellable apart at a glance.
const ULID_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function fmtCardDate(id: string | null | undefined): string | null {
  if (!id || id.length < 10) return null;
  let ts = 0;
  for (const c of id.slice(0, 10).toUpperCase()) {
    const v = ULID_B32.indexOf(c);
    if (v < 0) return null;
    ts = ts * 32 + v;
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

// Decode a ULID's millisecond timestamp (the card's mint instant) - the drag
// layer's fallback ordering value when a card has no explicit position.
function ulidTime(id: string | null | undefined): number {
  if (!id || id.length < 10) return 0;
  let ts = 0;
  for (const c of id.slice(0, 10).toUpperCase()) {
    const v = ULID_B32.indexOf(c);
    if (v < 0) return 0;
    ts = ts * 32 + v;
  }
  return ts;
}

// A card's effective within-list position - EXACTLY the server's cardPosition
// rule (explicit position, else the created instant) so drag midpoints land
// where the next poll will keep them.
function effPos(card: CardSummary): number {
  if (typeof card.position === "number" && Number.isFinite(card.position)) return card.position;
  const t = Date.parse(card.created ?? "");
  if (Number.isFinite(t)) return t;
  return ulidTime(card.id);
}

// Compact schedule label for the card chip: "today 14:30" / "Aug 2 09:00".
function fmtSchedule(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unparseable";
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (sameDay) return `today ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

// Is the card's schedule instant already past (due)? Unparseable counts as due
// so the amber chip surfaces the mistake instead of hiding it.
function scheduleDue(card: CardSummary): boolean {
  if (!card.scheduledFor) return false;
  const t = Date.parse(card.scheduledFor);
  return !Number.isFinite(t) || t <= Date.now();
}

// ISO from a datetime-local input value (local wall time -> instant).
function isoFromLocalInput(value: string): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// datetime-local input value from an ISO instant (for pre-filling the picker).
function localInputFromIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// File -> base64 payload for the JSON-base64 upload wire (same shape as the
// gateway's /attachments).
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read the file"));
    r.onload = () => {
      const s = String(r.result || "");
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(file);
  });
}

// A compact "3m ago" / "just now" relative time for timeline + last-activity lines.
function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// mm:ss (or h:mm:ss) elapsed since an ISO instant — the running timer.
function fmtElapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  let s = Math.max(0, Math.round((Date.now() - t) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A self-ticking elapsed label (updates every second) for a running card, so the live
// "running 1:23" timer advances without re-rendering the whole board.
function Elapsed({ since }: { since: string | null | undefined }): React.ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{fmtElapsed(since)}</>;
}

// Per-event-kind dot colour on the timeline.
function eventDotClass(kind: string): string {
  return `ev-dot ev-${kind || "generic"}`;
}

// ── per-phase runtime/model attribution helpers ───────────────────────────────
// The "who ran it" identity — the model, falling back to the runtime then provider.
function routeWho(r: RouteStamp): string {
  return r.model || r.runtime || r.provider || "";
}

// Requested effort plus honest application status. A missing boolean means the
// gateway could not prove application; false means the runtime explicitly did
// not support/apply it and must never render like a successful setting.
function routeEffort(r: RouteStamp, compact = false): string {
  const effort = (r.effort || "").trim();
  if (!effort) return "";
  if (r.effortApplied === true) return compact ? effort : `effort ${effort} (applied)`;
  if (r.effortApplied === false) return compact ? `${effort} not applied` : `effort ${effort} (not applied)`;
  return compact ? `${effort} unverified` : `effort ${effort} (application unknown)`;
}

// The card-front attribution chip text: "<phase> @ <model>" (e.g. "plan @ opus"),
// dropping the phase when unknown. "" when there is nothing worth showing.
function routeChipText(r: RouteStamp): string {
  const who = routeWho(r);
  if (!who) return "";
  const ph = (r.phase || "").trim();
  const base = ph ? `${ph} @ ${who}` : who;
  const effort = routeEffort(r, true);
  return effort ? `${base} · ${effort}` : base;
}

// The badge row itself. Renders nothing at all when there is no attribution to
// show — an empty row would read as "we know it ran on nothing".
function ExecBadgeRow({ settled, expected }: { settled?: RouteStamp | null; expected?: RouteStamp | null }): React.ReactElement | null {
  const { badges, expected: isExpected } = execBadges(settled, expected);
  if (!badges.length) return null;
  return (
    <div className="cmeta exec-badges">
      {badges.map((b) => (
        <span
          key={b.key}
          className={`chip exec exec-${b.key}${isExpected ? " expected" : ""}`}
          title={isExpected ? `${b.title} (expected — this phase has not run yet)` : b.title}
        >
          <span className="exec-k">{b.label}</span>
          <span className="exec-v">{b.value}</span>
        </span>
      ))}
    </div>
  );
}

// The full-attribution tooltip for the card-front chip.
function routeTitle(r: RouteStamp): string {
  const parts = [
    r.phase ? `phase: ${r.phase}` : null,
    r.runtime ? `runtime: ${r.runtime}` : null,
    r.provider ? `provider: ${r.provider}` : null,
    r.model ? `model: ${r.model}` : null,
    routeEffort(r) || null,
    r.tier ? `tier: ${r.tier}` : null,
    r.targetId ? `route: ${r.targetId}` : null
  ].filter(Boolean);
  return parts.length ? `routed to ${parts.join(", ")}` : "routed";
}

// A compact one-liner for a routed event in the Activity timeline:
// "claude-code/opus · T2-deep · effort high (applied)". "" when no attribution
// fields are present.
function routeLine(r: RouteStamp): string {
  const idPart = [r.runtime || r.provider, r.model].filter(Boolean).join("/");
  return [idPart, r.tier, routeEffort(r)].filter(Boolean).join(" · ");
}

// A short, legible label for the card a wait is blocked on: its title plus the
// last 6 chars of its id (the id tail keeps it unambiguous when titles repeat).
function waitingLabel(w: WaitingOn): string {
  const title = (w.cardTitle || "").trim();
  const short = (w.cardId || "").slice(-6);
  return title ? `${title} (${short})` : short || w.cardId;
}

// The reason clause rendered after "Waiting on <label>: " — grade-aware so each S2
// wait reads truthfully. Overlap waits (medium/heavy) name the grade + the release
// point; an exclusive-lease wait and an interference wait have their own phrasing
// (their release point — "it releases" / "its fix fence" — folded into the clause).
function waitingClause(w: WaitingOn): string {
  const base = w.grade === "lease"
    ? "exclusive lease held, until it releases"
    : w.grade === "interference"
      ? "broken by its commits, until its fix fence"
      : `${w.grade} overlap, until ${w.until}`;
  return `${base}. If that card is parked, this hold stays in place; resume it or explicitly Abandon/Delete it.`;
}

// ── drill handoff (Send to Drill) ────────────────────────────────────────────
// One block, rendered on both the card front and the detail sheet, so a card's
// drill state reads the same wherever you meet it. It is deliberately explicit
// about the IN-FLIGHT states: a plan + run takes minutes to hours, and a card
// that just said "sent" with nothing after it is indistinguishable from one
// where the handoff silently died.

const DRILL_LABEL: Record<string, string> = {
  planning: "Drill: planning the test for this change…",
  running: "Drill: running the checks…",
  passed: "Drill passed",
  // Deliberately not a green "passed": some checks were never answered, so the
  // change is not fully verified and the card must not read as if it were.
  partial: "Drill passed what it could prove",
  failed: "Drill found issues",
  error: "Drill could not finish"
};

function drillChipClass(state: string): string {
  if (state === "passed") return "chip ok";
  if (state === "failed" || state === "error") return "chip attn";
  return "chip";
}

// The Drill run/job link, rewritten for the viewing host: Drill publishes a
// loopback URL in its status file, and this page is usually open over the
// tailnet where 127.0.0.1 is a different machine entirely.
function drillLink(drill: DrillStamp): string | null {
  const raw = drill.runUrl || drill.jobUrl || drill.drillUrl || null;
  if (!raw) return null;
  // "" means the target cannot be reached without mixed content from this page —
  // drop the link rather than render a dead one.
  return rewriteHostUrl(raw, hostCtx()) || null;
}

function DrillBlock({ drill, compact = false }: { drill: DrillStamp; compact?: boolean }) {
  const inFlight = drill.state === "planning" || drill.state === "running";
  const href = drillLink(drill);
  const detail: string[] = [];
  if (Number.isFinite(drill.checks as number)) detail.push(`${drill.checks} checks`);
  if ((drill.findings ?? 0) > 0) detail.push(`${drill.findings} finding${drill.findings === 1 ? "" : "s"}`);
  if ((drill.unproven ?? 0) > 0) detail.push(`${drill.unproven} unproven`);
  return (
    <div className={`drill-block ${drill.state}`}>
      {inFlight && <span className="run-spin" aria-hidden />}
      <span className={drillChipClass(drill.state)}>{DRILL_LABEL[drill.state] ?? drill.state}</span>
      {detail.length > 0 && <span className="db-detail">{detail.join(" · ")}</span>}
      {drill.error && !compact && <span className="db-detail">{drill.error}</span>}
      {href && (
        <a className="db-link" href={href} target="_blank" rel="noreferrer">
          open in Drill
        </a>
      )}
    </div>
  );
}

// ── card front ──────────────────────────────────────────────────────────────
function Card({
  card,
  list,
  onStart,
  onMove,
  onQuickMove,
  onWatch,
  onTerminal,
  onOpen,
  onInfer,
  onDiscuss,
  onRevert,
  onContinue,
  onDrill,
  onFeedback,
  dragJustEnded,
  busy
}: {
  card: CardSummary;
  list: ListView;
  onStart: (c: CardSummary) => void;
  onMove: (c: CardSummary) => void;
  // Direct one-click move to a named list (Mark done → done, Archive → archived,
  // Unarchive → todo). Distinct from onMove, which asks when there is a choice.
  onQuickMove: (c: CardSummary, listId: string) => void;
  onWatch: (c: CardSummary) => void;
  onTerminal: (c: CardSummary) => void;
  onOpen: (c: CardSummary) => void;
  onInfer: (c: CardSummary) => void;
  onDiscuss: (c: CardSummary) => void;
  onRevert: (c: CardSummary) => void;
  onContinue: (c: CardSummary) => void;
  onDrill: (c: CardSummary) => void;
  onFeedback: (c: CardSummary) => void;
  // Item 5: the drag-just-ended flag from App, so the card-body click handler can
  // suppress the trailing click a completed drag synthesises.
  dragJustEnded: MutableRefObject<boolean>;
  busy: boolean;
}) {
  // D16: a card on an autonomous (agent) list is ENGINE-OWNED — the UI offers no
  // manual Move/edit on it (the API rejects them too). needs-attention is the one
  // human touchpoint on the autonomous side; interactive + manual lists stay
  // fully editable.
  const engineOwned = list.kind === "agent" && !list.interactive;
  // Advance shows on MANUAL lists (Backlog, To Do, needs-attention) — that is how a card
  // ENTERS the automated flow (To Do → Plan) or is re-sent after parking. Discuss
  // (interactive) uses the web chat + Move; Done (terminal) has nowhere to go.
  const canAdvance = list.kind !== "agent" && !list.interactive && !list.terminal && list.validNext.length > 0;
  const startLabel = "Advance";
  // Archived is a terminal parking column: cards land there via Archive and leave
  // only via Unarchive/Move. Distinguished from Done (also terminal) by id.
  const archived = list.id === "archived";
  // "Mark done": a one-click finish on any human-held, non-terminal card (Backlog,
  // To Do, Discuss, needs-attention). Engine-owned agent cards can't be moved by
  // hand (the API rejects it), and a card already on a terminal list has nowhere to go.
  const canMarkDone = !engineOwned && !list.terminal;
  // "Archive": get a finished (Done) or given-up (needs-attention) card out of the
  // way. Both are manual columns, so this never hits an engine-owned card.
  const canArchive = list.id === "done" || list.id === "needs-attention";
  // A persisted dispatch failure (gateway unreachable / transport defer): a red chip +
  // inline reason, so a failed dispatch shows on the CARD.
  const dispatchErr = card.lastDispatchError;
  const running = card.status === "running";
  // RUN: start a card's activity on demand on ANY agent list (Plan…Validate, incl. the
  // batched/scheduler-beat Test) — no need to wait for a trigger/tick. Shows on a
  // non-running agent-list card that isn't parked (a parked card is recovered via the
  // needs-attention column's Advance/Move, and the batch path skips needs-attention
  // cards, so offering Run there would be a no-op); reads "Retry" after a dispatch error.
  const canRun = list.kind === "agent" && !list.interactive && !running && card.status !== "needs-attention";
  // Why a parked card is in the needs-attention column.
  const parked = card.status === "needs-attention";
  const inferring = card.inferState === "running";
  // Offer "Infer" on a no-project card that isn't mid-inference (the visible attempt
  // the user asked for — also lets them re-try if it came back blank).
  const canInfer = !card.project && !inferring && !running;
  const lastEv = card.lastEvent;
  return (
    <div
      className={`card${running ? " running" : ""}${parked ? " parked" : ""}`}
      // Item 5: click the card body to open its detail (the dedicated Open button is
      // gone). shouldOpenCard ignores clicks on any interactive control (the card's
      // 15+ buttons / links / fields, whose clicks bubble here) and the trailing click
      // a drag synthesises. Placed on the card ROOT — not the sortable wrapper — so
      // the Done-column quick-strip cards (rendered without the wrapper) open too.
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (shouldOpenCard(e.target as EventTarget, dragJustEnded.current)) onOpen(card);
      }}
      onKeyDown={(e) => {
        // Enter on the card root itself opens it. Only when the root is the target —
        // an Enter on a focused child button is that button's business. Space is NOT
        // bound: dnd-kit's keyboard sensor uses it on the sortable wrapper.
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(card);
        }
      }}
    >
      <div className="ct">
        <span className={dotClass(card)} aria-hidden />
        <span className="title">{card.title}</span>
        {fmtCardDate(card.id) && <span className="ct-date" title="created">{fmtCardDate(card.id)}</span>}
      </div>
      <div className="cmeta">
        {card.project
          ? <span className="chip" title="project">{card.project}</span>
          : <span className="chip muted" title="no project assigned">no project</span>}
        {inferring && <span className="chip infer" title="inferring the project from the description"><SparkIcon /> inferring project…</span>}
        {parked && <span className="chip attn">needs-attention</span>}
        {card.steeringPending && <span className="chip steering" title="a mid-run revisit directive is pending — the card will re-stage at the next duty boundary">steering</span>}
        {card.waitingOn && <span className="chip waiting" title={card.waitingOn.reason}>waiting</span>}
        {card.blocking && card.blocking.length > 0 && (
          <span className="chip" title={`${card.blocking.length} card(s) are waiting on this one`}>blocks {card.blocking.length}</span>
        )}
        {card.parkedFrom && <span className="chip" title="the list it parked from">from {card.parkedFrom}</span>}
        {list.kind === "agent" && (
          <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        )}
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {card.scheduledFor && (
          <span
            className={`chip sched${scheduleDue(card) ? " due" : ""}`}
            title={
              scheduleDue(card)
                ? `scheduled for ${card.scheduledFor} - due${card.scheduleNotifiedAt ? ", reminder sent" : ""}`
                : `held until ${card.scheduledFor} (${card.scheduleAction === "run" ? "runs automatically" : "notifies"})`
            }
          >
            <ClockIcon /> {fmtSchedule(card.scheduledFor)}{card.scheduleAction === "run" ? " · auto" : ""}
          </span>
        )}
        {(card.checklistTotal ?? 0) > 0 && (
          <span
            className={`chip check${(card.checklistDone ?? 0) === card.checklistTotal ? " all-done" : ""}`}
            title={`checklist: ${card.checklistDone}/${card.checklistTotal} done`}
          >
            {card.checklistDone}/{card.checklistTotal}
          </span>
        )}
        {card.workKind && <span className="chip" title="work kind (the policy phase plan this run follows)">{card.workKind}</span>}
        {engineOwned && <span className="chip muted" title="This card is on an autonomous list — the run engine owns its progression (D16). It becomes editable if it parks in needs-attention.">engine-owned</span>}
        {card.fences?.sha && (
          <span className="chip fence" title={`last commit fence: ${card.fences.phase ?? "?"} @ ${card.fences.sha}`}>
            fence {card.fences.sha.slice(0, 7)}
          </span>
        )}
        {dispatchErr && (
          <span className="chip attn" title={dispatchErr.message}>{dispatchErr.reason}</span>
        )}
      </div>

      {/* Execution identity: runtime · model · effort · duty · account. From the
          settled route once a turn has served the card, from its resolved
          (duty, level) before that — so a queued or RUNNING card shows what it is
          burning instead of nothing until the turn ends. */}
      <ExecBadgeRow settled={card.lastRoute} expected={card.expectedRoute} />

      {/* D17 honesty: phases the card's rail turned OFF render as dimmed chips —
          visible, never hidden. Sourced from the card's phases toggle map. */}
      {card.phases && Object.values(card.phases).some((v) => v === false) && (
        <div className="cmeta">
          {Object.entries(card.phases)
            .filter(([, on]) => on === false)
            .map(([ph]) => (
              <span key={ph} className="chip off" title={`the ${ph} phase is OFF for this run — recorded off, never a silent pass`}>
                {ph}: off
              </span>
            ))}
        </div>
      )}

      {/* LIVE run state: a running pill with a ticking elapsed timer + the live log
          tail, so the card shows the operative WORKING (not just a pulsing dot). */}
      {running && (
        <div className="run-live">
          <div className="run-head">
            <span className="run-spin" aria-hidden />
            <span>running on {list.title}</span>
            <span className="run-elapsed"><Elapsed since={card.runningSince} /></span>
          </div>
          {card.liveTail
            ? <pre className="run-tail">{card.liveTail}</pre>
            : <div className="run-wait">waiting for the operative’s first output…</div>}
        </div>
      )}

      {/* WAITING: deferred behind an overlapping same-project run (amber, distinct
          from the parked red). Names the blocker, why, and the release point. */}
      {card.waitingOn && (
        <div className="state-callout waiting">
          Waiting on {waitingLabel(card.waitingOn)}: {waitingClause(card.waitingOn)}
        </div>
      )}

      {/* PARKED: the human reason (no jargon) + what the operative actually said. */}
      {parked && card.attentionReason && (
        <div className="dispatch-err">{card.attentionReason}</div>
      )}
      {/* ABANDONED (S2, Q7): a parked card with a prepared revert — the confirm block.
          Applying is a deliberate, guarded press (never auto-applied); the button is
          disabled once the revert is applied or has conflicted (state !== "prepared"),
          with the terminal state shown as a small tag. */}
      {parked && card.preparedRevert && (
        <div className="revert-block">
          <span className="rb-text">
            Prepared revert of {card.preparedRevert.commits} commit{card.preparedRevert.commits === 1 ? "" : "s"}
          </span>
          {card.preparedRevert.state !== "prepared" && (
            <span className={`chip ${card.preparedRevert.state === "applied" ? "ok" : "attn"}`}>{card.preparedRevert.state}</span>
          )}
          <button
            className="btn danger small"
            disabled={busy || card.preparedRevert.state !== "prepared"}
            title={card.preparedRevert.state === "prepared" ? "apply the prepared revert (asks to confirm first)" : `revert ${card.preparedRevert.state}`}
            onClick={() => onRevert(card)}
          >
            Confirm revert
          </button>
        </div>
      )}
      {/* DRILL: the handoff's live state on a card that was sent. Shown wherever the
          card is (not just on done) so a card moved on afterwards still carries the
          verdict of the drill it triggered. */}
      {card.drill && <DrillBlock drill={card.drill} compact />}
      {parked && card.lastReply && !card.attentionReason?.includes(card.lastReply.slice(0, 24)) && (
        <div className="card-reply" title="the operative's reply">“{card.lastReply}”</div>
      )}
      {dispatchErr && !parked && (
        <div className="dispatch-err">{dispatchErr.message}</div>
      )}

      {/* LAST ACTIVITY: the most recent timeline event + when — always visible (when
          not running/parked, which have their own richer block), so you can always see
          what last happened to the card. */}
      {!running && !parked && lastEv && (
        <div className="card-last" title={lastEv.detail || lastEv.message}>
          <span className={eventDotClass(lastEv.kind)} aria-hidden />
          <span className="cl-msg">{lastEv.message}</span>
          <span className="cl-when">{fmtRelative(lastEv.at)}</span>
        </div>
      )}

      <div className="btns">
        {/* Mark done: skip the pipeline and call a human-held card finished in one
            click — the "just a button on the card" path. */}
        {canMarkDone && (
          <button className="btn small ok" disabled={busy} title="mark this card done" onClick={() => onQuickMove(card, "done")}>
            <CheckIcon /> Done
          </button>
        )}
        {canAdvance && (
          <button className="btn primary small" disabled={busy} onClick={() => onStart(card)}>
            <PlayIcon /> {startLabel}
          </button>
        )}
        {canRun && (
          <button
            className="btn primary small"
            disabled={busy}
            title={dispatchErr ? "re-run this card on this list" : `run ${list.title} on this card now`}
            onClick={() => onStart(card)}
          >
            <PlayIcon /> {dispatchErr ? "Retry" : "Run"}
          </button>
        )}
        {canInfer && !engineOwned && (
          <button className="btn small" disabled={busy} title="infer the project from the description" onClick={() => onInfer(card)}>
            <SparkIcon /> Infer
          </button>
        )}
        {!engineOwned && (
          <button className="btn small" disabled={busy} onClick={() => onMove(card)}>
            <MoveIcon /> Move
          </button>
        )}
        {/* Discuss list (interactive) gets a dedicated Discuss button that opens a
            James-mode session seeded with this card; everything else gets Watch (logs). */}
        {list.interactive ? (
          <button className="btn small primary" title="open a James-mode discussion seeded with this card" onClick={() => onDiscuss(card)}>
            <ChatIcon /> Discuss
          </button>
        ) : (
          <>
            <button className="btn small" onClick={() => onWatch(card)}>
              <WatchIcon /> Watch
            </button>
            {/* Terminal opens an interactive shell in the card's project cwd.
                Only when the card resolves to a project (else the shell would
                open at the board's own dir, which isn't what you came for). */}
            {card.project && (
              <button className="btn small" title="open an interactive shell in this card's project" onClick={() => onTerminal(card)}>
                <TerminalIcon /> Terminal
              </button>
            )}
          </>
        )}
        {/* Feedback: write a note and send THIS card back through the pipeline with the
            same context (runDir + prior logs preserved). The "it reached the end but
            forgot part of the feature — send it back to fix it" path. Shown once a card
            has stopped: on Done (terminal) or parked in needs-attention. */}
        {((list.terminal && !archived) || parked) && (
          <button className="btn small" disabled={busy} title="write feedback and send this card back through the pipeline with the same context" onClick={() => onFeedback(card)}>
            <MailIcon /> Feedback
          </button>
        )}
        {/* WS2 (D7): a DONE card can spawn a continuation whose starting context is
            seeded from this card's handoff packet. */}
        {list.terminal && !archived && (
          <button className="btn small primary" disabled={busy} title="create a new card that continues this one's work" onClick={() => onContinue(card)}>
            <PlayIcon /> Continue
          </button>
        )}
        {/* Archive: park a finished (Done) or given-up (needs-attention) card in the
            Archived column so the board stays legible. */}
        {canArchive && (
          <button className="btn small" disabled={busy} title="move this card to the Archived column" onClick={() => onQuickMove(card, "archived")}>
            <ArchiveIcon /> Archive
          </button>
        )}
        {/* Unarchive: bring an archived card back onto the board (To Do). */}
        {archived && (
          <button className="btn small" disabled={busy} title="move this card back to To Do" onClick={() => onQuickMove(card, "todo")}>
            <UnarchiveIcon /> Unarchive
          </button>
        )}
        {/* Send to Drill: plan the checks for THIS card's change, run them, and
            notify when the verdict lands. Only on done (there is no landed change
            to test before that) and only with a project (nothing to test in). */}
        {list.terminal && !archived && card.project && (
          <button
            className="btn small"
            disabled={busy || card.drill?.state === "planning" || card.drill?.state === "running"}
            title={
              card.drill?.state === "planning" || card.drill?.state === "running"
                ? "a drill is already running for this card"
                : "plan a test for this card's change, run it, and notify when it's done"
            }
            onClick={() => onDrill(card)}
          >
            <DrillIcon /> {card.drill ? "Re-drill" : "Send to Drill"}
          </button>
        )}
        {/* Item 5: the Open button is gone — clicking the card body opens it (see the
            card root's onClick above). */}
      </div>
    </div>
  );
}

// ── new-card sheet ──────────────────────────────────────────────────────────
// Sentinel select value for the "type a custom project path" option (kept distinct
// from any real project name).
const PROJECT_CUSTOM = "__custom__";

// ── the run spec (RUN-SPEC-V1) ──────────────────────────────────────────────
//
// One control block for every dimension of a run, on the surface where the run is
// created. It writes the SAME `routing` pin the Web Channel's Turn Rail writes, and
// its options come from the SAME gateway vocabulary (`GET /route-options`), so the
// two surfaces can decide a run identically and neither can offer a value the
// gateway would then refuse.
//
// The widget is deliberately NOT the Turn Rail component: the rail is a mono badge
// line built for a chat composer, and this sheet is a form of native selects. What
// is shared is the vocabulary and the wire shape - the two things that would
// actually drift. The rendering belongs to its host.
//
// EVERY control defaults to "Automatic". Automatic is not a value that gets sent:
// it is the ABSENCE of a pin, which is what makes "auto by default, decide when you
// want to" true rather than a label on a default choice.
const AUTO = "";

/** A labelled select whose first row is always Automatic. `hint` explains what
 *  Automatic will do, so the default is never a mystery. */
function SpecSelect({
  id,
  label,
  hint,
  value,
  disabled,
  options,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  disabled?: string | null;
  options: { value: string; label: string; detail?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="spec-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={Boolean(disabled)} onChange={(e) => onChange(e.target.value)}>
        <option value={AUTO}>Automatic{hint ? ` — ${hint}` : ""}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.detail ? ` — ${o.detail}` : ""}
          </option>
        ))}
      </select>
      {/* An empty menu is never silent: say WHY, or the control reads as broken. */}
      {disabled ? <div className="spec-note">{disabled}</div> : null}
    </div>
  );
}

function RunSpec({
  spec,
  setSpec,
  options,
  optionsError
}: {
  spec: CardRouting;
  setSpec: (next: CardRouting) => void;
  options: RouteOptionsView | null;
  optionsError: string | null;
}) {
  const [open, setOpen] = useState(false);
  // A pin is "in force" only when it holds a real value - null/blank both mean
  // automatic, exactly as TurnRouting defines it.
  const pinnedCount = Object.values(spec).filter((v) => v !== null && v !== undefined && v !== "").length;
  const down = options && options.sources?.gateway === false;
  const why = down
    ? "the operative is not running — start it to choose a runtime"
    : optionsError
      ? `could not load the options (${optionsError})`
      : null;

  // The phases of the SELECTED plan, in plan order. Falls back to the default work
  // kind's plan, which is what an unpinned card actually walks.
  const kindId = spec.workKind || options?.defaultWorkKind || "";
  const planPhases = (options?.workKinds ?? []).find((k) => k.id === kindId)?.phases ?? [];
  const off = new Set((spec.phasesOff ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  // Serialised in PLAN order, never tap order, so the same selection always
  // produces the same pin.
  const setOff = (next: Set<string>) => {
    const csv = planPhases.filter((p) => next.has(p)).join(",");
    setSpec({ ...spec, phasesOff: csv || undefined });
  };

  const set = (field: keyof CardRouting) => (v: string) =>
    setSpec({ ...spec, [field]: v || undefined });

  return (
    <div className="field">
      <button type="button" className="spec-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Run spec
        <span className="muted">
          {pinnedCount === 0 ? "everything automatic" : `${pinnedCount} chosen, the rest automatic`}
        </span>
      </button>
      {open && (
        <div className="spec-grid">
          <SpecSelect
            id="nc-duty" label="Duty" hint="the classifier decides"
            value={spec.duty ?? AUTO} disabled={why}
            options={(options?.duties ?? []).map((d) => ({ value: d.id, label: d.id, detail: d.title ?? undefined }))}
            onChange={set("duty")}
          />
          <SpecSelect
            id="nc-tier" label="Tier" hint="the classifier decides"
            value={spec.tier ?? AUTO} disabled={why}
            options={(options?.tiers ?? []).map((t) => ({ value: t, label: t }))}
            onChange={set("tier")}
          />
          <SpecSelect
            id="nc-target" label="Runtime + model" hint="the composition's routing"
            value={spec.target ?? AUTO} disabled={why}
            // A target picks runtime+provider+model COHERENTLY. They are not
            // separate menus on purpose: there is no model catalog in the repo, so
            // independent dropdowns would happily produce gemini + opus.
            options={(options?.targets ?? []).map((t) => ({
              value: t.id,
              label: t.id,
              detail: [t.runtime, t.model].filter(Boolean).join(" / ") || undefined
            }))}
            onChange={set("target")}
          />
          <SpecSelect
            id="nc-effort" label="Effort" hint="the duty's effort"
            value={spec.effort ?? AUTO} disabled={why}
            options={(options?.efforts ?? []).map((e) => ({ value: e, label: e }))}
            onChange={set("effort")}
          />
          <SpecSelect
            id="nc-account" label="Account" hint="the composition's account"
            value={spec.account ?? AUTO} disabled={why}
            options={(options?.accounts ?? []).map((a) => ({ value: a.name, label: a.name, detail: a.platform ?? undefined }))}
            onChange={set("account")}
          />
          <SpecSelect
            id="nc-kind" label="Work kind" hint="inferred from the tier"
            value={spec.workKind ?? AUTO} disabled={why}
            options={(options?.workKinds ?? []).map((k) => ({
              value: k.id,
              label: k.id === options?.defaultWorkKind ? `${k.id} (default)` : k.id,
              detail: k.description ?? undefined
            }))}
            // Switching plans invalidates the OFF set - those ids belong to the old
            // plan, and carrying them over would disable phases never looked at.
            onChange={(v) => setSpec({ ...spec, workKind: v || undefined, phasesOff: undefined })}
          />
          {planPhases.length > 0 && (
            <div className="spec-field spec-field-wide">
              <label>Phases</label>
              <div className="rail-toggles">
                {planPhases.map((ph) => (
                  <label
                    key={ph}
                    className={`chip toggle${off.has(ph) ? " off" : ""}`}
                    title={off.has(ph) ? `${ph} is recorded OFF for this run (never a silent pass)` : `${ph} runs; tap to turn it off`}
                  >
                    <input
                      type="checkbox"
                      checked={!off.has(ph)}
                      onChange={(e) => {
                        const next = new Set(off);
                        if (e.target.checked) next.delete(ph);
                        else next.add(ph);
                        setOff(next);
                      }}
                    />
                    {ph}
                  </label>
                ))}
              </div>
              <div className="spec-note">
                {kindId ? `The ${kindId} plan, in order.` : "The default plan, in order."} A phase turned off stays on the
                rail, recorded off — never silently skipped.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NewCardSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  // Project picker: "auto" = leave blank (the server infers it from the description);
  // "pick" = a repo chosen from the dev-root list; "custom" = a free-typed name/path.
  const [projectMode, setProjectMode] = useState<"auto" | "pick" | "custom">("auto");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [description, setDescription] = useState("");
  const [goalMode, setGoalMode] = useState(false);
  // RUN-SPEC-V1: ONE explicit run spec for the card, in the same shape the Web
  // Channel's Turn Rail pins. It replaces the separate D17 work-kind select + phase
  // toggles that used to live here (those are now two dimensions of the spec) so
  // there is one place, not two, to decide how a card runs.
  const [spec, setSpec] = useState<CardRouting>({});
  const [options, setOptions] = useState<RouteOptionsView | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // Placement (brief D6): WHERE the card runs. "" = the host, which is the
  // default and sends no placement at all. Only CONNECTED outposts are offered:
  // pinning a card to a sleeping Mac just parks it in needs-attention.
  const [machines, setMachines] = useState<MachinesView | null>(null);
  const [placement, setPlacement] = useState("");
  // Card scheduling: hold the card until this local wall time, then notify
  // (default) or run automatically.
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleAction, setScheduleAction] = useState<"notify" | "run">("notify");
  // Files attached at creation: uploaded right AFTER the card exists (the
  // upload endpoint is card-scoped), before the sheet closes.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The repos under the dev-root (dev-env parity). Best-effort — on failure the picker
  // still offers "(auto-infer)" + "Custom path…".
  useEffect(() => {
    let alive = true;
    api.projects().then((v) => { if (alive) setProjects(v.projects); }).catch(() => { /* leave empty */ });
    // The run-spec vocabulary. A failure here disables the spec controls WITH A
    // REASON rather than rendering empty dropdowns; card creation itself is
    // unaffected, because every dimension is automatic by default.
    api.routeOptions()
      .then((v) => { if (alive) setOptions(v); })
      .catch((e) => { if (alive) setOptionsError(e instanceof Error ? e.message : String(e)); });
    // Best-effort: the endpoint already degrades to host-only with a reason, so a
    // failure here leaves the picker on "This machine" rather than blocking.
    api.machines().then((v) => { if (alive) setMachines(v); }).catch(() => { /* host-only */ });
    return () => { alive = false; };
  }, []);

  async function submit() {
    // Title is optional — it's inferred from the description when blank. Only block when
    // there's nothing at all to name the card by.
    if (!title.trim() && !description.trim()) {
      setErr("Add a title or a description — the title is inferred from the description when left blank.");
      return;
    }
    setSaving(true);
    setErr(null);
    const proj = projectMode === "auto" ? undefined : (project.trim() || undefined);
    // Drop empty values: an absent field is what "automatic" MEANS on the wire, and
    // sending "" would look like a pin the gateway then has to refuse.
    const routing = Object.fromEntries(
      Object.entries(spec).filter(([, v]) => v !== null && v !== undefined && v !== "")
    ) as CardRouting;
    const scheduledFor = scheduleAt ? isoFromLocalInput(scheduleAt) : null;
    if (scheduleAt && !scheduledFor) {
      setErr("The schedule time did not parse - pick it again.");
      setSaving(false);
      return;
    }
    try {
      const created = await api.create({
        title: title.trim() || undefined,
        project: proj,
        description,
        goalMode,
        ...(Object.keys(routing).length ? { routing } : {}),
        // Absent placement IS "host" on the wire — never send { target: "host" },
        // or every card carries a pin it did not ask for.
        ...(placement ? { placement: { target: placement } } : {}),
        ...(scheduledFor ? { scheduledFor, scheduleAction } : {})
      });
      // Upload any files picked at creation. Best-effort per file: a failed
      // upload names the file (the card itself is already created) and keeps
      // the sheet open so the failure is seen, not swallowed.
      const failed: string[] = [];
      for (const f of pendingFiles) {
        try {
          const b64 = await fileToBase64(f);
          await api.uploadAttachment(created.card.id, f.name, b64);
        } catch {
          failed.push(f.name);
        }
      }
      if (failed.length) {
        setErr(`Card created, but attachment upload failed for: ${failed.join(", ")}. Attach them again from the card's Open sheet.`);
        setSaving(false);
        setPendingFiles([]);
        onCreated();
        return;
      }
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const selectValue = projectMode === "custom" ? PROJECT_CUSTOM : projectMode === "auto" ? "" : project;

  return (
    <Sheet title="New card → Backlog" onClose={onClose}>
      <div className="field">
        <label htmlFor="nc-title">Title <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <input id="nc-title" type="text" value={title} autoFocus
          placeholder="optional — inferred from the description if left blank"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      </div>
      <div className="field">
        <label htmlFor="nc-project">Project <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <select
          id="nc-project"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") { setProjectMode("auto"); setProject(""); }
            else if (v === PROJECT_CUSTOM) { setProjectMode("custom"); setProject(""); }
            else { setProjectMode("pick"); setProject(v); }
          }}
        >
          <option value="">(auto-infer from the description)</option>
          {projects.map((p) => <option key={p.path} value={p.name}>{p.name}</option>)}
          <option value={PROJECT_CUSTOM}>Custom path…</option>
        </select>
        {projectMode === "custom" && (
          <input
            id="nc-project-custom"
            type="text"
            value={project}
            placeholder="project name or absolute path"
            style={{ marginTop: 8 }}
            autoFocus
            onChange={(e) => setProject(e.target.value)}
          />
        )}
        {projectMode === "auto" && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Left blank — Garrison infers the project from the description (you can change it later).
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="nc-desc">Description</label>
        <textarea id="nc-desc" value={description} placeholder="what needs doing (also used to infer the title/project)"
          onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label className="row" htmlFor="nc-goal">
          <input id="nc-goal" type="checkbox" checked={goalMode}
            onChange={(e) => setGoalMode(e.target.checked)} />
          goalMode (attach acceptance + bounded iterations)
        </label>
      </div>
      <div className="field">
        <label htmlFor="nc-sched">Schedule <span className="muted" style={{ fontWeight: 400 }}>(optional - holds the card until then)</span></label>
        <div className="sched-inline">
          <input id="nc-sched" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          <select value={scheduleAction} disabled={!scheduleAt} onChange={(e) => setScheduleAction(e.target.value === "run" ? "run" : "notify")}>
            <option value="notify">notify me (tell Gary to run/snooze)</option>
            <option value="run">run automatically</option>
          </select>
          {scheduleAt && (
            <button className="btn small" type="button" title="clear the schedule" onClick={() => setScheduleAt("")}>
              <CloseIcon />
            </button>
          )}
        </div>
      </div>
      <div className="field">
        <label htmlFor="nc-files">Attachments <span className="muted" style={{ fontWeight: 400 }}>(optional - context files the operative reads)</span></label>
        <input
          id="nc-files"
          type="file"
          multiple
          onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
        />
        {pendingFiles.length > 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {pendingFiles.map((f) => f.name).join(", ")}
          </div>
        )}
      </div>
      <RunSpec spec={spec} setSpec={setSpec} options={options} optionsError={optionsError} />
      {/* WHERE the card runs (brief D6). Deliberately OUTSIDE <RunSpec>: routing
          decides runtime/model/effort, placement decides the MACHINE, and they are
          orthogonal - any card can run on any outpost regardless of project. */}
      <div className="spec-grid">
        <SpecSelect
          id="nc-machine" label="Machine" hint="this machine (the Garrison host)"
          value={placement}
          disabled={machines && !machines.outpostsAvailable ? (machines.reason || "no outposts paired") : null}
          options={(machines?.machines ?? [])
            .filter((m) => !m.isHost)
            .map((m) => ({
              value: m.name,
              label: m.label,
              // Say the state plainly: a card pinned to an offline machine parks
              // in needs-attention until that machine comes back.
              detail: m.connected ? "online" : m.pending ? "pairing not finished" : "offline - card will park"
            }))}
          onChange={setPlacement}
        />
      </div>
      {err && <div className="banner">{err}</div>}
      <button className="btn primary" disabled={saving} onClick={() => void submit()}>
        {saving ? "Creating…" : "Create card"}
      </button>
    </Sheet>
  );
}

// ── inline Backlog quick-add (touch-first per-column affordance) ─────────────
// A per-column "Add card" at the head of the Backlog list: tap the trigger to
// reveal a compact inline form (title required, description + project optional)
// that POSTs straight to /cards — which always lands the card in Backlog — and
// refreshes the board in place, no reload. Distinct from the top-bar "New card"
// sheet, which carries goalMode and the full Run spec: this is the fast capture
// path, sized for touch (≥44px controls, usable at 390px). Reuses PROJECT_CUSTOM +
// the project-picker semantics of the New Card sheet so the two entry points behave
// the same.
//
// It deliberately does NOT get a second copy of the Run spec controls (RUN-SPEC-V1):
// two doors offering the same nine dimensions is exactly the duplication this change
// removes, and the point of the quick path is capture speed. A card created here is
// fully automatic, which is the default anyway — and the spec stays editable on the
// card afterwards (PATCH accepts `routing`). The form says so, so "no controls here"
// reads as a decision rather than an omission.
function BacklogAddCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectMode, setProjectMode] = useState<"auto" | "pick" | "custom">("auto");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Load the dev-root repos for the project picker only once the form is opened
  // (parity with the New Card sheet). Best-effort — on failure the picker still
  // offers "(auto-infer)" + "Custom path…".
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.projects().then((v) => { if (alive) setProjects(v.projects); }).catch(() => { /* leave empty */ });
    return () => { alive = false; };
  }, [open]);

  // Autofocus the title the moment the form opens.
  useEffect(() => { if (open) titleRef.current?.focus(); }, [open]);

  function reset() {
    setTitle(""); setDescription(""); setProjectMode("auto"); setProject(""); setErr(null); setSaving(false);
  }

  async function submit() {
    // Reentrancy guard: Enter can fire again while the POST is in flight —
    // without this, two keydowns create two cards.
    if (saving) return;
    // Title is REQUIRED on the quick-add path (the top-bar sheet is the "infer from
    // description" path). Block + refocus when it's blank rather than round-tripping.
    const t = title.trim();
    if (!t) { setErr("Give the card a title."); titleRef.current?.focus(); return; }
    setSaving(true);
    setErr(null);
    const proj = projectMode === "auto" ? undefined : (project.trim() || undefined);
    try {
      await api.create({ title: t, description: description.trim() || undefined, project: proj });
      reset();
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const selectValue = projectMode === "custom" ? PROJECT_CUSTOM : projectMode === "auto" ? "" : project;

  if (!open) {
    return (
      <button type="button" className="backlog-add-trigger" onClick={() => setOpen(true)}>
        <PlusIcon /> Add card
      </button>
    );
  }

  return (
    <div className="backlog-add" role="group" aria-label="Add a card to Backlog">
      <input
        ref={titleRef}
        className="ba-input"
        type="text"
        value={title}
        placeholder="Card title (required)"
        aria-label="Card title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { setOpen(false); reset(); }
        }}
      />
      <textarea
        className="ba-textarea"
        value={description}
        placeholder="Description (optional)"
        aria-label="Card description"
        onChange={(e) => setDescription(e.target.value)}
      />
      <select
        className="ba-select"
        aria-label="Project"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") { setProjectMode("auto"); setProject(""); }
          else if (v === PROJECT_CUSTOM) { setProjectMode("custom"); setProject(""); }
          else { setProjectMode("pick"); setProject(v); }
        }}
      >
        <option value="">Project: auto-infer</option>
        {projects.map((p) => <option key={p.path} value={p.name}>{p.name}</option>)}
        <option value={PROJECT_CUSTOM}>Custom path…</option>
      </select>
      {projectMode === "custom" && (
        <input
          className="ba-input"
          type="text"
          value={project}
          placeholder="project name or absolute path"
          aria-label="Custom project path"
          onChange={(e) => setProject(e.target.value)}
        />
      )}
      <div className="ba-note">Everything about the run is automatic. Use New card to choose.</div>
      {err && <div className="ba-err" role="alert">{err}</div>}
      <div className="ba-actions">
        <button type="button" className="ba-btn primary" disabled={saving || !title.trim()} onClick={() => void submit()}>
          {saving ? "Adding…" : "Add card"}
        </button>
        <button type="button" className="ba-btn" disabled={saving} onClick={() => { setOpen(false); reset(); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── move sheet (the manual gate) ────────────────────────────────────────────
function MoveSheet({
  card,
  board,
  onClose,
  onMoved
}: {
  card: CardSummary;
  board: BoardView;
  onClose: () => void;
  onMoved: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Item 2: the Move button is the MANUAL gate — it offers EVERY list except the
  // card's current one, so a card can be moved ANYWHERE by hand. (Advance is the
  // other control and keeps the next-list-only rail semantics: validNext.) Agent-kind
  // targets are FLAGGED, not hidden — moving a card onto one auto-dispatches a run.
  const targets = deriveMoveTargets(board, card);

  async function moveTo(listId: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(card.id, { list: listId, rev: card.rev });
      onMoved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title={`Move: ${card.title}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Move this card to any list — this is the manual gate. Advance instead to walk
        the next step of its pipeline.
      </p>
      {targets.length === 0 ? (
        <div className="banner info">No other list to move {card.title} to.</div>
      ) : (
        <div className="move-list">
          {targets.map((t) => (
            <button key={t.id} className="btn move-opt" disabled={busy} onClick={() => void moveTo(t.id)}>
              <MoveIcon /> {t.title}
              {t.isAgent && (
                <span className="move-agent-hint" title="This is an agent list — moving a card here starts a run.">
                  starts a run
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}
    </Sheet>
  );
}

// ── feedback sheet ("click a letter" to send a card back through the pipeline) ─
// A card reached the end (Done) or stopped (needs-attention) but missed part of the
// work, or the user wants to build on it. Write the feedback, pick where it re-enters
// the pipeline (default: the start of the queue), and the SAME card is re-staged there
// carrying the same context — its run directory + prior iteration logs are preserved,
// and the note is folded into every phase from that point on (steering.md). This is the
// board-side surface of the existing steering mechanism (POST /cards/:id/steer), which
// until now was reachable only from the web-channel chat thread.
function FeedbackSheet({
  card,
  board,
  onClose,
  onSent
}: {
  card: CardSummary;
  board: BoardView;
  onClose: () => void;
  onSent: () => void;
}) {
  // Where the card can be sent back to: its resolved sequence (the leaf phase lists it
  // actually visits) when it carries one, else every agent phase list on the board in
  // order. The FIRST entry is "the start of the queue".
  const agentLists = board.lists.filter((l) => l.kind === "agent" && !l.interactive).sort((a, b) => a.order - b.order);
  const phaseIds = ((card.sequence && card.sequence.length ? card.sequence : agentLists.map((l) => l.id)) as string[]).filter(
    (id) => board.lists.some((l) => l.id === id)
  );
  const titleFor = (id: string) => board.lists.find((l) => l.id === id)?.title ?? id;
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState(phaseIds[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    const text = message.trim();
    if (!text) { setErr("Write the feedback first."); return; }
    if (!target) { setErr("This card has no pipeline phase to send it back to."); return; }
    setBusy(true);
    setErr(null);
    try {
      const reason = text.length > 80 ? text.slice(0, 77) + "…" : text;
      await api.steer(card.id, { message: text, action: "revisit", revisitDuty: target, reason });
      onSent();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title={`Feedback: ${card.title}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Tell this card what to fix or add. It goes back through the pipeline from the phase
        you pick, keeping the same context (its run directory and prior work), and folds your
        note into every phase from there on.
      </p>
      <div className="field">
        <label htmlFor="fb-message">Feedback</label>
        <textarea
          id="fb-message"
          value={message}
          autoFocus
          rows={5}
          placeholder="e.g. You forgot the CSV export button on the report page — add it and wire it to /api/export."
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      {phaseIds.length > 0 ? (
        <div className="field">
          <label htmlFor="fb-target">Send back to</label>
          <select id="fb-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {phaseIds.map((id, i) => (
              <option key={id} value={id}>
                {titleFor(id)}{i === 0 ? " (start of the queue)" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="banner info">This card has no pipeline phases to send it back through.</div>
      )}
      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !message.trim() || !target} onClick={() => void send()}>
          <MailIcon /> {busy ? "Sending…" : "Send back"}
        </button>
      </div>
    </Sheet>
  );
}

// ── detail sheet (Open) — the decision-10 links + decision log ──────────────
// LinkRow opens each produced artifact in the in-board viewer/editor (ArtifactModal)
// rather than a raw new tab, so brief/plan/logs are viewable AND editable in place. The
// external walkthrough video (kind "href") still opens out.
function LinkRow({ label, refs, onOpen }: { label: string; refs: ArtifactRef | ArtifactRef[] | null; onOpen: (ref: ArtifactRef) => void }) {
  const items = Array.isArray(refs) ? refs : refs ? [refs] : [];
  return (
    <div className="lrow">
      <div className="k">{label}</div>
      <div className="v">
        {items.length === 0 && <span className="missing">—</span>}
        {items.map((ref, i) => {
          const href = api.artifactUrl(ref);
          if (ref.kind === "missing" || !href) {
            return <span key={i} className="missing">{ref.path ?? "not produced"}</span>;
          }
          const label2 = ref.sessionId
            ? ref.sessionId.slice(0, 8)
            : ref.kind === "href"
              ? "open video"
              : ref.path
                ? ref.path.split("/").pop()
                : "open";
          const dim = ref.exists === false && ref.kind !== "href";
          return (
            <span key={i}>
              {i > 0 && " · "}
              {ref.kind === "href" ? (
                <a href={href} target="_blank" rel="noreferrer">{label2}</a>
              ) : (
                <button type="button" className="artlink" style={dim ? { opacity: 0.55 } : undefined} onClick={() => onOpen(ref)}>
                  {label2}{dim ? " (pending)" : ""}
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// The in-board artifact viewer/editor. Fetches the served content, renders it (image /
// read-only text / an editable .md·.txt), and saves edits back via PUT for the editable
// refs (brief · plan · logs). Machine-generated JSON + transcripts + evidence are view-only.
const ART_IMG_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
function artRefToken(ref: ArtifactRef): string | null {
  if (ref.ref) return ref.ref;
  try { return new URL(ref.url ?? "", "http://x").searchParams.get("ref"); } catch { return null; }
}
function ArtifactModal({ cardId, art, onClose }: { cardId: string; art: ArtifactRef; onClose: () => void }) {
  const url = api.artifactUrl(art);
  const token = artRefToken(art);
  const base = (art.path ? art.path.split("/").pop() : "") || art.name || token || "artifact";
  const ext = base.toLowerCase().split(".").pop() ?? "";
  const isImage = ART_IMG_EXT.includes(ext) || Boolean(art.image);
  const editable = Boolean(token && (token === "brief" || token === "plan" || /^log:\d+$/.test(token)) && (ext === "md" || ext === "txt"));
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(isImage);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (isImage || !url) { setLoaded(true); return; }
    let alive = true;
    fetch(url, { cache: "no-store" }).then((r) => r.text()).then((t) => { if (alive) { setContent(t); setLoaded(true); } })
      .catch((e) => { if (alive) { setErr(String(e)); setLoaded(true); } });
    return () => { alive = false; };
  }, [url]);
  const save = useCallback(async () => {
    if (!token) return;
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/cards/${encodeURIComponent(cardId)}/artifact?ref=${encodeURIComponent(token)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
      });
      const d = await r.json();
      if (d?.error) setErr(String(d.error));
      else { setSaved(true); setDirty(false); window.setTimeout(() => setSaved(false), 1500); }
    } catch (e) { setErr(String(e)); }
    setSaving(false);
  }, [cardId, token, content]);
  return (
    <div className="art-scrim" onClick={onClose}>
      <div className="art-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={base}>
        <div className="art-head">
          <span className="art-title">{base}</span>
          {editable && <span className="art-tag">editable</span>}
          <span className="art-spacer" />
          {url && <a className="art-raw" href={url} target="_blank" rel="noreferrer">raw</a>}
          <button type="button" className="art-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="art-body">
          {!loaded ? <div className="art-loading">Loading…</div>
            : isImage ? <img className="art-img" src={url ?? ""} alt={base} />
            : editable ? <textarea className="art-editor" value={content} spellCheck={false} onChange={(e) => { setContent(e.target.value); setDirty(true); }} />
            : <pre className="art-view">{content || "(empty)"}</pre>}
        </div>
        {editable ? (
          <div className="art-foot">
            {err ? <span className="art-err">{err}</span> : saved ? <span className="art-ok">Saved</span> : dirty ? <span className="art-dirty">Unsaved changes</span> : <span className="art-dim">Up to date</span>}
            <span className="art-spacer" />
            <button type="button" className="art-save" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "Saving…" : "Save"}</button>
          </div>
        ) : err ? <div className="art-foot"><span className="art-err">{err}</span></div> : null}
      </div>
    </div>
  );
}

// One row on the Activity timeline: a coloured kind-dot, the message + when, and an
// expandable detail (the operative's full reply / error / inference output) when present.
function TimelineEvent({ ev }: { ev: CardEvent }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(ev.detail && ev.detail.trim());
  return (
    <div className="tl-ev">
      <span className={eventDotClass(ev.kind)} aria-hidden />
      <div className="tl-body">
        <div className="tl-line">
          <span className="tl-msg">{ev.message}</span>
          <span className="tl-when" title={ev.at}>{fmtRelative(ev.at)}</span>
        </div>
        {ev.route && routeLine(ev.route) && (
          <div className="tl-route" title={routeTitle(ev.route)}>{routeLine(ev.route)}</div>
        )}
        {hasDetail && (
          <>
            <button className="tl-toggle" onClick={() => setOpen((o) => !o)}>
              {open ? "hide detail" : "show detail"}
            </button>
            {open && <pre className="tl-detail">{ev.detail}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function DetailSheet({ cardId, board, onClose, onChanged, onWatch, onTerminal }: { cardId: string; board?: BoardView | null; onClose: () => void; onChanged: () => void; onWatch?: (c: CardSummary) => void; onTerminal?: (c: CardSummary) => void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openArt, setOpenArt] = useState<ArtifactRef | null>(null);
  // S2 (Q7): abandonment + revert action state — separate from the delete flow.
  const [abandoning, setAbandoning] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<string | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  // Trello-style in-place editing: title + description drafts (null = not
  // editing), the checklist add-input, the schedule picker drafts, and the
  // attachment upload state.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [checkText, setCheckText] = useState("");
  const [schedDraft, setSchedDraft] = useState<string | null>(null);
  const [schedActionDraft, setSchedActionDraft] = useState<"notify" | "run">("notify");
  const [savingSched, setSavingSched] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Poll the detail while open so the Activity feed updates live as a run progresses
  // (the engine appends events through the run). 3s is responsive without being chatty.
  useEffect(() => {
    let alive = true;
    const pull = () => api.card(cardId).then((d) => { if (alive) { setDetail(d); setErr(null); } }).catch((e) => {
      if (alive && !detail) setErr(e instanceof Error ? e.message : String(e));
    });
    void pull();
    const t = setInterval(pull, 3000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  useEffect(() => { setProjectDraft(null); }, [cardId]);

  async function saveProjectScope() {
    if (!detail) return;
    setSavingProject(true);
    setActionErr(null);
    try {
      const next = await api.patch(detail.card.id, {
        project: projectDraft ?? detail.card.project ?? "",
        rev: detail.card.rev
      });
      setDetail((d) => d ? { ...d, card: next.card } : d);
      setProjectDraft(next.card.project ?? "");
      onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingProject(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await api.del(cardId);
      onChanged();   // refresh the board (the card is gone)
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  // One CAS-carrying patch helper for the in-place edits: sends the freshest
  // rev, folds the result back into the open detail, and surfaces a 409 as an
  // actionable message (the 3s poll rebases the editor state).
  async function patchCard(body: Record<string, unknown>) {
    if (!detail) return false;
    setActionErr(null);
    try {
      const next = await api.patch(detail.card.id, { ...body, rev: detail.card.rev });
      setDetail((d) => (d ? { ...d, card: next.card } : d));
      onChanged();
      return true;
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll refreshes */ });
      return false;
    }
  }

  async function saveTitle() {
    const t = (titleDraft ?? "").trim();
    if (!t || !detail || t === detail.card.title) { setTitleDraft(null); return; }
    setSavingEdit(true);
    if (await patchCard({ title: t })) setTitleDraft(null);
    setSavingEdit(false);
  }

  async function saveDescription() {
    if (descDraft === null || !detail) return;
    setSavingEdit(true);
    if (await patchCard({ description: descDraft })) setDescDraft(null);
    setSavingEdit(false);
  }

  // Checklist writes are whole-array replaces (tiny, human-edited) and are
  // BENIGN patches - allowed even on an engine-owned card.
  async function saveChecklist(items: ChecklistItem[]) {
    if (!detail) return;
    // Optimistic: the checkbox flips instantly; a 409 re-pulls.
    setDetail((d) => (d ? { ...d, checklist: items } : d));
    await patchCard({ checklist: items });
  }

  function addCheckItem() {
    const text = checkText.trim();
    if (!text || !detail) return;
    const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`).replace(/-/g, "").slice(0, 10);
    setCheckText("");
    void saveChecklist([...(detail.checklist ?? []), { id, text, done: false }]);
  }

  async function setSchedule(iso: string | null, action: "notify" | "run") {
    setSavingSched(true);
    await patchCard(iso ? { scheduledFor: iso, scheduleAction: action } : { scheduledFor: null });
    setSavingSched(false);
    setSchedDraft(null);
  }

  async function uploadFiles(files: File[]) {
    if (!detail || !files.length) return;
    setUploading(true);
    setActionErr(null);
    const failed: string[] = [];
    for (const f of files) {
      try {
        const b64 = await fileToBase64(f);
        await api.uploadAttachment(detail.card.id, f.name, b64);
      } catch {
        failed.push(f.name);
      }
    }
    if (failed.length) setActionErr(`Upload failed for: ${failed.join(", ")}`);
    await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll refreshes */ });
    onChanged();
    setUploading(false);
  }

  async function removeAttachment(name: string) {
    if (!detail) return;
    if (!window.confirm(`Remove the attachment "${name}"?`)) return;
    setActionErr(null);
    try {
      await api.deleteAttachment(detail.card.id, name);
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll refreshes */ });
      onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Send to Drill: hand this card's change over for an automatic test plan + run.
  // Fire-and-return — the plan alone takes minutes, so the button's job is to start
  // the job and let the drill block (kept fresh by the 3s poll) carry the state.
  async function doDrill() {
    setDrilling(true);
    setActionErr(null);
    try {
      await api.sendToDrill(cardId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll will refresh */ });
      onChanged();
      setDrilling(false);
    }
  }

  // Abandon (S2, Q7): prepare a revert of the card's committed work and park it. The
  // revert is NOT applied here — a separate confirm applies it. Re-pull the detail so
  // the prepared-revert section appears at once (the 3s poll would also catch it).
  async function doAbandon() {
    if (!window.confirm("Abandon this card and prepare a revert of its committed work? It parks in needs-attention; the revert is NOT applied until you confirm it.")) return;
    setAbandoning(true);
    setActionErr(null);
    try {
      await api.abandon(cardId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll will refresh */ });
      onChanged();
      setAbandoning(false);
    }
  }

  // Confirm-apply the prepared revert (S2, Q7). A guarded press; the server also
  // requires an explicit confirm. On a conflict the server aborts cleanly and the
  // descriptor flips to "conflict" — surfaced here after the re-pull.
  async function doRevert() {
    const n = detail?.card.preparedRevert?.commits ?? 0;
    if (!window.confirm(`Apply the prepared revert of ${n} commit${n === 1 ? "" : "s"}? This adds revert commits to the shared branch.`)) return;
    setReverting(true);
    setActionErr(null);
    try {
      await api.revert(cardId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll will refresh */ });
      onChanged();
      setReverting(false);
    }
  }

  if (err) return <Sheet title="Card" onClose={onClose}><div className="banner">{err}</div></Sheet>;
  if (!detail) return <Sheet title="Card" onClose={onClose}><p className="muted">Loading…</p></Sheet>;

  const { card, links, decisionLog } = detail;
  const events = detail.events ?? [];
  const attachments = detail.attachments ?? [];
  const checklist = detail.checklist ?? [];
  const running = card.status === "running";
  const parked = card.status === "needs-attention";
  // D16: title/description edits are refused on an engine-owned card (the
  // server enforces it; the UI says so instead of offering a doomed control).
  // Schedule / checklist / attachments are benign and stay editable.
  const cardList = board?.lists.find((l) => l.id === card.list) ?? null;
  const lockedCard = Boolean(cardList && cardList.kind === "agent" && !cardList.interactive && !card.quick);
  // Evidence is expected from Walkthrough onward — so at those stages we show the
  // Evidence section even when empty, surfacing the GAP (the user looks here for proof).
  const evidence = links.evidence ?? [];
  const showEvidence = evidence.length > 0 || ["walkthrough", "validate", "done"].includes(card.list);
  // The description body without the ClaudeChat attachment block (which renders in
  // its own Attachments section below).
  const descBody = card.description ? stripAttachmentBlock(card.description) : "";
  return (
    <Sheet title={card.title} onClose={onClose} size="mid">
      {/* In-place title edit (Trello-style). Locked on an engine-owned card. */}
      {titleDraft !== null && (
        <div className="detail-desc">
          <div className="row" style={{ gap: 8 }}>
            <input
              aria-label="Card title"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveTitle(); if (e.key === "Escape") setTitleDraft(null); }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn small primary" disabled={savingEdit || !titleDraft.trim()} onClick={() => void saveTitle()}>Save</button>
            <button className="btn small" onClick={() => setTitleDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="detail-meta">
        {card.project
          ? <span className="chip">proj: {card.project}</span>
          : <span className="chip muted">no project</span>}
        <span className="chip">list: {card.list}</span>
        <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {card.runId && <span className="chip">run: {card.runId.slice(0, 8)}</span>}
        {card.sliceId && <span className="chip">slice: {card.sliceId}</span>}
      </div>

      {/* Header actions: open the rich Log (Watch) or an interactive Terminal. */}
      <div className="detail-actions">
        {titleDraft === null && (
          <button
            className="btn small"
            disabled={lockedCard}
            title={lockedCard ? "engine-owned - the title is editable when the card is not on an autonomous list" : "rename this card"}
            onClick={() => setTitleDraft(card.title)}
          >
            <WrenchIcon /> Rename
          </button>
        )}
        <button className="btn small" onClick={() => onWatch?.(card)}>
          <WatchIcon /> Watch (Log)
        </button>
        {card.project && (
          <button className="btn small" onClick={() => onTerminal?.(card)}>
            <TerminalIcon /> Terminal
          </button>
        )}
        {/* Send to Drill — done cards only: the change has to have landed before
            there is anything to test. Disabled (with the reason) while a job runs. */}
        {card.list === "done" && card.project && (
          <button
            className="btn small"
            disabled={drilling || card.drill?.state === "planning" || card.drill?.state === "running"}
            title={
              card.drill?.state === "planning" || card.drill?.state === "running"
                ? "a drill is already running for this card"
                : "plan a test for this card's change, run it automatically, and notify when it's done"
            }
            onClick={() => void doDrill()}
          >
            <DrillIcon /> {drilling ? "Sending…" : card.drill ? "Re-drill" : "Send to Drill"}
          </button>
        )}
      </div>
      {card.drill && (
        <div className="drill-detail">
          <DrillBlock drill={card.drill} />
        </div>
      )}

      {/* Current-state callout — the single most important "what's going on" line. */}
      {running && (
        <div className="state-callout running">
          <span className="run-spin" aria-hidden />
          <span>Running on <b>{card.list}</b> · <Elapsed since={card.runningSince} /> — open Watch for the live stream.</span>
        </div>
      )}
      {parked && card.attentionReason && (
        <div className="state-callout parked">{card.attentionReason}</div>
      )}
      {parked && (
        <div className="detail-desc">
          <div className="dd-title">Project / workspace scope</div>
          <div className="row" style={{ gap: 8 }}>
            <input
              aria-label="Project or workspace scope"
              value={projectDraft ?? card.project ?? ""}
              placeholder="project name or absolute workspace path"
              onChange={(e) => setProjectDraft(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn small" disabled={savingProject} onClick={() => void saveProjectScope()}>
              {savingProject ? "Saving…" : "Save scope"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
            A parked card is operator-editable. Use an absolute path when the task owns an isolated workspace outside a known repository.
          </p>
          {actionErr && <div className="dispatch-err" style={{ marginTop: 8 }}>{actionErr}</div>}
        </div>
      )}
      {card.waitingOn && (
        <div className="state-callout waiting">
          Waiting on <b>{waitingLabel(card.waitingOn)}</b>: {waitingClause(card.waitingOn)}
        </div>
      )}

      {/* ABANDONED (S2, Q7): the prepared revert — the exact commits to be reverted
          (short shas), the conflict-risk count, the state tag, and the guarded
          Confirm-revert button (disabled once applied / conflicted). */}
      {card.preparedRevert && (
        <div className="prepared-revert">
          <div className="dd-title">Prepared revert</div>
          <div className="pr-head">
            <span className="pr-count">
              {card.preparedRevert.commits} commit{card.preparedRevert.commits === 1 ? "" : "s"} to revert
            </span>
            {card.preparedRevert.conflictRisk > 0 && (
              <span className="chip attn" title="these commits were later touched by another card — the revert may conflict">
                {card.preparedRevert.conflictRisk} at conflict risk
              </span>
            )}
            <span className={`chip ${card.preparedRevert.state === "applied" ? "ok" : card.preparedRevert.state === "conflict" ? "attn" : "muted"}`}>
              {card.preparedRevert.state}
            </span>
          </div>
          {card.preparedRevert.commitShas.length > 0 && (
            <ul className="pr-commits">
              {card.preparedRevert.commitShas.map((s) => <li key={s}><code>{s}</code></li>)}
              {card.preparedRevert.commits > card.preparedRevert.commitShas.length && (
                <li className="muted">…and {card.preparedRevert.commits - card.preparedRevert.commitShas.length} more</li>
              )}
            </ul>
          )}
          <button
            className="btn danger small"
            disabled={reverting || card.preparedRevert.state !== "prepared"}
            onClick={() => void doRevert()}
          >
            {reverting ? "Reverting…" : "Confirm revert"}
          </button>
          {actionErr && <div className="dispatch-err" style={{ marginTop: 8 }}>{actionErr}</div>}
        </div>
      )}

      {/* SCHEDULE - hold the card until an instant, then notify (tell Gary to
          run/snooze) or run automatically. Benign patch: editable even on an
          engine-owned card; refused only while running. */}
      <div className="detail-desc sched-block">
        <div className="dd-title">Schedule</div>
        {card.scheduledFor && schedDraft === null && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className={`chip sched${scheduleDue(card) ? " due" : ""}`}>
              <ClockIcon /> {fmtSchedule(card.scheduledFor)}{card.scheduleAction === "run" ? " · auto-run" : " · notify"}
            </span>
            {card.scheduleNotifiedAt && <span className="chip muted" title={card.scheduleNotifiedAt}>reminder sent</span>}
            <button className="btn small" disabled={running || savingSched} onClick={() => { setSchedDraft(localInputFromIso(card.scheduledFor)); setSchedActionDraft(card.scheduleAction === "run" ? "run" : "notify"); }}>
              Change
            </button>
            <button className="btn small" disabled={running || savingSched} title="push the schedule out one hour" onClick={() => void setSchedule(new Date(Date.now() + 3600_000).toISOString(), card.scheduleAction === "run" ? "run" : "notify")}>
              +1h
            </button>
            <button className="btn small" disabled={running || savingSched} title="snooze until tomorrow 09:00" onClick={() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); void setSchedule(d.toISOString(), card.scheduleAction === "run" ? "run" : "notify"); }}>
              Tomorrow 9
            </button>
            <button className="btn small" disabled={running || savingSched} onClick={() => void setSchedule(null, "notify")}>
              Clear
            </button>
          </div>
        )}
        {!card.scheduledFor && schedDraft === null && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" disabled={running} title={running ? "the card is running" : "hold this card until a date/time"} onClick={() => { setSchedDraft(""); setSchedActionDraft("notify"); }}>
              <ClockIcon /> Set a schedule
            </button>
          </div>
        )}
        {schedDraft !== null && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input type="datetime-local" value={schedDraft} onChange={(e) => setSchedDraft(e.target.value)} />
            <select value={schedActionDraft} onChange={(e) => setSchedActionDraft(e.target.value === "run" ? "run" : "notify")}>
              <option value="notify">notify me (tell Gary to run/snooze)</option>
              <option value="run">run automatically</option>
            </select>
            <button
              className="btn small primary"
              disabled={savingSched || !schedDraft || !isoFromLocalInput(schedDraft)}
              onClick={() => { const iso = isoFromLocalInput(schedDraft); if (iso) void setSchedule(iso, schedActionDraft); }}
            >
              {savingSched ? "Saving…" : "Set"}
            </button>
            <button className="btn small" onClick={() => setSchedDraft(null)}>Cancel</button>
          </div>
        )}
      </div>

      {(descBody.trim() || descDraft !== null || !lockedCard) && (
        <div className="detail-desc">
          <div className="dd-title">
            Description
            {descDraft === null && !lockedCard && (
              <button className="btn tiny" title="edit the description" onClick={() => setDescDraft(stripAttachmentBlock(card.description ?? ""))}>
                edit
              </button>
            )}
          </div>
          {descDraft !== null ? (
            <div>
              <textarea
                value={descDraft}
                rows={Math.min(14, Math.max(4, descDraft.split("\n").length + 1))}
                autoFocus
                onChange={(e) => setDescDraft(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void saveDescription(); if (e.key === "Escape") setDescDraft(null); }}
                style={{ width: "100%" }}
              />
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <button className="btn small primary" disabled={savingEdit} onClick={() => void saveDescription()}>Save</button>
                <button className="btn small" onClick={() => setDescDraft(null)}>Cancel</button>
              </div>
            </div>
          ) : descBody.trim() ? (
            /* pre-wrap: multi-line bodies (drill fix cards list one finding
               per line with indented evidence links) keep their line structure
               in the plain-text render. */
            <p style={{ whiteSpace: "pre-wrap" }}>{linkifyText(descBody)}</p>
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>No description yet.</p>
          )}
        </div>
      )}

      {/* CHECKLIST - human-first sub-items; open items are folded into the
          operative's dispatch prompt. Benign patch, editable everywhere. */}
      <div className="detail-desc checklist">
        <div className="dd-title">
          Checklist
          {checklist.length > 0 && (
            <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
              {checklist.filter((i) => i.done).length}/{checklist.length}
            </span>
          )}
        </div>
        {checklist.length > 0 && (
          <ul className="cl-items">
            {checklist.map((item) => (
              <li key={item.id} className={item.done ? "done" : ""}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.done}
                  className={`cl-box${item.done ? " checked" : ""}`}
                  title={item.done ? "mark as not done" : "mark as done"}
                  onClick={() => void saveChecklist(checklist.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))}
                />
                <span className="cl-text">{item.text}</span>
                <button
                  type="button"
                  className="cl-del"
                  title="remove this item"
                  aria-label={`remove "${item.text}"`}
                  onClick={() => void saveChecklist(checklist.filter((i) => i.id !== item.id))}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ gap: 8 }}>
          <input
            aria-label="New checklist item"
            value={checkText}
            placeholder="add an item…"
            onChange={(e) => setCheckText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCheckItem(); }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="btn small" disabled={!checkText.trim()} onClick={addCheckItem}>
            <PlusIcon /> Add
          </button>
        </div>
      </div>

      {/* ATTACHMENTS - card-owned uploads (deletable, folded into the dispatch
          prompt as context) plus the legacy ClaudeChat description-block files.
          Images render inline (click to enlarge); other files link out. */}
      <div className="evidence">
        <div className="dd-title">
          Attachments
          <label className={`btn tiny${uploading ? " disabled" : ""}`} title="attach a file - the operative reads it as context when the card runs">
            {uploading ? "uploading…" : "attach"}
            <input
              type="file"
              multiple
              style={{ display: "none" }}
              disabled={uploading}
              onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void uploadFiles(files); }}
            />
          </label>
        </div>
        {attachments.length > 0 ? (
          <div className="ev-grid">
            {attachments.map((a) => (
              <div key={`${a.uploaded ? "u" : "d"}:${a.name}:${a.i ?? ""}`} className="ev-item">
                {a.image ? (
                  <button type="button" className="ev-shot" onClick={() => setOpenArt({ kind: "serve", url: a.url, name: a.name, image: true })} title={a.name}>
                    <img src={a.url} alt={a.name} loading="lazy" />
                    <span className="ev-name">{a.name}</span>
                  </button>
                ) : (
                  <a className="ev-file" href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                    <LinkIcon /> {a.name}
                  </a>
                )}
                {a.uploaded && (
                  <button type="button" className="ev-del" title={`remove ${a.name}`} aria-label={`remove ${a.name}`} onClick={() => void removeAttachment(a.name)}>
                    <CloseIcon />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>No attachments. Attached files are read by the operative as context for this card.</p>
        )}
      </div>

      {card.lastReply && (
        <div className="detail-desc">
          <div className="dd-title">Last operative reply</div>
          <p className="reply-quote">“{card.lastReply}”</p>
        </div>
      )}

      {/* EVIDENCE — the tangible proof the pipeline leaves at the late stages: a
          screenshot for anything visual, an evidence.md log for backend/static changes.
          Always shown from Walkthrough onward (even empty, so a missing-evidence GAP is
          visible right where the user looks). Images render inline; the log links out. */}
      {showEvidence && (
        <div className="evidence">
          <div className="dd-title">Evidence</div>
          {evidence.length > 0 ? (
            <div className="ev-grid">
              {evidence.map((e, i) => {
                const url = api.artifactUrl(e);
                if (!url) return null;
                return e.image ? (
                  <button key={i} type="button" className="ev-shot" onClick={() => setOpenArt(e)} title={e.name}>
                    <img src={url} alt={e.name ?? "evidence"} loading="lazy" />
                    <span className="ev-name">{e.name}</span>
                  </button>
                ) : (
                  <button key={i} type="button" className="ev-file" onClick={() => setOpenArt(e)} title={e.name}>
                    <LinkIcon /> {e.name}
                  </button>
                );
              })}
            </div>
          ) : running ? (
            <p className="muted ev-none">Evidence will appear here once the {card.list} step produces it…</p>
          ) : (
            <p className="muted ev-none">No evidence was captured for this run — a screenshot or a log should be produced at the Walkthrough step.</p>
          )}
        </div>
      )}

      {/* The Activity timeline — the full "what happened to this card" history. */}
      <div className="timeline">
        <div className="tl-title"><ActivityIcon /> activity</div>
        {events.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>No activity yet.</p>
        ) : (
          events.map((ev, i) => <TimelineEvent key={i} ev={ev} />)
        )}
      </div>

      {/* Pointer table for the rest of the artifacts (evidence itself renders in the
          Evidence section above; the evidence-index json stays here as a raw pointer). */}
      <div className="links">
        <LinkRow label="plan" refs={links.plan} onOpen={setOpenArt} />
        <LinkRow label="brief" refs={links.brief} onOpen={setOpenArt} />
        <LinkRow label="sessions" refs={links.sessions} onOpen={setOpenArt} />
        <LinkRow label="phase gates" refs={links.gates} onOpen={setOpenArt} />
        <LinkRow label="gate markers" refs={links.gateMarkers} onOpen={setOpenArt} />
        <LinkRow label="evidence index" refs={links.evidenceIndex} onOpen={setOpenArt} />
        <LinkRow label="video" refs={links.video} onOpen={setOpenArt} />
        <LinkRow label="logs" refs={links.logs} onOpen={setOpenArt} />
      </div>
      {openArt && <ArtifactModal cardId={card.id} art={openArt} onClose={() => setOpenArt(null)} />}

      <div className="declog">
        <div className="dl-title"><LinkIcon /> decision log</div>
        {decisionLog.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>No separate decision-log rows; routed runtime history appears in Activity above.</p>
        ) : (
          decisionLog.map((run, i) => (
            <div key={i} className="dl-run">
              {run.mode && <span className="chip">mode: {run.mode}</span>}
              {run.model && <span className="chip">model: {run.model}</span>}
              {run.effort && <span className="chip">effort: {run.effort}</span>}
              {run.provider && <span className="chip">provider: {run.provider}</span>}
              {run.tier && <span className="chip">tier: {run.tier}</span>}
              {run.role && <span className="chip">role: {run.role}</span>}
            </div>
          ))
        )}
      </div>

      <div className="danger-zone">
        {/* Abandon (S2, Q7): prepare a revert of the card's committed work + park it.
            Offered on a non-running card that hasn't already been abandoned; the
            confirm() guard and the separate revert step keep it deliberate. */}
        {!running && !card.preparedRevert && (
          <button className="btn danger" disabled={abandoning} onClick={() => void doAbandon()}>
            {abandoning ? "Preparing…" : "Abandon & prepare revert"}
          </button>
        )}
        {!confirmDel ? (
          <button className="btn danger" onClick={() => setConfirmDel(true)}>Delete card</button>
        ) : (
          <div className="confirm-del">
            <span className="muted">Delete this card, its logs, its run directory, and its brief? This can’t be undone.</span>
            <div className="row">
              <button className="btn danger" disabled={deleting} onClick={() => void doDelete()}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button className="btn" disabled={deleting} onClick={() => setConfirmDel(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ── watch sheet — live terminal + SSE log (never tmux) ──────────────────────
// Two panes: TERMINAL shows the operative session's actual rendered screen
// (the gateway's PTY render, proxied same-origin via /operative/screen) -
// what you'd see in a real terminal, live. LOG tails the card's iteration log
// over SSE, or replays the linked static logs when nothing is live. The
// interactive Discuss list does NOT use this - it has its own
// Discuss button that opens a James-mode session (see App.onDiscuss).
// ── session transcript view (rich Log) ──────────────────────────────────────
// Ported from the drill fitting (SessionStream / SessionViewer): the operative's
// actual turns, tool calls and screenshots, streamed live over
// /cards/:id/session-stream while the card runs, or replayed once when idle.

interface SessionImage { mediaType: string; data: string }
interface SessionBlock {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  toolUseId?: string | null;
  isError?: boolean;
  images?: SessionImage[];
}
interface SessionEvent {
  id: string | null;
  role: string;
  ts: number | null;
  toolResultsOnly?: boolean;
  blocks: SessionBlock[];
}

function SessionTextBlock({ text, role }: { text: string; role: string }) {
  // Long prompts (the routed phase instructions) collapse to their first line —
  // the desktop-app "show more" idiom without the chrome.
  if (role === "user" && text.length > 280) {
    const head = text.slice(0, 140).split("\n")[0];
    return (
      <details className="dr-session-longtext">
        <summary>{head}…</summary>
        <pre className="dr-session-pre">{text}</pre>
      </details>
    );
  }
  return <pre className="dr-session-text">{text}</pre>;
}

function SessionToolBlock({ block, result }: { block: SessionBlock; result: SessionBlock | undefined }) {
  const hint = (block.input ?? "").replace(/\s+/g, " ").replace(/^[{[]\s*/, "").slice(0, 90);
  return (
    <div className="dr-session-toolwrap">
      <details className="dr-session-tool">
        <summary>
          <WrenchIcon />
          <b>{block.name}</b>
          <span className="dr-session-tool-hint">{hint}</span>
          {result?.isError && <span className="chip alarm">error</span>}
        </summary>
        {block.input && <pre className="dr-session-pre">{block.input}</pre>}
        {result?.text && <pre className="dr-session-pre result">{result.text}</pre>}
      </details>
      {(result?.images ?? []).map((image, index) => (
        <img
          key={index}
          className="dr-session-img"
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={`${block.name ?? "tool"} result image ${index + 1}`}
          loading="lazy"
        />
      ))}
    </div>
  );
}

// One session's live/replayed transcript, consuming the default-`message` SSE
// framing the kanban server emits (init / events / end), pairing each tool_use
// with its later tool_result via a toolUseId map.
function SessionStream({ cardId, i, live }: { cardId: string; i: number; live: boolean }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "ended" | "unavailable">("connecting");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setEvents([]);
    setTitle(null);
    setStatus("connecting");
    stickRef.current = true;
    const source = new EventSource(`/cards/${encodeURIComponent(cardId)}/session-stream?i=${i}`);
    source.onmessage = (message) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any;
      try { payload = JSON.parse(message.data); } catch { return; }
      if (payload.type === "init") {
        setEvents(payload.events ?? []);
        if (payload.title) setTitle(payload.title);
        setStatus(payload.available === false ? "unavailable" : payload.live ? "streaming" : "ended");
      } else if (payload.type === "events") {
        if (payload.title) setTitle(payload.title);
        if (payload.events?.length) setEvents((current) => [...current, ...payload.events]);
      } else if (payload.type === "end") {
        setStatus((current) => (current === "unavailable" ? current : "ended"));
        source.close();
      }
    };
    source.onerror = () => {
      // The server ends the stream itself after `end`; an earlier transport
      // error should read as "stream over", not an eternal spinner.
      setStatus((current) => (current === "unavailable" ? current : "ended"));
      source.close();
    };
    return () => source.close();
  }, [cardId, i]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const resultsByToolUse = useMemo(() => {
    const map = new Map<string, SessionBlock>();
    for (const event of events) {
      for (const block of event.blocks) {
        if (block.type === "tool_result" && block.toolUseId) map.set(block.toolUseId, block);
      }
    }
    return map;
  }, [events]);

  return (
    <div className="dr-session">
      <div className="dr-session-head">
        <ChatIcon />
        <b>{title ?? `Session ${i + 1}`}</b>
        {live && status === "streaming" && <span className="chip sage">live</span>}
        {status === "connecting" && <span className="chip">connecting…</span>}
        {status === "unavailable" && <span className="chip brass">transcript unavailable</span>}
      </div>
      <div className="dr-session-scroll" ref={scrollRef} onScroll={onScroll}>
        {events.length === 0 && (
          <div className="dr-empty">
            {status === "connecting"
              ? "Opening the session stream…"
              : status === "unavailable"
                ? "No transcript is available for this session — use the Raw tab for the phase log."
                : live
                  ? "Waiting for the first session activity…"
                  : "No session activity was captured for this run."}
          </div>
        )}
        {events.filter((event) => !event.toolResultsOnly).map((event, index) => (
          <div key={event.id ?? `event-${index}`} className={"dr-session-turn " + (event.role === "user" ? "user" : "assistant")}>
            <span className="dr-session-role">{event.role === "user" ? "Prompt" : "Assistant"}</span>
            {event.blocks.map((block, blockIndex) => {
              if (block.type === "text") return <SessionTextBlock key={blockIndex} text={block.text ?? ""} role={event.role} />;
              if (block.type === "thinking") {
                return (
                  <details key={blockIndex} className="dr-session-thinking">
                    <summary>Thinking</summary>
                    <pre className="dr-session-pre">{block.text}</pre>
                  </details>
                );
              }
              if (block.type === "tool_use") {
                return <SessionToolBlock key={blockIndex} block={block} result={block.toolUseId ? resultsByToolUse.get(block.toolUseId) : undefined} />;
              }
              return null;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// Chip-per-session picker (defaults to the LAST, most-recent session) over the
// card's sessionIds, mounting one SessionStream for the selected index.
function SessionViewer({ cardId, sessionIds, live }: { cardId: string; sessionIds: string[]; live: boolean }) {
  const count = sessionIds.length;
  const [selected, setSelected] = useState<number>(count > 0 ? count - 1 : 0);
  useEffect(() => {
    // Default to the most-recent session; re-clamp if the count shrinks.
    setSelected((cur) => (cur >= 0 && cur < count ? cur : Math.max(0, count - 1)));
  }, [count]);
  if (count === 0) {
    return <div className="dr-empty">No session transcript yet for this card — use the Raw tab for its phase log.</div>;
  }
  return (
    <div className="dr-session-viewer">
      {count > 1 && (
        <div className="dr-rowwrap dr-session-tabs" role="tablist" aria-label="Sessions">
          {sessionIds.map((_sid, index) => (
            <button
              key={index}
              role="tab"
              aria-selected={selected === index}
              className={"chip click" + (selected === index ? " ink active" : "")}
              onClick={() => setSelected(index)}
            >
              Session {index + 1}
            </button>
          ))}
        </div>
      )}
      <SessionStream key={selected} cardId={cardId} i={selected} live={live} />
    </div>
  );
}

// ── terminal modal — interactive shell PTY at the card's project cwd ─────────
// A real terminal (xterm + node-pty over /io) opened in the card's project, PLUS
// a read-only "operative screen" pane shown ONLY when the gateway reports a live
// PTY session (the default agent-sdk operative has none, so the shell alone is
// the expected experience). Uses its own fixed-height scrim/modal (NOT a Sheet)
// because xterm needs a real, non-collapsing height.
function TerminalModal({ card, onClose }: { card: CardSummary; onClose: () => void }) {
  const [screen, setScreen] = useState<string[] | null>(null);
  const [termLive, setTermLive] = useState<boolean>(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The gateway's live operative PTY render (read-only), shown only when live.
  useEffect(() => {
    const es = new EventSource("/operative/screen");
    es.addEventListener("mode", (e) => {
      try { setTermLive(JSON.parse((e as MessageEvent).data).live !== false); } catch { setTermLive(false); }
    });
    es.addEventListener("screen", (e) => {
      try { setScreen(JSON.parse((e as MessageEvent).data).lines ?? null); setTermLive(true); } catch { /* ignore */ }
    });
    es.onerror = () => { setTermLive(false); };
    return () => es.close();
  }, []);
  const ptyId = `card-${card.id}-shell`;
  return (
    <div className="term-scrim" onClick={onClose}>
      <div className="term-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Terminal for ${card.title}`}>
        <div className="art-head">
          <span className="art-title">card {card.id.slice(0, 6)} · {card.project || "no project"}</span>
          <span className="art-spacer" />
          <button type="button" className="art-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="term-body">
          <TerminalPane ptyId={ptyId} isActive={true} />
        </div>
        {termLive && screen && (
          <div className="term-operative">
            <div className="term-operative-head">operative screen · read-only</div>
            <pre>{screen.join("\n")}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ── watch sheet — rich Log (session transcript) primary, Raw phase log fallback ─
// The Log tab renders the operative's rich session transcript(s); the Raw tab
// keeps the card's phase log over SSE (the fallback for cards with no session
// yet). The live operative TERMINAL moved to its own Terminal modal. The
// interactive Discuss list does NOT use this — it opens a James-mode session.
function WatchSheet({
  card,
  onClose
}: {
  card: CardSummary;
  onClose: () => void;
}) {
  const hasSession = (card.sessionIds?.length ?? 0) > 0;
  // Default to the rich Log (session transcript) when the card has a session;
  // otherwise the Raw phase log. The live operative TERMINAL moved to its own
  // Terminal modal.
  const [tab, setTab] = useState<"session" | "raw">(hasSession ? "session" : "raw");
  const [lines, setLines] = useState<string>("");
  const [live, setLive] = useState<boolean | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const scrRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource(api.watchUrl(card.id));
    es.addEventListener("mode", (e) => {
      try { setLive(JSON.parse((e as MessageEvent).data).live); } catch { /* ignore */ }
    });
    es.addEventListener("log", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        // A live run sends replace:true (the full current log each poll) — show it as
        // the whole pane. Static logs (idle card) append:false → concatenate; growth
        // events append:true → append.
        setLines((prev) => (d.replace ? d.text : d.append ? prev + d.text : prev + (prev ? "\n" : "") + d.text));
      } catch { /* ignore */ }
    });
    es.addEventListener("end", (e) => {
      try { setDone(JSON.parse((e as MessageEvent).data).reason ?? "ended"); } catch { setDone("ended"); }
      es.close();
    });
    es.onerror = () => { es.close(); setDone((d) => d ?? "disconnected"); };
    return () => es.close();
  }, [card.id]);

  useEffect(() => {
    if (scrRef.current) scrRef.current.scrollTop = scrRef.current.scrollHeight;
  }, [lines, tab]);

  // Log formatting: markdown-ish headers, gate verdicts and the Adv-Review
  // "CODEX CALL" line (FINDING 6) get their own styling so a phase log reads
  // as a session, not a dump.
  const rendered = lines.split("\n").map((l, i) => {
    const cls = /CODEX CALL/i.test(l) ? "codexline"
      : /^GATE [a-z-]+:/i.test(l) ? "gateline"
      : /^#{1,3} /.test(l) ? "hline"
      : undefined;
    return <div key={i} className={cls}>{l || " "}</div>;
  });

  return (
    <Sheet title={`Watch: ${card.title}`} onClose={onClose} size="wide">
      {card.status === "needs-attention" && card.attentionReason && (
        <div className="state-callout parked" style={{ marginTop: 0 }}>{card.attentionReason}</div>
      )}
      <div className="watch">
        <div className="wbar">
          <span className="wtabs">
            <button className={`wtab${tab === "session" ? " on" : ""}`} onClick={() => setTab("session")}
              title="the operative's rich session transcript">Log</button>
            <button className={`wtab${tab === "raw" ? " on" : ""}`} onClick={() => setTab("raw")}
              title="this card's raw phase log">Raw</button>
          </span>
          card {card.id.slice(0, 6)} · {card.list}
          {tab === "raw" && (
            <span className={`live${live ? "" : " off"}`}>
              {live === null ? "connecting…" : live ? "live" : "static logs"}
            </span>
          )}
        </div>
        {tab === "session" ? (
          <SessionViewer cardId={card.id} sessionIds={card.sessionIds ?? []} live={card.status === "running"} />
        ) : (
          <div className="wscr" ref={scrRef}>
            {lines ? rendered : <span className="muted">{done ? "no log output" : "waiting for output…"}</span>}
          </div>
        )}
      </div>
      {tab === "raw" && done && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          stream ended: {done}
        </p>
      )}
    </Sheet>
  );
}

// ── list-config sheet (FINDING 5: configure a list's skill/prompts/routing) ──
// Opens for the list the gear was clicked on. Reads the FULL config from
// GET /lists (the board view omits the prompt bodies), lets the user edit the
// editable fields, and PATCHes the changes. A MANUAL list shows only title +
// validNext (the agent-only fields are not configurable — the server rejects
// them too); an AGENT/interactive list shows the full set. validNext is a
// multi-select of the REAL list ids (you can only route to lists that exist).
const TRIGGERS = ["immediate", "manual", "scheduler-beat"];
// ── schedule builder (scheduler-beat trigger) ────────────────────────────────
// The backend honors a 5-field POSIX cron. Rather than make the user hand-write cron,
// offer the common cadences (every N hours / daily at a time / weekly on a day) plus a
// raw "custom cron" escape hatch, and always show the resulting cron.
type SchedForm = { cadence: string; everyN: number; hour: number; minute: number; dow: string; custom: string };
const DOW_OPTS = [
  { v: "1", label: "Mon" }, { v: "2", label: "Tue" }, { v: "3", label: "Wed" },
  { v: "4", label: "Thu" }, { v: "5", label: "Fri" }, { v: "6", label: "Sat" }, { v: "0", label: "Sun" }
];

// Best-effort parse of a cron back into the friendly form (so opening an existing beat
// shows the right cadence); anything unrecognised falls to "custom" with the raw cron.
function parseCronToForm(cron: string | null | undefined): SchedForm {
  const def: SchedForm = { cadence: "everyHours", everyN: 5, hour: 9, minute: 0, dow: "1", custom: cron ?? "" };
  if (!cron || !cron.trim()) return def;
  const f = cron.trim().split(/\s+/);
  if (f.length === 5) {
    const [mi, hh, dom, mon, dw] = f;
    const everyH = hh.match(/^\*\/(\d+)$/);
    if (mi === "0" && everyH && dom === "*" && mon === "*" && dw === "*") {
      return { ...def, cadence: "everyHours", everyN: Math.max(1, Number(everyH[1])), custom: cron };
    }
    if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === "*" && mon === "*") {
      if (dw === "*") return { ...def, cadence: "daily", hour: Number(hh), minute: Number(mi), custom: cron };
      if (/^[0-6]$/.test(dw)) return { ...def, cadence: "weekly", hour: Number(hh), minute: Number(mi), dow: dw, custom: cron };
    }
  }
  return { ...def, cadence: "custom", custom: cron };
}

function formToCron(s: SchedForm): string {
  const mm = Math.max(0, Math.min(59, Math.trunc(s.minute) || 0));
  const hh = Math.max(0, Math.min(23, Math.trunc(s.hour) || 0));
  if (s.cadence === "everyHours") return `0 */${Math.max(1, Math.trunc(s.everyN) || 1)} * * *`;
  if (s.cadence === "daily") return `${mm} ${hh} * * *`;
  if (s.cadence === "weekly") return `${mm} ${hh} * * ${s.dow}`;
  return (s.custom || "").trim();
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function ScheduleField({ value, onChange }: { value: string | null; onChange: (cron: string) => void }) {
  const [form, setForm] = useState<SchedForm>(() => parseCronToForm(value));
  // Seed a sensible default cron when this opens with no schedule yet (e.g. the user
  // just switched the trigger to scheduler-beat), so saving registers a real beat.
  useEffect(() => {
    if (!value || !value.trim()) onChange(formToCron(form));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (partial: Partial<SchedForm>) => {
    const next = { ...form, ...partial };
    setForm(next);
    onChange(formToCron(next));
  };
  const cron = formToCron(form);
  const time = `${pad2(form.hour)}:${pad2(form.minute)}`;
  const onTime = (v: string) => {
    const [h, m] = v.split(":").map((x) => Number(x));
    update({ hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 });
  };
  return (
    <div className="sched">
      <select className="sched-cadence" value={form.cadence} onChange={(e) => update({ cadence: e.target.value })}>
        <option value="everyHours">Every N hours</option>
        <option value="daily">Daily at a time</option>
        <option value="weekly">Weekly on a day</option>
        <option value="custom">Custom cron</option>
      </select>
      {form.cadence === "everyHours" && (
        <label className="sched-row">
          every
          <input type="number" min={1} max={23} value={form.everyN}
            onChange={(e) => update({ everyN: Number(e.target.value) })} />
          hours
        </label>
      )}
      {form.cadence === "daily" && (
        <label className="sched-row">
          at <input type="time" value={time} onChange={(e) => onTime(e.target.value)} />
        </label>
      )}
      {form.cadence === "weekly" && (
        <label className="sched-row">
          on
          <select value={form.dow} onChange={(e) => update({ dow: e.target.value })}>
            {DOW_OPTS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
          at <input type="time" value={time} onChange={(e) => onTime(e.target.value)} />
        </label>
      )}
      {form.cadence === "custom" && (
        <input className="sched-custom" type="text" value={form.custom} placeholder="min hour day-of-month month day-of-week"
          onChange={(e) => update({ custom: e.target.value })} />
      )}
      <div className="cron-preview" title="the cron the scheduler fires this list on">cron: <code>{cron || "—"}</code></div>
    </div>
  );
}

function ListConfigSheet({
  listId,
  board,
  onClose,
  onSaved
}: {
  listId: string;
  board: BoardView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cfg, setCfg] = useState<ListConfig | null>(null);
  const [rev, setRev] = useState<number | null>(null); // board-level CAS token from GET /lists
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Load the full list config (prompt bodies included). The board only carries
  // the lists' metadata, not the execute/router prompt text. Capture the board
  // rev so the save can CAS against it (reject if another edit landed first).
  const reload = useCallback(() => {
    let alive = true;
    api.lists()
      .then((v) => {
        if (!alive) return;
        setRev(v.rev);
        const found = v.lists.find((l) => l.id === listId);
        if (found) setCfg(found);
        else setErr(`list not found: ${listId}`);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [listId]);
  useEffect(() => reload(), [reload]);

  if (err && !cfg) return <Sheet title="Configure list" onClose={onClose}><div className="banner">{err}</div></Sheet>;
  if (!cfg) return <Sheet title="Configure list" onClose={onClose}><p className="muted">Loading…</p></Sheet>;

  const isManual = cfg.kind === "manual";
  // The list ids you can route to (every list on the board). A list may route to
  // itself in principle, but the seed never does; we still list it so the user is
  // not blocked.
  const allListIds = board.lists.map((l) => ({ id: l.id, title: l.title }));
  // The lists not yet in validNext — the "+ add a next list" dropdown's options.
  const addableNext = allListIds.filter((l) => !cfg.validNext.includes(l.id));

  function set<K extends keyof ListConfig>(key: K, value: ListConfig[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  function toggleNext(id: string) {
    setCfg((c) => {
      if (!c) return c;
      const has = c.validNext.includes(id);
      return { ...c, validNext: has ? c.validNext.filter((x) => x !== id) : [...c.validNext, id] };
    });
  }

  async function save() {
    if (!cfg) return;
    if (!cfg.title.trim()) { setErr("Title is required"); return; }
    setSaving(true);
    setErr(null);
    // Send only the editable fields. A manual list sends just title + validNext
    // (the server rejects agent-only fields on a manual list). D15: skill/
    // taskType/tier/mode are GONE — resolution lives in the compiled
    // Orchestrator policy (the composer view), and the server rejects them.
    const base: ListConfigPatch = isManual
      ? { title: cfg.title.trim(), validNext: cfg.validNext }
      : {
          title: cfg.title.trim(),
          executePrompt: cfg.executePrompt,
          routerPrompt: cfg.routerPrompt,
          validNext: cfg.validNext,
          trigger: cfg.trigger,
          beatCron: cfg.trigger === "scheduler-beat" ? (cfg.beatCron && cfg.beatCron.trim() ? cfg.beatCron.trim() : null) : null
        };
    // Carry the rev we loaded so the server can reject a stale write (409).
    const patch: ListConfigPatch = rev != null ? { ...base, rev } : base;
    try {
      await api.patchList(cfg.id, patch);
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setSaving(false);
      // On a stale-board 409 (another edit landed first), pull the latest server
      // state + rev so the editor shows reality and the user can re-apply onto it.
      if (/changed under you/i.test(msg)) reload();
    }
  }

  return (
    <Sheet title={`Configure: ${cfg.title}`} onClose={onClose}>
      <div className="detail-meta">
        <span className="chip">id: {cfg.id}</span>
        <span className="chip">kind: {cfg.kind}</span>
        {cfg.interactive && <span className="chip">interactive</span>}
        {cfg.terminal && <span className="chip">terminal</span>}
      </div>

      {isManual && (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          This is a manual column — only its title and where it can route are configurable.
        </p>
      )}

      <div className="field">
        <label htmlFor="lc-title">Title</label>
        <input id="lc-title" type="text" value={cfg.title}
          onChange={(e) => set("title", e.target.value)} />
      </div>

      {!isManual && (
        <>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            This list runs the <strong>{cfg.phase ?? cfg.id}</strong> phase. Its skill, model,
            effort and runtime come from the compiled Orchestrator policy — configure them in
            the Orchestrator composer view, not here (D15).
          </p>
          <div className="field">
            <label htmlFor="lc-trigger">Trigger</label>
            <select id="lc-trigger" value={cfg.trigger} onChange={(e) => set("trigger", e.target.value)}>
              {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {cfg.trigger === "scheduler-beat" && (
            <div className="field">
              <label>Schedule</label>
              <ScheduleField value={cfg.beatCron} onChange={(cron) => set("beatCron", cron)} />
            </div>
          )}
          <div className="field">
            <label htmlFor="lc-exec">Execute prompt</label>
            <textarea id="lc-exec" value={cfg.executePrompt} placeholder="What the operative is told to do on this list"
              onChange={(e) => set("executePrompt", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lc-router">Router prompt</label>
            <textarea id="lc-router" value={cfg.routerPrompt} placeholder="How to pick the next list (end with one validNext id)"
              onChange={(e) => set("routerPrompt", e.target.value)} />
          </div>
        </>
      )}

      <div className="field">
        <label>Next action (where a card can go from here)</label>
        <div className="tag-list">
          {cfg.validNext.length === 0 && (
            <span className="muted" style={{ fontSize: 12.5 }}>none yet - a card here can&apos;t advance until you add one</span>
          )}
          {cfg.validNext.map((id) => {
            const l = allListIds.find((x) => x.id === id);
            return (
              <span key={id} className="tag">
                <span className="tag-label">{l?.title ?? id}</span>
                <button type="button" className="tag-x" aria-label={`remove ${l?.title ?? id}`} title="remove"
                  onClick={() => toggleNext(id)}>×</button>
              </span>
            );
          })}
        </div>
        {addableNext.length > 0 && (
          <select className="tag-add" value="" onChange={(e) => { if (e.target.value) toggleNext(e.target.value); }}>
            <option value="">+ add a next list…</option>
            {addableNext.map((l) => <option key={l.id} value={l.id}>{l.title} ({l.id})</option>)}
          </select>
        )}
      </div>

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}
      <button className="btn primary" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save list config"}
      </button>

      {/* Remove list - only the derived duty columns; the fixed human head/tail
          (backlog, todo, discuss, done, needs-attention) is structural. Removing
          the list removes its DUTY from the composition; cards sitting here are
          parked to Needs attention by the reconcile. */}
      {cfg.kind === "agent" && !cfg.interactive && !["backlog", "todo", "discuss", "done", "needs-attention"].includes(cfg.id) && (
        <div className="danger-zone" style={{ marginTop: 16 }}>
          <div className="dd-title">Remove list</div>
          {!confirmRemove ? (
            <button className="btn danger small" disabled={removing} onClick={() => setConfirmRemove(true)}>
              Remove list…
            </button>
          ) : (
            <div>
              <p className="muted" style={{ fontSize: 12 }}>
                This removes the <strong>{cfg.id}</strong> duty from the composition as
                well - the operative will no longer route work through this phase. Cards
                currently on this list will be moved to Needs attention. Cards whose
                journey includes it will re-route past it.
              </p>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn danger small"
                  disabled={removing}
                  onClick={() => {
                    setRemoving(true);
                    setErr(null);
                    api.deleteList(cfg.id)
                      .then(() => { onSaved(); onClose(); })
                      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)); setRemoving(false); });
                  }}
                >
                  {removing ? "Removing…" : "Yes, remove list + duty"}
                </button>
                <button className="btn small" disabled={removing} onClick={() => setConfirmRemove(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ── generic modal sheet ─────────────────────────────────────────────────────
function Sheet({ title, onClose, children, size = "default" }: { title: string; onClose: () => void; children: ReactNode; size?: "default" | "mid" | "wide" }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${size === "wide" ? " wide" : size === "mid" ? " mid" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h3>{title}</h3>
          <button className="btn small" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <div className="sh-body">{children}</div>
      </div>
    </div>
  );
}

// ── app ─────────────────────────────────────────────────────────────────────
type Overlay =
  | { kind: "new" }
  | { kind: "move"; card: CardSummary }
  | { kind: "detail"; cardId: string }
  | { kind: "watch"; card: CardSummary }
  | { kind: "terminal"; card: CardSummary }
  | { kind: "config"; listId: string }
  | { kind: "feedback"; card: CardSummary }
  | { kind: "addlist" }
  | null;

// ── add-list sheet ──────────────────────────────────────────────────────────
// A new column IS a new composition-local duty: the sheet says so plainly and
// the shell (via the board's /lists proxy) owns the apm.yml write + live
// reconcile. Target/effort are optional - the shell picks sane defaults.
function AddListSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    if (!title.trim()) { setErr("give the list a name"); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createList({ title: title.trim(), description: description.trim() || undefined });
      onCreated();
      onClose();
      void res;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <Sheet title="Add list" onClose={onClose}>
      <div className="field">
        <label htmlFor="al-name">Name</label>
        <input id="al-name" autoFocus type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Research" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      </div>
      <div className="field">
        <label htmlFor="al-desc">When should the operative pick this list? <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <textarea id="al-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="describes the new duty so the Dispatcher can route work to it" />
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
        Creating a list creates a matching duty in the composition (a new agent
        phase with sensible defaults). Tune its prompts, model and schedule
        afterwards from the list's gear menu. Removing the list later removes
        the duty too.
      </div>
      {err && <div className="banner">{err}</div>}
      <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
        {busy ? "Creating…" : "Create list"}
      </button>
    </Sheet>
  );
}

// ── drag-and-drop wrappers (Trello-style) ───────────────────────────────────
// Cards sort within a column and move across columns; columns reorder by
// dragging their header. The sortable transform provides the slot gap; the
// floating copy rides DragOverlay. Engine-owned cards may reorder inside their
// own column (position is a benign patch) but never change column by drag.

function SortableCardWrap({ card, listId, children }: { card: CardSummary; listId: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", card, listId }
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      className={`sortable-card${isDragging ? " drag-source" : ""}`}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

// The column body is itself a drop target so a card can land in an EMPTY list.
function ListBodyDroppable({ listId, children }: { listId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `body:${listId}`, data: { type: "body", listId } });
  return (
    <div ref={setNodeRef} className={`lbody${isOver ? " drop-over" : ""}`}>
      {children}
    </div>
  );
}

// A column: sortable by its HEADER (the handle), so card drags inside the body
// never fight the column drag.
function SortableColumn({ list, className, header, children }: { list: ListView; className: string; header: ReactNode; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `col:${list.id}`,
    data: { type: "column", listId: list.id }
  });
  return (
    <section ref={setNodeRef} style={{ transform: DndCSS.Transform.toString(transform), transition }} className={`${className}${isDragging ? " drag-source" : ""}`}>
      <div className="col-drag-handle" {...attributes} {...listeners}>
        {header}
      </div>
      {children}
    </section>
  );
}

function App() {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [runtime, setRuntime] = useState<BoardRuntime | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // ── drag state ────────────────────────────────────────────────────────────
  // During a drag the board renders from these overrides (membership order per
  // list / column order) so items shift live; the poll is paused (a reload
  // mid-drag would rip the dragged node out of the DOM). Cleared after the
  // post-drop reload lands.
  const [cardOrderOverride, setCardOrderOverride] = useState<Record<string, string[]> | null>(null);
  const [colOrderOverride, setColOrderOverride] = useState<string[] | null>(null);
  const [activeDrag, setActiveDrag] = useState<{ type: "card"; card: CardSummary } | { type: "column"; listId: string } | null>(null);
  const dragActiveRef = useRef(false);
  // Item 5: a completed pointer-drag synthesises a trailing click on mouse-up, which
  // would otherwise open the card's detail sheet after every reorder. Raised on
  // dragEnd/dragCancel and cleared on the next tick, so the card root's click handler
  // can suppress exactly that one trailing click. (dragActiveRef is already false by
  // the time the trailing click fires, so it can't be reused for this.)
  const dragJustEndedRef = useRef(false);
  const markDragJustEnded = useCallback(() => {
    dragJustEndedRef.current = true;
    setTimeout(() => { dragJustEndedRef.current = false; }, 0);
  }, []);
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } })
  );
  // Re-render when the /host-map lands so linkifyText upgrades loopback URLs to
  // their exact serve form (serveMapRev is read only to force the dependency).
  const [, setServeRev] = useState(serveMapRev);
  useEffect(() => {
    const bump = () => setServeRev(serveMapRev);
    serveMapSubs.add(bump);
    void loadHostMap();
    return () => { serveMapSubs.delete(bump); };
  }, []);

  const load = useCallback(async () => {
    // Never reload mid-drag: replacing the lists would rip the dragged node
    // out of the DOM under the pointer.
    if (dragActiveRef.current) return;
    try {
      const b = await api.board();
      if (dragActiveRef.current) return;
      setBoard(b);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // /board/runtime carries the live channel id (for Discuss) and the noGateway
  // flag. Refreshed alongside the board so a gateway start/stop or a channel
  // install/remove flips the relevant UI within one tick.
  const loadRuntime = useCallback(async () => {
    try {
      const r = await api.runtime();
      setRuntime(r);
    } catch {
      // /board/runtime missing (older server build) → leave runtime null; the UI
      // falls back to "no web channel" copy. Not fatal.
      // Deliberate no-op functional update: documents "keep prior state" so the catch doesn't read as missing error handling.
      setRuntime((prev) => prev);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRuntime();
    const t = setInterval(() => { void load(); void loadRuntime(); }, 5000);
    return () => clearInterval(t);
  }, [load, loadRuntime]);

  async function onStart(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      const res = await api.start(card.id);
      await load();
      setNotice(res.advanced ? `Moved to ${res.advanced}` : "Dispatched");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // One-click move to a named list (Mark done → done, Archive → archived,
  // Unarchive → todo). A manual move: the server clears any parked status and
  // records the move on the card's timeline; CAS on the card's rev keeps it from
  // stepping on a concurrent tick.
  async function onQuickMove(card: CardSummary, listId: string) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      await api.patch(card.id, { list: listId, rev: card.rev });
      await load();
      const title = board?.lists.find((l) => l.id === listId)?.title ?? listId;
      setNotice(`Moved to ${title}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // WS2 (D7): continue a DONE card's work in one click — create a successor card
  // (continues=<id>, its prompt seeded from the predecessor's handoff packet) and
  // move it to plan so the run dispatches. A fresh backlog card is not engine-owned,
  // so the human move to plan is allowed and auto-dispatches.
  async function onContinue(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      const created = await api.create({
        continues: card.id,
        title: `Continue: ${card.title || "(untitled)"}`,
        project: card.project ?? undefined
      });
      const newId = created.card.id;
      try {
        await api.patch(newId, { list: "plan", rev: created.card.rev });
      } catch {
        /* the move raced (project inference bumped the rev) — the card stays in
           Backlog; the user can move it to To Do. Never fail the whole action. */
      }
      await load();
      setNotice(`Continuation created${newId ? ` (${newId.slice(-6)})` : ""}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // Open a James-mode Discuss session seeded with this card. buildDiscussUrl carries
  // the card context + an auto-sent kickoff (analyse the description, ask questions,
  // write the brief). Crossing fittings: the board runs embedded (/embed/kanban-loop),
  // so when embedded we ask the Garrison shell to swap the embedded view (its
  // postMessage listener); standalone we navigate directly. The channel id is
  // discovered at runtime (not hardcoded) so a non-default web channel works too.
  function onDiscuss(card: CardSummary) {
    const channelId = runtime?.webChannelEmbedId ?? null;
    if (!channelId) {
      setNotice("No web channel is installed/running — install/start a web channel fitting to use Discuss.");
      return;
    }
    const chatHref = buildDiscussUrl(card, { webChannelBase: `/embed/${channelId}`, cardsAbsDir: runtime?.cardsAbsDir ?? null });
    const u = new URL(chatHref, window.location.origin);
    const fittingId = u.pathname.split("/").filter(Boolean).pop() || channelId;
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    if (window.top && window.top !== window.self) {
      window.top.postMessage({ type: "garrison:navigate-fitting", fittingId, params }, "*");
    } else {
      window.location.href = chatHref;
    }
  }

  // Apply a card's prepared revert (S2, Q7). A guarded, deliberate press: a native
  // confirm() first (the server ALSO requires an explicit confirm), then the board
  // reloads so the descriptor's new state (applied / conflict) shows either way.
  async function onRevert(card: CardSummary) {
    const n = card.preparedRevert?.commits ?? 0;
    if (!window.confirm(`Apply the prepared revert of ${n} commit${n === 1 ? "" : "s"}? This adds revert commits to the shared branch.`)) return;
    setBusyCard(card.id);
    setNotice(null);
    try {
      const res = await api.revert(card.id);
      setNotice(res.preparedRevert?.state === "applied" ? "Revert applied" : `Revert ${res.preparedRevert?.state ?? "done"}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setBusyCard(null);
    }
  }

  // Send a done card's change to Drill. The server only registers the job (the plan
  // agent alone runs for minutes), so this returns immediately and the card's drill
  // block — refreshed by the board poll — carries the state from there. The finish
  // arrives as a notification, not as a spinner you have to sit and watch.
  async function onDrill(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      const res = await api.sendToDrill(card.id);
      setNotice(
        res.started
          ? "Sent to Drill — planning the test for this change. You'll be notified when the run finishes."
          : "Already being drilled — joined the in-flight job."
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setBusyCard(null);
    }
  }

  // Infer the project for a no-project card — fire-and-forget on the server; the
  // "inferring…" pill + the result event show on the next poll.
  async function onInfer(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      await api.inferProject(card.id);
      await load();
      setNotice("Inferring the project…");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // ── drag-and-drop wiring ──────────────────────────────────────────────────
  // The board renders from displayLists: the polled board plus any in-drag
  // overrides. cardById spans the whole board so a card mid-move renders from
  // whichever column the override says it is in.
  const cardById = useMemo(() => {
    const m = new Map<string, CardSummary>();
    for (const c of board?.cards ?? []) m.set(c.id, c);
    return m;
  }, [board]);

  const displayLists = useMemo(() => {
    if (!board) return [] as ListView[];
    let lists = board.lists;
    if (colOrderOverride) {
      const rank = new Map(colOrderOverride.map((id, i) => [id, i]));
      lists = [...lists].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    }
    if (cardOrderOverride) {
      lists = lists.map((l) => {
        const ids = cardOrderOverride[l.id];
        if (!ids) return l;
        return { ...l, cards: ids.map((id) => cardById.get(id)).filter(Boolean) as CardSummary[] };
      });
    }
    return lists;
  }, [board, colOrderOverride, cardOrderOverride, cardById]);

  // A card on an autonomous agent list is engine-owned: it may REORDER inside
  // its own column (position is a benign patch) but never change column by drag.
  const dragLocked = useCallback((card: CardSummary): boolean => {
    const l = board?.lists.find((x) => x.id === card.list);
    return Boolean(l && l.kind === "agent" && !l.interactive && !card.quick);
  }, [board]);

  const containerOf = (over: DragOverEvent["over"]): string | null => {
    if (!over) return null;
    const data = over.data.current as { type?: string; listId?: string } | undefined;
    if (data?.type === "card") return data.listId ?? null;
    if (data?.type === "body" || data?.type === "column") return data.listId ?? null;
    return null;
  };

  function onDragStart(ev: DragStartEvent) {
    const data = ev.active.data.current as { type?: string; card?: CardSummary; listId?: string } | undefined;
    dragActiveRef.current = true;
    if (data?.type === "card" && data.card) {
      setActiveDrag({ type: "card", card: data.card });
      // Snapshot the current per-list order as the working membership.
      const snap: Record<string, string[]> = {};
      for (const l of displayLists) snap[l.id] = l.cards.map((c) => c.id);
      setCardOrderOverride(snap);
    } else if (data?.type === "column" && data.listId) {
      setActiveDrag({ type: "column", listId: data.listId });
      setColOrderOverride(displayLists.map((l) => l.id));
    }
  }

  // Collision strategy for a kanban: closestCorners alone lets a SMALL card in
  // the next column beat a LARGE empty column body (corner-average distance),
  // so a card could never be dropped into an empty list. Prefer what the
  // pointer is actually INSIDE, ranked by drag kind - cards first on a card
  // drag (precise insertion), columns first on a column drag - then fall back
  // to closestCorners when the pointer is outside every droppable.
  const boardCollisions = useCallback<CollisionDetection>((args) => {
    const isColumnDrag = String(args.active?.id ?? "").startsWith("col:");
    const within = pointerWithin(args);
    const pool = within.length ? within : closestCorners(args);
    const of = (prefix: string) => pool.filter((c) => String(c.id).startsWith(prefix));
    if (isColumnDrag) {
      const cols = of("col:");
      return cols.length ? cols : pool;
    }
    const cards = pool.filter((c) => !String(c.id).startsWith("col:") && !String(c.id).startsWith("body:"));
    if (cards.length) return cards;
    const bodies = of("body:");
    return bodies.length ? bodies : pool;
  }, []);

  function onDragOver(ev: DragOverEvent) {
    if (activeDrag?.type !== "card" || !cardOrderOverride) return;
    const card = activeDrag.card;
    const overContainer = containerOf(ev.over);
    if (!overContainer) return;
    const fromContainer = Object.keys(cardOrderOverride).find((k) => cardOrderOverride[k].includes(card.id));
    if (!fromContainer) return;
    const overData = ev.over?.data.current as { type?: string; card?: CardSummary } | undefined;
    if (fromContainer === overContainer) {
      // Same-column reorder: shift the dragged id to the hovered card's slot
      // so the gap (the slot indicator) tracks the pointer.
      if (overData?.type === "card" && overData.card && overData.card.id !== card.id) {
        setCardOrderOverride((prev) => {
          if (!prev) return prev;
          const arr = prev[fromContainer];
          const from = arr.indexOf(card.id);
          const to = arr.indexOf(overData.card!.id);
          if (from < 0 || to < 0 || from === to) return prev;
          return { ...prev, [fromContainer]: arrayMove(arr, from, to) };
        });
      }
      return;
    }
    if (dragLocked(card)) return; // engine-owned: same-column reorder only
    setCardOrderOverride((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [fromContainer]: prev[fromContainer].filter((id) => id !== card.id) };
      const target = [...(prev[overContainer] ?? [])];
      const at = overData?.type === "card" && overData.card ? target.indexOf(overData.card.id) : target.length;
      target.splice(at < 0 ? target.length : at, 0, card.id);
      return { ...next, [overContainer]: target };
    });
  }

  async function onDragEnd(ev: DragEndEvent) {
    const drag = activeDrag;
    setActiveDrag(null);
    try {
      if (drag?.type === "column" && colOrderOverride) {
        const overContainer = containerOf(ev.over);
        let order = colOrderOverride;
        if (overContainer && overContainer !== drag.listId) {
          const from = order.indexOf(drag.listId);
          const to = order.indexOf(overContainer);
          if (from >= 0 && to >= 0) order = arrayMove(order, from, to);
        }
        setColOrderOverride(order);
        await api.reorderLists(order);
      } else if (drag?.type === "card" && cardOrderOverride) {
        const card = drag.card;
        const container = Object.keys(cardOrderOverride).find((k) => cardOrderOverride[k].includes(card.id));
        if (container) {
          const ids = cardOrderOverride[container];
          const idx = ids.indexOf(card.id);
          // Reorder inside the working membership relative to the neighbours'
          // effective positions (midpoint), the exact rule the server sorts by.
          const neighbour = (i: number): number | null => {
            const c = i >= 0 && i < ids.length ? cardById.get(ids[i]) : undefined;
            return c && c.id !== card.id ? effPos(c) : null;
          };
          const before = neighbour(idx - 1);
          const after = neighbour(idx + 1);
          let position: number | null = null;
          if (before !== null && after !== null) position = (before + after) / 2;
          else if (before !== null) position = before + 60_000;
          else if (after !== null) position = after - 60_000;
          const moved = container !== card.list;
          if (moved || position !== null) {
            const body: Record<string, unknown> = { rev: card.rev };
            if (moved) body.list = container;
            if (position !== null) body.position = position;
            await api.patch(card.id, body);
          }
        }
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      dragActiveRef.current = false;
      markDragJustEnded();
      await load();
      setCardOrderOverride(null);
      setColOrderOverride(null);
    }
  }

  function onDragCancel() {
    dragActiveRef.current = false;
    markDragJustEnded();
    setActiveDrag(null);
    setCardOrderOverride(null);
    setColOrderOverride(null);
  }

  if (err && !board) {
    return (
      <>
        <TopBar onNew={() => setOverlay({ kind: "new" })} status="error" />
        <div className="banner">Could not load the board: {err}</div>
      </>
    );
  }

  return (
    <>
      <TopBar onNew={() => setOverlay({ kind: "new" })} status={board ? `${board.cards.length} cards` : "loading…"} />
      {runtime?.noGateway && (
        <div className="banner" role="status">
          No gateway running - agent lists won&apos;t dispatch. Bring the composition up (Run / `npm start`).
        </div>
      )}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}
      <div className="board-scroll">
        <DndContext
          sensors={dndSensors}
          collisionDetection={boardCollisions}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={(e) => void onDragEnd(e)}
          onDragCancel={onDragCancel}
        >
          <div className="board">
            <SortableContext items={displayLists.map((l) => `col:${l.id}`)} strategy={horizontalListSortingStrategy}>
              {displayLists.map((list) => (
                <SortableColumn
                  key={list.id}
                  list={list}
                  className={listClass(list)}
                  header={
                    <div className="lh">
                      <div className="lname">
                        <span className="lname-text">{list.title}</span>
                        <span className="count">{list.cards.length}</span>
                        <button
                          className="gear"
                          title={`Configure ${list.title}`}
                          aria-label={`Configure ${list.title}`}
                          onClick={() => setOverlay({ kind: "config", listId: list.id })}
                        >
                          <GearIcon />
                        </button>
                      </div>
                      <div className="lkind">
                        {list.kind === "agent" && !list.interactive ? (
                          <span className={list.phase?.includes("adversarial") ? "cdx" : "sk"} title="the pipeline phase this list runs; skill/model/effort come from the Orchestrator policy">
                            phase: {list.phase ?? list.id}
                          </span>
                        ) : list.interactive ? (
                          "interactive · web chat"
                        ) : (
                          `${list.kind} · ${list.trigger}`
                        )}
                      </div>
                    </div>
                  }
                >
                  <ListBodyDroppable listId={list.id}>
                    {/* Backlog leads with the inline quick-add affordance (its own empty
                        state), so it never shows the bare "empty" label. */}
                    {list.id === "backlog" && <BacklogAddCard onCreated={() => void load()} />}
                    {list.cards.length === 0 && list.id !== "backlog" && <div className="lempty">empty</div>}
                    {(() => {
                      const renderCard = (card: CardSummary, sortable = true) => {
                        const inner = (
                          <Card
                            key={sortable ? undefined : card.id}
                            card={card}
                            list={list}
                            busy={busyCard === card.id}
                            onStart={onStart}
                            onInfer={onInfer}
                            onDiscuss={onDiscuss}
                            onRevert={onRevert}
                            onMove={(c) => {
                              // Item 2: Move is the MANUAL gate — it ALWAYS opens the sheet, which
                              // now offers every list (not just validNext). Advance is the separate
                              // next-list-only control. No single-target short-circuit: even a
                              // one-exit list shows the picker so a card can be moved anywhere.
                              setOverlay({ kind: "move", card: c });
                            }}
                            onQuickMove={onQuickMove}
                            onWatch={(c) => setOverlay({ kind: "watch", card: c })}
                            onTerminal={(c) => setOverlay({ kind: "terminal", card: c })}
                            onOpen={(c) => setOverlay({ kind: "detail", cardId: c.id })}
                            onContinue={onContinue}
                            onDrill={onDrill}
                            onFeedback={(c) => setOverlay({ kind: "feedback", card: c })}
                            dragJustEnded={dragJustEndedRef}
                          />
                        );
                        return sortable ? (
                          <SortableCardWrap key={card.id} card={card} listId={list.id}>
                            {inner}
                          </SortableCardWrap>
                        ) : inner;
                      };
                      // D19: the Done column groups quick cards (trivial-plan inline tasks)
                      // under a collapsed "quick tasks" strip so the real runs stay legible.
                      // Quick cards are not drag-sortable (they are archive, not queue).
                      const mainCards = list.id === "done" ? list.cards.filter((c) => !c.quick) : list.cards;
                      const quickCards = list.id === "done" ? list.cards.filter((c) => c.quick) : [];
                      return (
                        <SortableContext items={mainCards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                          {mainCards.map((c) => renderCard(c))}
                          {quickCards.length > 0 && (
                            <details className="quick-strip">
                              <summary className="quick-strip-head">
                                <span className="quick-strip-title">quick tasks</span>
                                <span className="count">{quickCards.length}</span>
                              </summary>
                              <div className="quick-strip-body">{quickCards.map((c) => renderCard(c, false))}</div>
                            </details>
                          )}
                        </SortableContext>
                      );
                    })()}
                  </ListBodyDroppable>
                </SortableColumn>
              ))}
            </SortableContext>
            {/* Trello-style "+ Add list": a new column IS a new composition-local
                duty; the sheet says so and the shell owns the write. */}
            <section className="list add-list">
              <button className="add-list-btn" onClick={() => setOverlay({ kind: "addlist" })}>
                <PlusIcon /> Add list
              </button>
            </section>
          </div>
          <DragOverlay>
            {activeDrag?.type === "card" ? (
              <div className="card drag-ghost">
                <div className="ct">
                  <span className="title">{activeDrag.card.title}</span>
                </div>
                {activeDrag.card.project && <div className="cmeta"><span className="chip">{activeDrag.card.project}</span></div>}
              </div>
            ) : activeDrag?.type === "column" ? (
              <div className="list drag-ghost-col">
                <div className="lh"><div className="lname"><span className="lname-text">{displayLists.find((l) => l.id === activeDrag.listId)?.title ?? activeDrag.listId}</span></div></div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {overlay?.kind === "new" && (
        <NewCardSheet onClose={() => setOverlay(null)} onCreated={() => void load()} />
      )}
      {overlay?.kind === "move" && board && (
        <MoveSheet card={overlay.card} board={board} onClose={() => setOverlay(null)} onMoved={() => void load()} />
      )}
      {overlay?.kind === "detail" && (
        <DetailSheet
          cardId={overlay.cardId}
          board={board}
          onClose={() => setOverlay(null)}
          onChanged={() => void load()}
          onWatch={(c) => setOverlay({ kind: "watch", card: c })}
          onTerminal={(c) => setOverlay({ kind: "terminal", card: c })}
        />
      )}
      {overlay?.kind === "watch" && (
        <WatchSheet
          card={overlay.card}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === "terminal" && (
        <TerminalModal card={overlay.card} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === "config" && board && (
        <ListConfigSheet listId={overlay.listId} board={board} onClose={() => setOverlay(null)} onSaved={() => void load()} />
      )}
      {overlay?.kind === "feedback" && board && (
        <FeedbackSheet card={overlay.card} board={board} onClose={() => setOverlay(null)} onSent={() => void load()} />
      )}
      {overlay?.kind === "addlist" && (
        <AddListSheet onClose={() => setOverlay(null)} onCreated={() => void load()} />
      )}
    </>
  );
}

function TopBar({ onNew, status }: { onNew: () => void; status: string }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark"><BoardMark /></span>
        <span className="brand-text">
          <span className="name">Kanban Loop</span>
          <span className="sub">Workflow Board</span>
        </span>
      </div>
      <span className="status">{status}</span>
      <div className="spacer" />
      <button className="btn primary" onClick={onNew}><PlusIcon /> New card</button>
    </header>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
