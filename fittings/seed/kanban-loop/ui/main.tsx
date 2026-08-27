// Kanban Loop board UI — responsive, phone-first (the v4 wireframe is the spec).
// Lists are columns in a horizontally-scrollable board; each card front shows
// title, project chip, list, iter N/cap, goalMode and the actions:
// Start/Advance · Move · Raw log. Clicking the card body opens its detail sheet,
// whose body is the card's CONVERSATION - the append-only ledger every stretch
// wrote, with the composer that writes the next message into it - plus the
// decision-10 LINKS (plan, brief, transcripts, gate markers, screenshots, video)
// and the small decision log; the card LINKS its artifacts, never inlines their
// bodies (FINDING 10). Under the conversation sits the raw layer: the card's
// phase log over SSE, in its own sheet - it never tmux-attaches.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import { SessionStream as SharedSessionStream, RoutingModal, type TurnRouting } from "@garrison/claude-chat";
import { applyPinPatch, pinnedSummary, railOptionsFor } from "./run-spec";
import {
  scheduleUrgency,
  urgencyClass,
  dueInstant,
  releaseInstant,
  hasSplitDeadline,
  dueOffsetFromInstants,
  type ScheduleUrgency
} from "./schedule-urgency";
import { DateTimePicker, RecurrenceBuilder, defaultRecurrence, type RecurrenceRule } from "./date-picker";
// @ts-ignore — pure .mjs, bundled by esbuild alongside the UI
import { describeRecurrence, nextRecurrenceOccurrence } from "../lib/recurrence.mjs";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
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
  type CardSchedule,
  type CardDetail,
  type CardEvent,
  type ChecklistItem,
  type CardImportPreview,
  type RouteStamp,
  type ListView,
  type ListConfig,
  type ListConfigPatch,
  type ArtifactRef,
  type PolicyView,
  type CardRouting,
  type RouteOptionsView,
  type MachinesView,
  type MachineOption,
  type LoadoutReadiness,
  type LoadoutEditorValue,
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
  ChevronIcon,
  PencilIcon,
  BoardMark
} from "./icons";
import { TerminalPane } from "./terminal-pane";
import { CardConversation, CONVERSATION_BASE } from "./card-conversation";
import { HistoryView } from "./history-view";
import { rewriteHostUrl } from "./host-rewrite";
import { execBadges } from "./exec-badges";
import { deriveMoveTargets, isManualImportTarget } from "./move-targets";
import {
  canAddCardDirectly,
  cardTitleEditAction,
  shouldCommitCardTitleOnBlur,
  shouldOpenCard
} from "./card-click";
import { cardIdFromLocation } from "./card-location";
import { hiddenListCount, visibleLists } from "./list-visibility";
import {
  DRAG_HOLD_MS,
  DRAG_MOUSE_DISTANCE,
  DRAG_HOLD_TOLERANCE_TOUCH,
  shouldActivateDrag
} from "./drag-activation";
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
  if (list.id === "scheduled") return "list scheduled";
  if (list.id === "needs-attention") return "list attn";
  if (list.id === "running" || list.kind === "system") return "list running";
  if (list.kind === "scheduled") return "list manual";
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

// The RELEASE instant — when the card stops being held and lands on its list.
function scheduleAt(card: CardSummary): string | null {
  return releaseInstant(card);
}

// The colour on the card front tracks the DEADLINE, not the release: a card that
// landed on To Do this morning and is due tonight should sit there quietly until
// tonight. With no deadline offset the two instants are the same value, so a
// card that predates the split reads exactly as it always did.
function cardUrgency(card: CardSummary): ScheduleUrgency {
  return scheduleUrgency(dueInstant(card), Date.now(), { enabled: card.schedule?.enabled });
}

// The rule's NEXT release from now — the baseline a deadline offset is
// measured from. Same walker the sweep uses (single authority), so an aged
// rule's baseline is its coming occurrence, never its months-old start day.
// Measuring against the start was the corruption: editing a January rule in
// September computed an offset carrying eight months of drift.
function recurrenceNextInstant(rule: RecurrenceRule, timeZone: string): string | null {
  try {
    return (nextRecurrenceOccurrence(rule, timeZone, new Date()) as { at: string } | null)?.at ?? null;
  } catch {
    return null;
  }
}


function scheduleDue(card: CardSummary): boolean {
  return cardUrgency(card) === "due";
}

// How a recurring schedule reads when there is no cron string to quote — a
// calendar rule has to say itself in words, or the chip prints "undefined".
function repeatLabel(schedule: CardSchedule): string {
  if (schedule.recurrence) return describeRecurrence(schedule.recurrence);
  return schedule.cron ?? "repeats";
}

function scheduleChip(card: CardSummary): string {
  const schedule = card.schedule;
  if (schedule?.kind === "cron") {
    if (!schedule.enabled) return `paused · ${repeatLabel(schedule)}`;
    return `${fmtSchedule(schedule.nextAt)} · repeats`;
  }
  return fmtSchedule(scheduleAt(card));
}

// The DEADLINE chip, shown only when it is a different moment from the release.
// This is the one the card asked to "turn yellow a few minutes before due and
// red when due, in a big highlighted fashion".
function dueChip(card: CardSummary): string {
  return `due ${fmtSchedule(dueInstant(card))}`;
}

// Stable card-detail URL used by schedule provenance links. The click is
// handled in-place when the board is already open, while the href keeps the
// relationship navigable in a new tab and after a reload.
function scheduleCardHref(cardId: string): string {
  return `?card=${encodeURIComponent(cardId)}`;
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
// A clipboard image has no filename, so invent a stable, sortable, extension-
// correct one rather than sending "" (which the server rejects).
function pastedFileName(file: File): string {
  const ext = (file.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pasted-${stamp}.${ext}`;
}

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

// A textarea that starts one line tall and grows with its content, and whose
// Enter key does what the button beside it does.
//
// Both halves are deliberate. The fixed `rows={4}`/`rows={6}` boxes these replace
// reserved four to six empty lines for a one-line item and still needed an inner
// scrollbar for a long one, so the box was wrong at both ends. And requiring
// Cmd/Ctrl+Enter to submit meant the obvious key did nothing at all - Enter just
// inserted a newline into a field whose whole job was one item. Enter now
// submits; Shift+Enter (and Cmd/Ctrl+Enter, which people have in their fingers)
// still inserts a newline, so multi-paragraph text is still reachable.
function AutoTextarea({
  value,
  onChange,
  onSubmit,
  onCancel,
  maxRows = 16,
  ...rest
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  maxRows?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows" | "style">) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Measured, not counted: a soft-wrapped long line occupies several rows that
  // splitting on "\n" would miss, which is exactly the case that used to scroll.
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.style.height = `${Math.min(el.scrollHeight, Math.round(line * maxRows))}px`;
  }, [maxRows]);
  useEffect(resize, [value, resize]);
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); return; }
        if (e.key !== "Enter") return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) return; // deliberate newline
        if (!onSubmit) return;
        e.preventDefault();
        onSubmit();
      }}
      style={{ width: "100%", minWidth: 0, resize: "none", overflowY: "auto" }}
    />
  );
}

// Which actions a card offers, derived from the card + the list it sits on.
//
// Pure and shared, because the card front and the opened card both render the
// SAME action row (CardActions). Two copies of these booleans is exactly how the
// two surfaces would drift into offering different things for one card.
function cardActionFlags(card: CardSummary, list: ListView) {
  // Conversations: a card is the human's to move EXCEPT while a stretch holds
  // it. That is the whole ownership model now — no engine-owned columns, one bit.
  const launcherHeld = card.status === "running" || list.id === "running";
  const engineOwned = launcherHeld;
  const scheduled = list.id === "scheduled";
  const archived = false; // the Archived column is gone (frozen history holds the old one)
  const running = card.status === "running";
  const inferring = card.inferState === "running";
  return {
    engineOwned,
    scheduled,
    archived,
    running,
    inferring,
    // Advance shows on MANUAL lists (Backlog, To Do, needs-attention) — that is how a
    // card ENTERS the automated flow (To Do → Plan) or is re-sent after parking.
    // Discuss (interactive) uses the web chat + Move; Done (terminal) has nowhere to go.
    canAdvance: false, // retired: Start kicks the conversation; moves are drag/Move
    startLabel: "Start",
    // "Mark done": a one-click finish on any human-held, non-terminal card (Backlog,
    // To Do, Discuss, needs-attention). Engine-owned agent cards can't be moved by
    // hand (the API rejects it), and a card already on a terminal list has nowhere to go.
    canMarkDone: !scheduled && !launcherHeld && !list.terminal,
    // "Archive": get a card out of the way. Available on any human-held column, not
    // just Done and needs-attention - a Backlog item you have decided against is the
    // most common thing you want to file away, and it previously had no Archive at
    // all. Still withheld from engine-owned cards (the API rejects a hand-move of a
    // card an autonomous list owns) and from the Archived column itself.
    canArchive: false, // Archive is retired: Done or Delete
    // A persisted dispatch failure (gateway unreachable / transport defer): a red chip +
    // inline reason, so a failed dispatch shows on the CARD.
    dispatchErr: card.lastDispatchError,
    // RUN: start a card's activity on demand on ANY agent list (Plan…Validate, incl. the
    // batched/scheduler-beat Test) — no need to wait for a trigger/tick. Shows on a
    // non-running agent-list card that isn't parked (a parked card is recovered via the
    // needs-attention column's Advance/Move, and the batch path skips needs-attention
    // cards, so offering Run there would be a no-op); reads "Retry" after a dispatch error.
    // START: kick the card's conversation. Any non-running card off the
    // scheduled column can start (needs-attention resumes via the launcher).
    canRun: !scheduled && !running && !list.terminal,
    // Why a parked card is in the needs-attention column.
    parked: card.status === "needs-attention",
    // Offer "Infer" on a no-project card that isn't mid-inference (the visible attempt
    // the user asked for — also lets them re-try if it came back blank).
    canInfer: !scheduled && !card.project && !card.runId && !inferring && !running
  };
}

// Every action a card offers, in one row. Rendered by BOTH the card front and the
// bottom of the opened card, so the two can never offer different things.
interface CardActionHandlers {
  onStart: (c: CardSummary) => void;
  onApprove: (c: CardSummary) => void;
  onMove: (c: CardSummary) => void;
  onQuickMove: (c: CardSummary, listId: string) => void;
  onDelete: (c: CardSummary) => void;
  onWatch: (c: CardSummary) => void;
  onTerminal: (c: CardSummary) => void;
  onInfer: (c: CardSummary) => void;
  onDiscuss: (c: CardSummary) => void;
  onContinue: (c: CardSummary) => void;
  onDrill: (c: CardSummary) => void;
  onFeedback: (c: CardSummary) => void;
  onRunSchedule: (c: CardSummary) => void;
}

function CardActions({
  card,
  list,
  busy,
  withId = false,
  iconOnly = false,
  handlers
}: {
  card: CardSummary;
  list: ListView;
  busy: boolean;
  withId?: boolean;
  // Card FRONT passes iconOnly: the labels collapse to visually-hidden text (kept
  // for the accessibility tree) so the row reads as compact icon buttons and stops
  // hogging the card surface. The DetailSheet footer leaves it off and keeps labels.
  iconOnly?: boolean;
  handlers: CardActionHandlers;
}) {
  const {
    canAdvance, startLabel, archived, canMarkDone, canArchive,
    dispatchErr, canRun, canInfer, engineOwned, scheduled
  } = cardActionFlags(card, list);
  const h = handlers;
  return (
    <div className={`btns${iconOnly ? " icon-only" : ""}`}>
      {scheduled && card.schedule && (
        <button className="btn primary small" disabled={busy} title={card.schedule.kind === "cron" ? "create an extra occurrence without changing the next regular run" : "release this card to run now"} onClick={() => h.onRunSchedule(card)}>
          <PlayIcon /> <span className="btn-label">Run now</span>
        </button>
      )}
      {/* Mark done: skip the pipeline and call a human-held card finished in one
          click — the "just a button on the card" path. */}
      {canMarkDone && (
        <button className="btn small ok" disabled={busy} title="mark this card done" onClick={() => h.onQuickMove(card, "done")}>
          <CheckIcon /> <span className="btn-label">Done</span>
        </button>
      )}
      {canAdvance && (
        <button className="btn primary small" disabled={busy} title={startLabel} onClick={() => h.onStart(card)}>
          <PlayIcon /> <span className="btn-label">{startLabel}</span>
        </button>
      )}
      {canRun && (
        <button
          className="btn primary small"
          disabled={busy}
          title={dispatchErr ? "start this card's conversation again" : "start this card's conversation"}
          onClick={() => h.onStart(card)}
        >
          <PlayIcon /> <span className="btn-label">{dispatchErr ? "Retry" : "Start"}</span>
        </button>
      )}
      {canInfer && !engineOwned && (
        <button className="btn small" disabled={busy} title="infer the project from the description" onClick={() => h.onInfer(card)}>
          <SparkIcon /> <span className="btn-label">Infer</span>
        </button>
      )}
      {!engineOwned && !scheduled && (
        <button className="btn small" disabled={busy} title="move this card to another list" onClick={() => h.onMove(card)}>
          <MoveIcon /> <span className="btn-label">Move</span>
        </button>
      )}
      {/* The conversation is the way into a card's activity: ONE button opening
          the focused conversation modal. The raw log moved into that surface's
          header, so the card front carries no log button. */}
      <button className="btn small primary" title="open this card's conversation" onClick={() => h.onDiscuss(card)}>
        <ChatIcon /> <span className="btn-label">Discuss</span>
      </button>
      {/* Terminal opens in the card's real project, or in the dedicated
          personal workspace when a personal card has no project. */}
      {(card.project || card.scope === "personal") && (
        <button className="btn small" title="open an interactive shell in this card's project or personal workspace" onClick={() => h.onTerminal(card)}>
          <TerminalIcon /> <span className="btn-label">Terminal</span>
        </button>
      )}
      {/* Feedback: write a note and send THIS card back through the pipeline with the
          same context (runDir + prior logs preserved). The "it reached the end but
          forgot part of the feature — send it back to fix it" path. Shown once a card
          has stopped: on Done (terminal) or parked in needs-attention. */}
      {((list.terminal && !archived) || card.status === "needs-attention") && (
        <button className="btn small" disabled={busy} title="write feedback and send this card back through the pipeline with the same context" onClick={() => h.onFeedback(card)}>
          <MailIcon /> <span className="btn-label">Feedback</span>
        </button>
      )}
      {/* WS2 (D7): a DONE card can spawn a continuation whose starting context is
          seeded from this card's handoff packet. */}
      {list.terminal && !archived && (
        <button className="btn small primary" disabled={busy} title="create a new card that continues this one's work" onClick={() => h.onContinue(card)}>
          <PlayIcon /> <span className="btn-label">Continue</span>
        </button>
      )}
      {canArchive && (
        <button className="btn small" disabled={busy} title="move this card to the Archived column" onClick={() => h.onQuickMove(card, "archived")}>
          <ArchiveIcon /> <span className="btn-label">Archive</span>
        </button>
      )}
      {/* Unarchive: bring an archived card back onto the board (To Do). */}
      {archived && (
        <button className="btn small" disabled={busy} title="move this card back to To Do" onClick={() => h.onQuickMove(card, "todo")}>
          <UnarchiveIcon /> <span className="btn-label">Unarchive</span>
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
          onClick={() => h.onDrill(card)}
        >
          <DrillIcon /> <span className="btn-label">{card.drill ? "Re-drill" : "Send to Drill"}</span>
        </button>
      )}
      <ShareCardButton card={card} withId={withId} />
      {/* Delete is last and never `primary`: it is the one irreversible action in
          this row, so it should be the hardest to hit by accident. */}
      <button
        className="btn small danger"
        disabled={busy}
        title="delete this card and its run history"
        onClick={() => h.onDelete(card)}
      >
        <CloseIcon /> <span className="btn-label">Delete</span>
      </button>
      {/* Item 5: the Open button is gone — clicking the card body opens it (see the
          card root's onClick above). */}
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
  onDelete,
  onWatch,
  onTerminal,
  onOpen,
  onRenamed,
  onInfer,
  onDiscuss,
  onApprove,
  onRevert,
  onContinue,
  onDrill,
  onFeedback,
  onRunSchedule,
  dragJustEnded,
  busy
}: {
  card: CardSummary;
  list: ListView;
  onStart: (c: CardSummary) => void;
  onApprove: (c: CardSummary) => void;
  onMove: (c: CardSummary) => void;
  // Direct one-click move to a named list (Mark done → done, Archive → archived,
  // Unarchive → todo). Distinct from onMove, which asks when there is a choice.
  onQuickMove: (c: CardSummary, listId: string) => void;
  onDelete: (c: CardSummary) => void;
  onWatch: (c: CardSummary) => void;
  onTerminal: (c: CardSummary) => void;
  onOpen: (c: CardSummary) => void;
  onRenamed: () => Promise<void>;
  onInfer: (c: CardSummary) => void;
  onDiscuss: (c: CardSummary) => void;
  onRevert: (c: CardSummary) => void;
  onContinue: (c: CardSummary) => void;
  onDrill: (c: CardSummary) => void;
  onFeedback: (c: CardSummary) => void;
  onRunSchedule: (c: CardSummary) => void;
  // Item 5: the drag-just-ended flag from App, so the card-body click handler can
  // suppress the trailing click a completed drag synthesises.
  dragJustEnded: MutableRefObject<boolean>;
  busy: boolean;
}) {
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleEditRevision = useRef<number | null>(null);
  const titleEditJustEnded = useRef(false);
  // Conversations: a card is held by the LAUNCHER only while a stretch runs on
  // it; every other card is the human's to edit and move.
  const engineOwned = card.status === "running" || list.id === "running";
  const scheduled = list.id === "scheduled";

  function markTitleEditEnded() {
    titleEditJustEnded.current = true;
    setTimeout(() => { titleEditJustEnded.current = false; }, 0);
  }

  function cancelTitleEdit() {
    if (savingTitle) return;
    markTitleEditEnded();
    titleEditRevision.current = null;
    setTitleDraft(null);
    setTitleError(null);
  }

  async function saveCardTitle() {
    if (savingTitle || titleDraft === null || engineOwned) return;
    const title = titleDraft.trim();
    if (!title) {
      setTitleError("Give the card a title.");
      return;
    }
    if (title === card.title) {
      cancelTitleEdit();
      return;
    }
    setSavingTitle(true);
    setTitleError(null);
    try {
      // Polling can refresh `card.rev` while the editor stays open. The revision
      // captured when editing began is the CAS token; using the newer prop here
      // would let a stale draft overwrite an intervening rename.
      await api.patch(card.id, { title, rev: titleEditRevision.current ?? card.rev });
      await onRenamed();
      markTitleEditEnded();
      titleEditRevision.current = null;
      setTitleDraft(null);
    } catch (e) {
      setTitleError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTitle(false);
    }
  }
  const {
    canAdvance, startLabel, archived, canMarkDone, canArchive,
    dispatchErr, running, canRun, parked, inferring, canInfer
  } = cardActionFlags(card, list);
  const lastEv = card.lastEvent;
  return (
    <div
      className={`card${running ? " running" : ""}${parked ? " parked" : ""}`}
      // Item 5: click the card body to open its detail (the dedicated Open button is
      // gone). shouldOpenCard ignores clicks on any interactive control (the card's
      // 15+ buttons / links / fields, whose clicks bubble here) and the trailing click
      // a drag synthesises. Placed on the card ROOT — not the sortable wrapper — so
      // the Done-column quick-strip cards (rendered without the wrapper) open too.
      onClick={(e) => {
        if (titleDraft !== null || titleEditJustEnded.current) return;
        if (shouldOpenCard(e.target as EventTarget, dragJustEnded.current)) onOpen(card);
      }}
    >
      <div className="ct">
        <span className={dotClass(card)} aria-hidden />
        {titleDraft === null ? (
          <>
            <button
              className="title card-title-open"
              title="Open card details"
              aria-label={`Open card details: ${card.title}`}
              // No stopPropagation on the PRESS: the title is the widest, most
              // natural place to grab a card, and swallowing the press here made
              // press-and-hold do nothing across the top of every card. The hold
              // only wins once it has actually activated a drag, and dnd-kit
              // swallows that gesture's trailing click.
              //
              // The title no longer doubles as the rename affordance — tapping it
              // opens the card (rename now lives behind the explicit pencil). Keep
              // the button's Enter/Space activation from also reaching the sortable
              // wrapper's keyboard sensor and starting a drag.
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(card);
              }}
            >
              {card.title}
            </button>
            {/* Explicit rename affordance. Hidden on an engine-owned or busy card,
                whose title is locked (the API rejects a rename there too). */}
            {!engineOwned && !busy && (
              <button
                type="button"
                className="card-rename"
                title="Rename card"
                aria-label={`Rename card: ${card.title}`}
                onKeyDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setTitleError(null);
                  titleEditRevision.current = card.rev;
                  setTitleDraft(card.title);
                }}
              >
                <PencilIcon />
              </button>
            )}
          </>
        ) : (
          <div
            // The press is kept off the drag sensor by DRAG_EXEMPT_ANCESTORS
            // (this class is on that list), not by stopping the event here -
            // one rule, in one place, whichever sensor is listening.
            className="card-title-editor"
            onClick={(e) => e.stopPropagation()}
            // The whole card is dnd-kit's keyboard activator. Keep ordinary
            // editing keys (especially Space) and button activation inside the
            // editor instead of bubbling into SortableCardWrap and starting a
            // keyboard drag. Do not preventDefault: inputs/buttons retain their
            // native editing and activation behavior.
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const staysInside = e.relatedTarget != null && e.currentTarget.contains(e.relatedTarget as Node);
              if (shouldCommitCardTitleOnBlur(staysInside) && !titleEditJustEnded.current) {
                void saveCardTitle();
              }
            }}
          >
            <input
              className="card-title-input"
              aria-label={`Edit title for ${card.title}`}
              aria-invalid={Boolean(titleError)}
              value={titleDraft}
              autoFocus
              disabled={savingTitle}
              onChange={(e) => {
                setTitleDraft(e.target.value);
                if (titleError) setTitleError(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                const action = cardTitleEditAction(e.key);
                if (!action) return;
                e.preventDefault();
                e.stopPropagation();
                if (action === "save") void saveCardTitle();
                else cancelTitleEdit();
              }}
            />
            <button
              type="button"
              className="card-title-action save"
              aria-label="Save card title"
              disabled={savingTitle || !titleDraft.trim()}
              onClick={() => void saveCardTitle()}
            >
              Save
            </button>
            <button
              type="button"
              className="card-title-action"
              aria-label="Cancel title editing"
              disabled={savingTitle}
              onClick={cancelTitleEdit}
            >
              Cancel
            </button>
          </div>
        )}
        {titleDraft === null && fmtCardDate(card.id) && <span className="ct-date" title="created">{fmtCardDate(card.id)}</span>}
      </div>
      {titleError && <div className="card-title-error" role="alert">{titleError}</div>}
      <div className="cmeta">
        {card.project
          ? <span className="chip" title="project">{card.project}</span>
          : <span className="chip muted" title="no project assigned">no project</span>}
        {card.scope === "personal" && <span className="chip goal" title="personal task">personal</span>}
        {inferring && <span className="chip infer" title="inferring the project from the description"><SparkIcon /> inferring project…</span>}
        {parked && <span className="chip attn">needs-attention</span>}
        {card.steeringPending && <span className="chip steering" title="a mid-run revisit directive is pending — the card will re-stage at the next duty boundary">steering</span>}
        {card.waitingOn && <span className="chip waiting" title={card.waitingOn.reason}>waiting</span>}
        {card.blocking && card.blocking.length > 0 && (
          <span className="chip" title={`${card.blocking.length} card(s) are waiting on this one`}>blocks {card.blocking.length}</span>
        )}
        {card.parkedFrom && <span className="chip" title="the list it parked from">from {card.parkedFrom}</span>}
        {card.status === "running" && card.duty && (
          <span className="chip" title="the duty the current stretch is running">duty: {card.duty}</span>
        )}
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {card.autonomous && (
          <span className="chip chip-toggle on" title="Autonomous — runs end to end without asking. Toggle it in the card.">
            autonomous
          </span>
        )}
        {/* With a deadline offset the front carries TWO chips: when the card
            LANDS (quiet — it is only placement) and when it is DUE (the one
            that goes amber then red). Without one, the single chip below keeps
            the urgency colour exactly as it always did. */}
        {hasSplitDeadline(card) && (
          <span
            className={`chip sched due-chip${urgencyClass(cardUrgency(card))}`}
            title={`due ${dueInstant(card)} — landed on this list at ${scheduleAt(card)}`}
          >
            <ClockIcon /> {dueChip(card)}
          </span>
        )}
        {(card.schedule || card.scheduledFor) && (
          <span
            className={`chip sched${hasSplitDeadline(card) ? " muted" : urgencyClass(cardUrgency(card))}`}
            title={
              hasSplitDeadline(card)
                ? `lands on its list at ${scheduleAt(card)}; the deadline is the chip beside it`
                : scheduleDue(card)
                ? `scheduled for ${scheduleAt(card)} - due${card.scheduleNotifiedAt ? ", reminder sent" : ""}`
                : cardUrgency(card) === "soon"
                ? `scheduled for ${scheduleAt(card)} - due in minutes`
                : card.schedule?.kind === "cron"
                  ? `${card.schedule.enabled ? "recurring" : "paused"}: ${repeatLabel(card.schedule)} (${card.schedule.timezone})`
                  : `held until ${scheduleAt(card)} (${card.scheduleAction === "run" ? "runs automatically" : "notifies"})`
            }
          >
            <ClockIcon /> {scheduleChip(card)}{card.scheduleAction === "run" ? " · auto" : ""}
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
        {card.flow && <span className="chip" title="flow (the policy phase plan this run follows)">{card.flow}</span>}
        {engineOwned && <span className="chip muted" title="The launcher owns this card while its conversation runs (D16). It becomes editable if it parks in Needs input.">launcher-held</span>}
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

      {/* THE APPROVAL ASK — the conversation planned, paused, and wants a nod.
          Loud on purpose: this is the one moment the card needs a human, so it
          reads at a glance (what runs next + the plan) and approves in ONE
          click right here. The nod is a real conversation message, the same
          thing typing "go ahead" into the composer does. */}
      {card.awaitingApproval && !running && (
        <div className="approval-ask">
          <div className="aa-head">Waiting for your approval</div>
          <div className="aa-next">next: {card.awaitingApproval.next}</div>
          {card.awaitingApproval.plan && <p className="aa-plan">{card.awaitingApproval.plan}</p>}
          {card.awaitingApproval.items.length > 0 && (
            <ul className="aa-items">
              {card.awaitingApproval.items.slice(0, 4).map((item, i) => <li key={i}>{item}</li>)}
              {card.awaitingApproval.items.length > 4 && (
                <li className="muted">+{card.awaitingApproval.items.length - 4} more</li>
              )}
            </ul>
          )}
          <div className="aa-actions">
            <button className="btn primary" disabled={busy} title="approve the plan and let the conversation continue" onClick={() => onApprove(card)}>
              <PlayIcon /> Approve &amp; continue
            </button>
            <button className="btn small" disabled={busy} title="open the conversation before deciding" onClick={() => onDiscuss(card)}>
              Review first
            </button>
          </div>
        </div>
      )}

      {/* LIVE run state: a running pill with a ticking elapsed timer + the live log
          tail, so the card shows the operative WORKING (not just a pulsing dot). */}
      {running && (
        <div className="run-live">
          <div className="run-head">
            <span className="run-spin" aria-hidden />
            {/* The list IS "Running", so naming it here read "running on Running".
                The pill says what matters: work is live, for this long. */}
            <span>running</span>
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

      <CardActions
        card={card}
        list={list}
        busy={busy}
        iconOnly
        handlers={{
          onStart, onApprove, onMove, onQuickMove, onDelete, onWatch, onTerminal,
          onInfer, onDiscuss, onContinue, onDrill, onFeedback, onRunSchedule
        }}
      />
    </div>
  );
}

// The card's stable id, shown so it can be quoted to an agent, plus a link that
// reopens the board with this card's modal already open. One control: clicking
// copies the link, and the id itself is selectable text for the "paste the uid
// into a prompt" case that motivated it.
function ShareCardButton({ card, withId = false }: { card: CardSummary; withId?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function share() {
    // Built from the CURRENT location so it is right in every context the board
    // runs in - direct on its own port, embedded in Garrison, or over the tailnet.
    // A hardcoded host would be unreachable from the phone that most often
    // receives one of these links.
    const url = new URL(window.location.href);
    url.searchParams.set("card", card.id);
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      setCopied("Link copied");
    } catch {
      // Clipboard is unavailable on an insecure origin or without permission;
      // showing the link still lets it be copied by hand rather than failing mute.
      window.prompt("Copy this card's link:", link);
      setCopied(null);
      return;
    }
    setTimeout(() => setCopied(null), 1600);
  }
  return (
    <>
      {withId && <code className="card-uid" title="this card's id — quote it to an agent">{card.id}</code>}
      <button className="btn small" title="copy a link that opens this card" onClick={share}>
        <LinkIcon /> <span className="btn-label">{copied ?? "Share"}</span>
      </button>
    </>
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
  options: { value: string; label: string; detail?: string; disabled?: boolean }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="spec-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={Boolean(disabled)} onChange={(e) => onChange(e.target.value)}>
        <option value={AUTO}>Automatic{hint ? ` — ${hint}` : ""}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
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
  optionsError,
  emphasise = false
}: {
  spec: CardRouting;
  setSpec: (next: CardRouting) => void;
  options: RouteOptionsView | null;
  optionsError: string | null;
  /** A card parked in Needs Attention wants its routing looked at — the summary
   *  is drawn to the eye rather than a dialog being opened over the card the
   *  user just asked to read. */
  emphasise?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The SAME console the Web Channel edits a conversation's pins with, fed the
  // SAME gateway vocabulary. Everything board-specific lives in the two pure
  // translations in ./run-spec — nothing is re-implemented here.
  const rail = useMemo(() => railOptionsFor(options, optionsError), [options, optionsError]);
  const pins = useMemo(() => pinnedSummary(spec), [spec]);
  return (
    <div className={`field spec-console${emphasise ? " spec-console-emph" : ""}`}>
      <button
        type="button"
        className="spec-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Run spec
        <span className="muted">
          {pins.length === 0 ? "everything automatic" : `${pins.length} chosen, the rest automatic`}
        </span>
      </button>
      {pins.length > 0 && (
        <div className="spec-pins">
          {pins.map((p) => (
            <span key={p.field} className="chip mono" title={p.field}>{p.label}</span>
          ))}
        </div>
      )}
      {open && (
        <RoutingModal
          pins={spec as TurnRouting}
          options={rail}
          onPin={(patch) => setSpec(applyPinPatch(spec, patch))}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function normaliseLoadoutEditor(value: LoadoutEditorValue): LoadoutEditorValue {
  return {
    id: value.id,
    repo_remote: value.repo_remote || "",
    default_branch: value.default_branch || "",
    ...(value.apm_manifest_path ? { apm_manifest_path: value.apm_manifest_path } : {}),
    setup_commands: Array.isArray(value.setup_commands) ? value.setup_commands : [],
    env_vars: Array.isArray(value.env_vars) ? value.env_vars : [],
    verify_command: value.verify_command || "",
    ...(value.projects_root_override ? { projects_root_override: value.projects_root_override } : {})
  };
}

function routeRuntimeRequirement(route: RouteStamp | null | undefined) {
  if (!route?.runtime) return null;
  return {
    key: `${route.runtime}:${route.provider || "unknown"}`,
    targetId: route.targetId || "resolved target",
    runtime: route.runtime,
    provider: route.provider || null,
    model: route.model || null
  };
}

function machineSupportsRuntime(machine: MachineOption | null | undefined, requirement: { key: string } | null | undefined) {
  if (!machine?.worker?.ready || machine.worker.stale === true) return false;
  return Boolean(requirement && Array.isArray(machine.worker.runtimes) && machine.worker.runtimes.includes(requirement.key));
}

/** Remote placement preflight. The host resolves vault NAMES and repository
 * facts; this form never receives or accepts a secret value. */
function LoadoutPanel({ project, active, onReady }: {
  project: string;
  active: boolean;
  onReady: (ready: boolean | null) => void;
}) {
  const [readiness, setReadiness] = useState<LoadoutReadiness | null>(null);
  const [draft, setDraft] = useState<LoadoutEditorValue | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let alive = true;
    if (!active || !project.trim()) {
      setReadiness(null);
      setDraft(null);
      setEditing(false);
      setError(null);
      onReadyRef.current(null);
      return () => { alive = false; };
    }
    setLoading(true);
    setError(null);
    onReadyRef.current(null);
    api.loadoutReadiness(project.trim())
      .then((value) => {
        if (!alive) return;
        setReadiness(value);
        if (value.editor) setDraft(normaliseLoadoutEditor(value.editor));
        onReadyRef.current(value.ready);
      })
      .catch((reason) => {
        if (!alive) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setReadiness({ project, ready: false, status: "unavailable", detail: message });
        setDraft(null);
        onReadyRef.current(false);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, project, reload]);

  async function save() {
    if (!draft) return;
    if (!draft.repo_remote.trim() || !draft.default_branch.trim() || !draft.verify_command.trim()) {
      setError("Repository remote, default branch, and an explicit verify command are required. Garrison will not guess them.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.saveLoadout(project, {
        ...draft,
        id: project,
        repo_remote: draft.repo_remote.trim(),
        default_branch: draft.default_branch.trim(),
        setup_commands: draft.setup_commands.map((line) => line.trim()).filter(Boolean),
        env_vars: draft.env_vars.map((line) => line.trim()).filter(Boolean),
        verify_command: draft.verify_command.trim()
      });
      setEditing(false);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  if (!active || !project.trim()) return null;
  return (
    <div className={`loadout-panel ${readiness?.ready ? "ready" : "blocked"}`} aria-live="polite">
      <div className="loadout-head">
        <b>Project Loadout</b>
        <span className={`chip ${readiness?.ready ? "ok" : "alarm"}`}>
          {loading ? "checking" : readiness?.ready ? "ready" : "blocked"}
        </span>
      </div>
      <p>{loading ? `Checking ${project} on the host…` : readiness?.detail || "Loadout readiness has not been proven."}</p>
      {readiness?.missing?.length ? (
        <div className="spec-note">Missing vault names: {readiness.missing.join(", ")}</div>
      ) : null}
      {draft && !editing && (
        <button type="button" className="btn small" onClick={() => setEditing(true)}>
          {readiness?.ready ? "Edit Loadout" : "Create / fix Loadout"}
        </button>
      )}
      {editing && draft && (
        <div className="loadout-editor">
          <label>Repository remote
            <input value={draft.repo_remote} onChange={(event) => setDraft({ ...draft, repo_remote: event.target.value })} />
          </label>
          <label>Default branch
            <input value={draft.default_branch} onChange={(event) => setDraft({ ...draft, default_branch: event.target.value })} />
          </label>
          <label>Setup commands <span className="muted">(one per line; blank is allowed)</span>
            <textarea value={draft.setup_commands.join("\n")} onChange={(event) => setDraft({ ...draft, setup_commands: event.target.value.split("\n") })} />
          </label>
          <label>Verify command <span className="muted">(required; never guessed)</span>
            <input value={draft.verify_command} onChange={(event) => setDraft({ ...draft, verify_command: event.target.value })} />
          </label>
          <label>Vault variable names <span className="muted">(one NAME per line; never values)</span>
            <textarea value={draft.env_vars.join("\n")} onChange={(event) => setDraft({ ...draft, env_vars: event.target.value.split("\n") })} />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn small primary" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save and recheck"}
            </button>
            <button type="button" className="btn small" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <div className="dispatch-err">{error}</div>}
    </div>
  );
}

function NewCardSheet({ board, initialPlacement = "", onClose, onCreated }: { board?: BoardView | null; initialPlacement?: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  // Project picker: "auto" = leave blank (the server infers it from the description);
  // "pick" = a repo chosen from the dev-root list; "custom" = a free-typed name/path.
  const [projectMode, setProjectMode] = useState<"auto" | "pick" | "custom">("auto");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [personal, setPersonal] = useState(false);
  const [description, setDescription] = useState("");
  const [goalMode, setGoalMode] = useState(false);
  // Where the card lands: To do is immediate work, Backlog is the human shelf
  // for later. A scheduled card ignores this — its release target is the
  // schedule's own targetList.
  const [destination, setDestination] = useState<"todo" | "backlog">("todo");
  // RUN-SPEC-V1: ONE explicit run spec for the card, in the same shape the Web
  // Channel's Turn Rail pins. It replaces the separate D17 flow select + phase
  // toggles that used to live here (those are now two dimensions of the spec) so
  // there is one place, not two, to decide how a card runs.
  const [spec, setSpec] = useState<CardRouting>({});
  const [options, setOptions] = useState<RouteOptionsView | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // Placement: WHERE the card runs. "" = the host. A bridge connection is not
  // task readiness: remote options stay disabled until their pull worker has
  // published a fresh, runtime-capable readiness pulse.
  const [machines, setMachines] = useState<MachinesView | null>(null);
  const [placement, setPlacement] = useState(initialPlacement);
  const [loadoutReady, setLoadoutReady] = useState<boolean | null>(null);
  // Card scheduling: one-time release or a timezone-aware recurring template.
  const [scheduleKind, setScheduleKind] = useState<"none" | "once" | "cron" | "repeat">("none");
  const [scheduleRec, setScheduleRec] = useState<RecurrenceRule>(() => defaultRecurrence());
  // The DEADLINE, as a local-wall value; "" means due == release, as before.
  const [scheduleDue, setScheduleDue] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 8 * * 1-5");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Lisbon"
  );
  const [scheduleTarget, setScheduleTarget] = useState("todo");
  const [scheduleAction, setScheduleAction] = useState<"notify" | "run">("notify");
  // Files attached at creation: uploaded right AFTER the card exists (the
  // upload endpoint is card-scoped), before the sheet closes.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The repos under the dev-root (dev-env parity). Best-effort — on failure the picker
  // still offers "(auto-infer)" + "Custom project name…".
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
    const scheduledFor = scheduleKind === "once" && scheduleAt ? isoFromLocalInput(scheduleAt) : null;
    if (scheduleKind === "once" && (!scheduleAt || !scheduledFor)) {
      setErr("The schedule time did not parse - pick it again.");
      setSaving(false);
      return;
    }
    if (scheduleKind === "cron" && !scheduleCron.trim()) {
      setErr("Add a five-field cron expression for the recurring schedule.");
      setSaving(false);
      return;
    }
    const selectedMachine = placement ? machines?.machines.find((machine) => machine.name === placement) : null;
    const selectedTarget = spec.target ? options?.targets.find((target) => target.id === spec.target) : null;
    const requiredRuntime = selectedTarget?.runtime
      ? { key: `${selectedTarget.runtime}:${selectedTarget.provider || "unknown"}`, targetId: selectedTarget.id }
      : machines?.defaultRuntime ?? null;
    if (placement && !machineSupportsRuntime(selectedMachine, requiredRuntime)) {
      setErr(selectedMachine?.worker?.ready && requiredRuntime
        ? `${selectedMachine.label} does not advertise ${requiredRuntime.key}, required by ${requiredRuntime.targetId}.`
        : selectedMachine?.worker?.detail || "Enable/Repair the task runner on this Mac before assigning work to it.");
      setSaving(false);
      return;
    }
    if (placement && !proj && !personal) {
      setErr("Choose the project explicitly before assigning this card to another node, so its Loadout can be verified.");
      setSaving(false);
      return;
    }
    if (placement && proj && loadoutReady !== true) {
      setErr("This project is blocked from remote placement until its Loadout and vault preflight pass.");
      setSaving(false);
      return;
    }
    // The deadline is picked as a date but stored as an offset from the release
    // instant, so a recurring card keeps its deadline on every occurrence.
    const releaseForDue = scheduledFor
      ?? (scheduleKind === "repeat" ? recurrenceNextInstant(scheduleRec, scheduleTimezone) : null);
    const dueOffsetMinutes = dueOffsetFromInstants(releaseForDue, isoFromLocalInput(scheduleDue));
    const scheduleCommon = {
      action: scheduleAction,
      timezone: scheduleTimezone,
      enabled: true,
      targetList: scheduleTarget,
      ...(dueOffsetMinutes ? { dueOffsetMinutes } : {})
    };
    const schedule: Omit<CardSchedule, "nextAt" | "lastAt"> | undefined = scheduleKind === "once"
      ? { kind: "once", at: scheduledFor!, ...scheduleCommon }
      : scheduleKind === "repeat"
        ? { kind: "cron", recurrence: scheduleRec, ...scheduleCommon }
        : scheduleKind === "cron"
          ? { kind: "cron", cron: scheduleCron.trim(), ...scheduleCommon }
          : undefined;
    try {
      const created = await api.create({
        title: title.trim() || undefined,
        project: proj,
        ...(personal ? { scope: "personal" as const } : {}),
        description,
        goalMode,
        // Only a plain card names its landing list; a scheduled card's release
        // target is the schedule's targetList and sending both would conflict.
        ...(destination === "backlog" && scheduleKind === "none" ? { targetList: "backlog" as const } : {}),
        ...(Object.keys(routing).length ? { routing } : {}),
        // Absent placement IS "host" on the wire — never send { target: "host" },
        // or every card carries a pin it did not ask for.
        ...(placement ? { placement: { target: placement } } : {}),
        ...(schedule ? { schedule } : {})
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
  const selectedProject = projectMode === "auto" ? "" : project.trim();
  const remotePlacementBlocked = Boolean(
    placement && ((!selectedProject && !personal) || (selectedProject && loadoutReady !== true))
  );
  const selectedTarget = spec.target ? options?.targets.find((target) => target.id === spec.target) : null;
  const requiredRuntime = selectedTarget?.runtime
    ? { key: `${selectedTarget.runtime}:${selectedTarget.provider || "unknown"}`, targetId: selectedTarget.id }
    : machines?.defaultRuntime ?? null;

  return (
    <Sheet title="New card" onClose={onClose}>
      <div className="field">
        <label htmlFor="nc-title">Title <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <input id="nc-title" type="text" value={title} autoFocus
          placeholder="optional — inferred from the description if left blank"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      </div>
      {scheduleKind === "none" && (
        <div className="field">
          <label>List</label>
          <div className="seg" role="radiogroup" aria-label="landing list">
            <button type="button" className={`btn small${destination === "todo" ? " primary" : ""}`}
              aria-pressed={destination === "todo"} onClick={() => setDestination("todo")}>
              To do
            </button>
            <button type="button" className={`btn small${destination === "backlog" ? " primary" : ""}`}
              aria-pressed={destination === "backlog"} onClick={() => setDestination("backlog")}>
              Backlog
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            To do is immediate work; Backlog is the shelf for work you want to keep for later.
          </div>
        </div>
      )}
      <div className="field">
        <label className="row" htmlFor="nc-personal">
          <input id="nc-personal" type="checkbox" checked={personal}
            onChange={(e) => setPersonal(e.target.checked)} />
          Personal task
        </label>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Personal is a label, not a run mode. The task can still use a project and run on agent lists.
        </div>
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
          <option value={PROJECT_CUSTOM}>Custom project name…</option>
        </select>
        {projectMode === "custom" && (
          <input
            id="nc-project-custom"
            type="text"
            value={project}
            placeholder="project name"
            style={{ marginTop: 8 }}
            autoFocus
            onChange={(e) => setProject(e.target.value)}
          />
        )}
        {projectMode === "auto" && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {personal
              ? "Left blank - personal tasks do not auto-infer a project. You can assign one now or later."
              : "Left blank - Garrison infers the project from the description (you can change it later)."}
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
      <div className="field sched-create">
        <label htmlFor="nc-sched-kind">Schedule <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <div className="sched-inline">
          <select id="nc-sched-kind" value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as "none" | "once" | "cron" | "repeat")}>
            <option value="none">not scheduled</option>
            <option value="once">one time</option>
            <option value="repeat">repeats…</option>
            <option value="cron">cron (advanced)</option>
          </select>
          {scheduleKind === "once" && (
            <DateTimePicker id="nc-sched" label="Scheduled time" value={scheduleAt} onChange={setScheduleAt} />
          )}
          {scheduleKind === "cron" && (
            <input id="nc-sched-cron" aria-label="Five-field cron" type="text" value={scheduleCron} placeholder="0 8 * * 1-5" onChange={(e) => setScheduleCron(e.target.value)} />
          )}
          <select aria-label="Schedule action" value={scheduleAction} disabled={scheduleKind === "none"} onChange={(e) => setScheduleAction(e.target.value === "run" ? "run" : "notify")}>
            <option value="notify">notify me (tell Zeca to run/snooze)</option>
            <option value="run">run automatically</option>
          </select>
          {scheduleKind !== "none" && (
            <select aria-label="Schedule target list" value={scheduleTarget} onChange={(e) => setScheduleTarget(e.target.value)}>
              {(board?.lists ?? []).filter((list) => list.kind === "manual" && !list.terminal).map((list) => (
                <option key={list.id} value={list.id}>then move to {list.title}</option>
              ))}
            </select>
          )}
        </div>
        {scheduleKind === "repeat" && <RecurrenceBuilder value={scheduleRec} onChange={setScheduleRec} />}
        {/* cron (advanced) has NO release baseline until the schedule is armed,
            so offering the Due picker there silently discarded the input —
            the deadline rides once/repeat schedules, where a baseline exists. */}
        {(scheduleKind === "once" || scheduleKind === "repeat") && (
          <div className="rec-row sched-due-row">
            <span className="rec-label">Due</span>
            <DateTimePicker label="Due time" value={scheduleDue} onChange={setScheduleDue} />
            <span className="muted rec-note">
              {scheduleDue
                ? "the card lands at the time above and turns amber, then red, as this deadline arrives"
                : "optional — leave empty and the card is due the moment it lands"}
            </span>
          </div>
        )}
        {scheduleKind === "cron" && (
          <div className="sched-advanced">
            <div className="sched-presets" aria-label="Schedule presets">
              <button className="btn tiny" type="button" onClick={() => setScheduleCron("0 8 * * *")}>Daily 08:00</button>
              <button className="btn tiny" type="button" onClick={() => setScheduleCron("0 8 * * 1-5")}>Weekdays 08:00</button>
              <button className="btn tiny" type="button" onClick={() => setScheduleCron("0 9 * * 1")}>Mondays 09:00</button>
            </div>
            <label htmlFor="nc-sched-timezone">Timezone</label>
            <input id="nc-sched-timezone" type="text" value={scheduleTimezone} onChange={(e) => setScheduleTimezone(e.target.value)} />
            <span className="muted">Five fields: minute, hour, day, month, weekday.</span>
          </div>
        )}
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
          orthogonal - any card can run on any node regardless of project. */}
      <div className="spec-grid">
        <SpecSelect
          id="nc-machine" label="Machine" hint="this machine (this node)"
          value={placement}
          disabled={machines && !machines.nodesAvailable ? (machines.reason || "no other nodes in the mesh") : null}
          options={(machines?.machines ?? [])
            .filter((m) => !m.isHost)
            .map((m) => ({
              value: m.name,
              label: m.label,
              detail: [
                `bridge ${m.bridge ?? (m.connected ? "connected" : "offline")}`,
                `worker ${m.worker?.state ?? "offline"}`,
                m.worker?.detail,
                requiredRuntime && !machineSupportsRuntime(m, requiredRuntime) ? `needs ${requiredRuntime.key}` : null
              ].filter(Boolean).join(" · "),
              disabled: !machineSupportsRuntime(m, requiredRuntime)
            }))}
          onChange={setPlacement}
        />
      </div>
      {placement && !selectedProject && !personal && (
        <div className="loadout-panel blocked" role="status">
          <div className="loadout-head"><b>Project Loadout</b><span className="chip alarm">blocked</span></div>
          <p>Choose the project explicitly before assigning this card to another node. Auto-inference happens too late to prove remote readiness.</p>
        </div>
      )}
      <LoadoutPanel
        project={selectedProject}
        active={Boolean(placement && selectedProject)}
        onReady={setLoadoutReady}
      />
      {err && <div className="banner">{err}</div>}
      <button className="btn primary" disabled={saving || remotePlacementBlocked || Boolean(placement && !machineSupportsRuntime(machines?.machines.find((machine) => machine.name === placement), requiredRuntime))} onClick={() => void submit()}>
        {saving ? "Creating…" : "Create card"}
      </button>
    </Sheet>
  );
}

// ── inline manual-list quick-add (touch-first per-column affordance) ─────────
// A per-column "Add card" at the head of Backlog and To Do: tap the trigger to
// reveal a compact inline form (title required, description + project optional)
// that POSTs straight to the selected list and refreshes the board in place, no
// reload. Distinct from the top-bar "New card"
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
function ListAddCard({ listId, listTitle, onCreated }: { listId: string; listTitle: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectMode, setProjectMode] = useState<"auto" | "pick" | "custom">("auto");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [personal, setPersonal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Load the dev-root repos for the project picker only once the form is opened
  // (parity with the New Card sheet). Best-effort — on failure the picker still
  // offers "(auto-infer)" + "Custom project name…".
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.projects().then((v) => { if (alive) setProjects(v.projects); }).catch(() => { /* leave empty */ });
    return () => { alive = false; };
  }, [open]);

  // Autofocus the title the moment the form opens.
  useEffect(() => { if (open) titleRef.current?.focus(); }, [open]);

  function reset() {
    setTitle(""); setDescription(""); setProjectMode("auto"); setProject(""); setPersonal(false); setErr(null); setSaving(false);
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
      await api.create({
        title: t,
        description: description.trim() || undefined,
        project: proj,
        ...(personal ? { scope: "personal" as const } : {}),
        targetList: listId
      });
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
      <button
        type="button"
        className="list-add-trigger"
        aria-label={`Add a card to ${listTitle}`}
        onClick={() => setOpen(true)}
      >
        <PlusIcon /> Add card
      </button>
    );
  }

  return (
    <div className="list-add" role="group" aria-label={`Add a card to ${listTitle}`}>
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
        <option value={PROJECT_CUSTOM}>Custom project name…</option>
      </select>
      {projectMode === "custom" && (
        <input
          className="ba-input"
          type="text"
          value={project}
          placeholder="project name"
          aria-label="Custom project name"
          onChange={(e) => setProject(e.target.value)}
        />
      )}
      <label className="row" htmlFor={`ba-personal-${listId}`}>
        <input
          id={`ba-personal-${listId}`}
          type="checkbox"
          checked={personal}
          onChange={(e) => setPersonal(e.target.checked)}
        />
        Personal task
      </label>
      {personal && projectMode === "auto" && (
        <div className="ba-note">No project will be inferred automatically for this personal task.</div>
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
                <span
                  className={`move-agent-hint${t.startsRun ? " starts-run" : ""}`}
                  title={t.startsRun ? "This agent list dispatches immediately." : "This is an agent-owned list; it does not dispatch on entry."}
                >
                  {t.startsRun ? "starts a run" : "agent list"}
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
const ART_VID_EXT = ["mp4", "webm", "mov", "m4v", "ogv"];
function isVideoName(name?: string): boolean {
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
  return ART_VID_EXT.includes(ext);
}
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
  const isVideo = ART_VID_EXT.includes(ext) || Boolean(art.video);
  const editable = Boolean(token && (token === "brief" || token === "plan" || /^log:\d+$/.test(token)) && (ext === "md" || ext === "txt"));
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(isImage || isVideo);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (isImage || isVideo || !url) { setLoaded(true); return; }
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
  // Escape closes the modal, matching the backdrop tap and the × button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
            : isVideo ? <video className="art-video" src={url ?? ""} controls autoPlay playsInline />
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

// A collapsible detail-sheet section. Secondary groups (run configuration,
// history) fold behind one keyboard-focusable header so the primary content —
// status, description, checklist, evidence — reads first. `defaultOpen` seeds
// the state (e.g. a parked card opens its Run configuration so retry controls
// are reachable); the user can still toggle it. `tone`/`badge` express status
// with the existing colour language, never a new one.
function Section({ title, defaultOpen = false, tone, badge, children }: {
  title: string;
  defaultOpen?: boolean;
  tone?: "attn" | "ok" | "waiting";
  badge?: ReactNode;
  children: ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card-section${open ? " open" : ""}${tone ? " tone-" + tone : ""}`}>
      <button type="button" className="cs-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="cs-chev" aria-hidden><ChevronIcon /></span>
        <span className="cs-title">{title}</span>
        {badge}
      </button>
      {open && <div className="cs-body">{children}</div>}
    </section>
  );
}

/**
 * One runtime transcript, opened from a stretch's `transcript` badge. The badge
 * carries the runtime's own id; the card's recorded transcripts are addressed by
 * POSITION, so an id the card has not recorded yet is reported as exactly that
 * rather than resolved to whichever transcript happens to be nearest.
 */
function RuntimeTranscriptModal({
  cardId,
  sessionId,
  index,
  onClose
}: {
  cardId: string;
  sessionId: string;
  index: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const label = `Runtime transcript ${index >= 0 ? index + 1 : ""}`.trim();
  return (
    <div className="art-scrim" onClick={onClose}>
      <div className="art-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={label}>
        <div className="art-head">
          <span className="art-title">{label}</span>
          <span className="art-tag">{sessionId.slice(0, 12)}</span>
          <span className="art-spacer" />
          <button type="button" className="art-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="art-body">
          {index >= 0 ? (
            <div className="kanban-session-host cc-root" data-theme="light">
              <SharedSessionStream
                url={`/cards/${encodeURIComponent(cardId)}/session-stream?i=${index}`}
                live={false}
                title={label}
              />
            </div>
          ) : (
            <p className="muted">
              This card has not recorded a transcript for {sessionId} - the runtime writes it when the stretch ends.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailSheet({ cardId, board, onClose, onChanged, onWatch, onTerminal, onOpenCard, actions, focus, readOnly: readOnlyProp = false }: { cardId: string; board?: BoardView | null; onClose: () => void; onChanged: () => void; onWatch?: (c: CardSummary) => void; onTerminal?: (c: CardSummary) => void; onOpenCard?: (cardId: string) => void; actions?: CardActionHandlers; focus?: "conversation"; readOnly?: boolean }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openArt, setOpenArt] = useState<ArtifactRef | null>(null);
  // A stretch's runtime-transcript badge opens the card's own transcript stream;
  // `conversationRef` is where Discuss lands when it opens the card.
  const [openTranscript, setOpenTranscript] = useState<{ sessionId: string; index: number } | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  // S2 (Q7): abandonment + revert action state — separate from the delete flow.
  const [abandoning, setAbandoning] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<string | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const [savingScope, setSavingScope] = useState(false);
  // Routing stays editable on a human-held card even after it has run. This is
  // the recovery seam for Panic/parked work: artifacts stay in the same runDir,
  // while the next Retry may deliberately use a different runtime/model/effort.
  const [routingDraft, setRoutingDraft] = useState<CardRouting | null>(null);
  const [routeOptions, setRouteOptions] = useState<RouteOptionsView | null>(null);
  const [routeOptionsError, setRouteOptionsError] = useState<string | null>(null);
  const [savingRouting, setSavingRouting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [machines, setMachines] = useState<MachinesView | null>(null);
  const [placementDraft, setPlacementDraft] = useState("host");
  const [savingPlacement, setSavingPlacement] = useState(false);
  const [detailLoadoutReady, setDetailLoadoutReady] = useState<boolean | null>(null);
  // Trello-style in-place editing: title + description drafts (null = not
  // editing), the checklist add-input, the schedule picker drafts, and the
  // attachment upload state.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [checkText, setCheckText] = useState("");
  const [checkDraft, setCheckDraft] = useState<{ id: string; text: string } | null>(null);
  const [schedDraft, setSchedDraft] = useState<string | null>(null);
  // "repeat" is the calendar rule; "cron" remains for the schedules already
  // written as cron strings, which keep editing exactly as they did.
  const [schedKindDraft, setSchedKindDraft] = useState<"once" | "cron" | "repeat">("once");
  const [schedCronDraft, setSchedCronDraft] = useState("0 8 * * 1-5");
  const [schedRecDraft, setSchedRecDraft] = useState<RecurrenceRule>(() => defaultRecurrence());
  // The DEADLINE, as a local-wall value; "" means due == release, as before.
  const [schedDueDraft, setSchedDueDraft] = useState("");
  const [schedTimezoneDraft, setSchedTimezoneDraft] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Lisbon"
  );
  const [schedTargetDraft, setSchedTargetDraft] = useState("todo");
  const [schedActionDraft, setSchedActionDraft] = useState<"notify" | "run">("notify");
  const [savingSched, setSavingSched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const occurrenceCards = useMemo(() => {
    if (!detail?.card.id) return [] as CardSummary[];
    return (board?.cards ?? [])
      .filter((candidate) => candidate.scheduleTemplateId === detail.card.id)
      .sort((left, right) => Date.parse(right.occurrenceAt ?? right.created ?? "") - Date.parse(left.occurrenceAt ?? left.created ?? ""));
  }, [board?.cards, detail?.card.id]);

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
  useEffect(() => { setRoutingDraft(null); }, [cardId]);
  // Discuss opens the card ON its conversation: scroll the surface into view and
  // put the caret in the composer, so the thing the user asked for is the thing
  // under the cursor. Waits for the first detail load - the surface is not
  // mounted before it.
  useEffect(() => {
    if (focus !== "conversation" || !detail?.card.conversationId) return;
    const host = conversationRef.current;
    if (!host) return;
    host.scrollIntoView({ block: "nearest" });
    host.querySelector("textarea")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, detail?.card.conversationId]);
  useEffect(() => { setPlacementDraft("host"); }, [cardId]);
  useEffect(() => {
    let alive = true;
    api.routeOptions()
      .then((v) => { if (alive) { setRouteOptions(v); setRouteOptionsError(null); } })
      .catch((e) => { if (alive) setRouteOptionsError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [cardId]);
  useEffect(() => {
    if (detail && routingDraft === null) setRoutingDraft({ ...(detail.card.routing ?? {}) });
  }, [detail, routingDraft]);
  useEffect(() => {
    if (detail) setPlacementDraft(detail.card.placement?.target || "host");
  }, [detail?.card.id, detail?.card.placement?.target]);
  useEffect(() => {
    let alive = true;
    api.machines().then((value) => { if (alive) setMachines(value); }).catch(() => { if (alive) setMachines(null); });
    return () => { alive = false; };
  }, [cardId]);

  async function toggleAutonomous() {
    if (!detail) return;
    try {
      const next = await api.patch(detail.card.id, {
        autonomous: !detail.card.autonomous,
        rev: detail.card.rev
      });
      setDetail((d) => d ? { ...d, card: next.card } : d);
      onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  }

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

  async function savePersonalScope(personal: boolean) {
    if (!detail) return;
    setSavingScope(true);
    setActionErr(null);
    try {
      const scope = personal ? "personal" : detail.card.project ? "project" : "unscoped";
      const next = await api.patch(detail.card.id, { scope, rev: detail.card.rev });
      setDetail((d) => d ? { ...d, card: next.card } : d);
      onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingScope(false);
    }
  }

  async function saveRouting(): Promise<boolean> {
    if (!detail || routingDraft === null) return false;
    setSavingRouting(true);
    const clean = Object.fromEntries(
      Object.entries(routingDraft).filter(([, value]) => value !== null && value !== undefined && value !== "")
    ) as CardRouting;
    const saved = await patchCard({ routing: Object.keys(clean).length ? clean : null });
    if (saved) setRoutingDraft(clean);
    setSavingRouting(false);
    return saved;
  }

  async function retryWithRouting() {
    if (!detail) return;
    setRetrying(true);
    setActionErr(null);
    try {
      if (!(await saveRouting())) return;
      await api.start(detail.card.id);
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll refreshes */ });
      onChanged();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(false);
    }
  }

  async function savePlacement(target = placementDraft, retry = false) {
    if (!detail) return;
    if (target !== "host" && !detail.card.project && detail.card.scope !== "personal") {
      setActionErr("Assign a project before placing this card on another node, so its Loadout can be verified.");
      return;
    }
    if (target !== "host" && detail.card.project && detailLoadoutReady !== true) {
      setActionErr("Remote placement is blocked until this project's Loadout and vault preflight pass.");
      return;
    }
    const targetMachine = target === "host" ? null : machines?.machines.find((machine) => machine.name === target);
    const targetRequirement = routeRuntimeRequirement(detail.card.expectedRoute) || machines?.defaultRuntime || null;
    if (target !== "host" && !machineSupportsRuntime(targetMachine, targetRequirement)) {
      setActionErr(targetMachine?.worker?.ready && targetRequirement
        ? `${targetMachine.label} does not advertise ${targetRequirement.key}, required by ${targetRequirement.targetId}.`
        : targetMachine?.worker?.detail || "Enable/Repair the task runner before assigning this card.");
      return;
    }
    setSavingPlacement(true);
    setActionErr(null);
    try {
      const next = await api.patch(detail.card.id, {
        placement: { target: target || "host" },
        rev: detail.card.rev
      });
      setDetail((current) => current ? { ...current, card: next.card } : current);
      setPlacementDraft(target || "host");
      if (retry) {
        await api.start(detail.card.id);
        await api.card(cardId).then((value) => setDetail(value));
      }
      onChanged();
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error));
      await api.card(cardId).then((value) => setDetail(value)).catch(() => {});
    } finally {
      setSavingPlacement(false);
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
    if (!detail) return false;
    // Optimistic: the checkbox flips instantly; a 409 re-pulls.
    setDetail((d) => (d ? { ...d, checklist: items } : d));
    return patchCard({ checklist: items });
  }

  function addCheckItem() {
    const text = checkText.trim();
    if (!text || !detail) return;
    const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`).replace(/-/g, "").slice(0, 10);
    setCheckText("");
    void saveChecklist([...(detail.checklist ?? []), { id, text, done: false }]);
  }

  async function saveCheckItem() {
    if (!detail || !checkDraft) return;
    const text = checkDraft.text.trim();
    if (!text) {
      setActionErr("A checklist item cannot be empty. Remove it explicitly if it is no longer needed.");
      return;
    }
    const saved = await saveChecklist((detail.checklist ?? []).map((item) => item.id === checkDraft.id ? { ...item, text } : item));
    if (saved) setCheckDraft(null);
  }

  function scheduleTarget(card: CardSummary): string {
    return card.schedule?.targetList ?? (card.list === "scheduled" ? "todo" : card.list);
  }

  function beginScheduleEdit(card: CardSummary) {
    const current = card.schedule;
    // A recurring schedule opens in the mode it was written in: the calendar
    // builder for a rule, the cron box for the strings already on the board.
    setSchedKindDraft(current?.kind === "cron" ? (current.cron ? "cron" : "repeat") : "once");
    setSchedDraft(localInputFromIso(current?.kind === "once" ? current.at ?? current.nextAt : null));
    setSchedRecDraft((current?.recurrence as RecurrenceRule | undefined) ?? defaultRecurrence());
    setSchedDueDraft(
      current?.dueOffsetMinutes
        ? localInputFromIso(new Date(Date.parse(current.nextAt ?? current.at ?? new Date().toISOString()) + current.dueOffsetMinutes * 60_000).toISOString())
        : ""
    );
    setSchedCronDraft(current?.cron ?? "0 8 * * 1-5");
    setSchedTimezoneDraft(current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Lisbon");
    setSchedTargetDraft(current?.targetList ?? (card.list === "scheduled" ? "todo" : card.list));
    setSchedActionDraft(current?.action ?? (card.scheduleAction === "run" ? "run" : "notify"));
  }

  async function saveScheduleDraft(card: CardSummary) {
    const onceAt = schedKindDraft === "once" ? isoFromLocalInput(schedDraft ?? "") : null;
    if (schedKindDraft === "once" && !onceAt) {
      setActionErr("Pick a valid date and time.");
      return;
    }
    // The deadline is picked as a date but stored as an offset from the release
    // instant, so it stays correct for every occurrence of a recurring card.
    const releaseForDue = onceAt
      ?? (schedKindDraft === "repeat"
        ? recurrenceNextInstant(schedRecDraft, schedTimezoneDraft)
        : card.schedule?.nextAt ?? null);
    const dueOffsetMinutes = dueOffsetFromInstants(releaseForDue, isoFromLocalInput(schedDueDraft));
    const common = {
      action: schedActionDraft,
      timezone: schedTimezoneDraft,
      enabled: true,
      targetList: schedTargetDraft || scheduleTarget(card),
      ...(dueOffsetMinutes ? { dueOffsetMinutes } : {})
    };
    const schedule = schedKindDraft === "once"
      ? { kind: "once", at: onceAt, ...common }
      : schedKindDraft === "repeat"
        ? { kind: "cron", recurrence: schedRecDraft, ...common }
        : { kind: "cron", cron: schedCronDraft.trim(), ...common };
    setSavingSched(true);
    const saved = await patchCard({ schedule });
    setSavingSched(false);
    if (saved) setSchedDraft(null);
  }

  async function clearSchedule() {
    setSavingSched(true);
    const saved = await patchCard({ schedule: null });
    setSavingSched(false);
    if (saved) setSchedDraft(null);
  }

  async function snoozeSchedule(until: string, action: "notify" | "run") {
    if (!detail) return;
    setSavingSched(true);
    setActionErr(null);
    try {
      const next = await api.snooze(detail.card.id, { until, action });
      setDetail((d) => d ? { ...d, card: next.card } : d);
      onChanged();
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSched(false);
    }
  }

  async function toggleSchedule(card: CardSummary) {
    if (!card.schedule) return;
    setSavingSched(true);
    await patchCard({ schedule: { ...card.schedule, enabled: !card.schedule.enabled } });
    setSavingSched(false);
  }

  async function runScheduledNow(card: CardSummary) {
    setSavingSched(true);
    setActionErr(null);
    try {
      const result = await api.runScheduleNow(card.id);
      await api.card(cardId).then((d) => setDetail(d));
      onChanged();
      setActionErr(result.occurrence ? `Created occurrence ${result.card.id}.` : "Released the one-time schedule to run now.");
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSched(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!detail || !files.length) return;
    setUploading(true);
    setActionErr(null);
    const failed: string[] = [];
    for (const f of files) {
      try {
        const b64 = await fileToBase64(f);
        // A pasted image arrives as a File with an empty name; the server rejects
        // a blank filename, which read as "attach silently does nothing".
        const name = f.name && f.name.trim() ? f.name : pastedFileName(f);
        await api.uploadAttachment(detail.card.id, name, b64);
      } catch (e) {
        // Say WHY. This used to swallow the reason and report only the filename,
        // so an over-cap file, a rejected name and an unreachable board were all
        // the same unactionable "Upload failed for: x".
        failed.push(`${f.name || "pasted image"} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (failed.length) setActionErr(`Upload failed for: ${failed.join("; ")}`);
    await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll refreshes */ });
    onChanged();
    setUploading(false);
  }

  // Paste an image straight onto the open card.
  //
  // Bound to the document while the sheet is open rather than to a drop target,
  // because the natural gesture is "the card is open, hit Cmd+V" without first
  // clicking a particular box. Typing into a field still wins: a paste with any
  // text on the clipboard, or one aimed at an input/textarea, is left alone so
  // this can never eat a normal text paste.
  useEffect(() => {
    // A frozen record takes no uploads: the state service refuses the write and
    // the sheet offers no attach control, so the document-level shortcut must
    // not be the one door left open.
    if (readOnlyProp || detail?.card.frozen?.at) return;
    async function onPaste(e: ClipboardEvent) {
      const cd = e.clipboardData;
      if (!cd) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("input, textarea, [contenteditable='true']")) return;
      if (cd.getData("text")?.trim()) return;
      const files = Array.from(cd.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      await uploadFiles(files);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.card.id, detail?.card.frozen?.at, readOnlyProp]);

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
  // A frozen pre-Conversations record is READ-ONLY, and the state service is
  // what enforces it: every write on a frozen card comes back 409 card-frozen
  // except DELETE. Derived from the card itself and not only from the History
  // view's prop, so the same refusal is honoured wherever the card is opened
  // from - a #card= link or a search hit reaches this sheet too. Presented as
  // an absent control rather than a button that errors on press.
  const frozenAt = card.frozen?.at ?? null;
  const readOnly = readOnlyProp || Boolean(frozenAt);
  // D16: title/description edits are refused on an engine-owned card (the
  // server enforces it; the UI says so instead of offering a doomed control).
  // Schedule / checklist / attachments are benign and stay editable.
  const cardList = board?.lists.find((l) => l.id === card.list) ?? null;
  const lockedCard = readOnly || Boolean(cardList && cardList.kind === "agent" && !cardList.interactive && !card.quick);
  // A conversation-linked card shows its CONVERSATION here: the ledger carries
  // the evidence refs a stretch's handoff had to prove, so a second Evidence
  // block would be the same facts one layer thinner. A legacy card - one frozen
  // before the conversations pivot, so with no ledger to read - keeps the runDir
  // evidence block, which is the only proof it has.
  const conversationId = card.conversationId ?? null;
  // Evidence is expected from Walkthrough onward — so at those stages we show the
  // Evidence section even when empty, surfacing the GAP (the user looks here for proof).
  const evidence = links.evidence ?? [];
  const showEvidence = !conversationId &&
    (evidence.length > 0 || ["walkthrough", "validate", "done"].includes(card.list));
  // The description body without the ClaudeChat attachment block (which renders in
  // its own Attachments section below).
  const descBody = card.description ? stripAttachmentBlock(card.description) : "";
  const claimActive = card.dispatch?.state === "claimed" || card.dispatch?.state === "running" || card.dispatch?.state === "cancelling";
  const selectedMachine = placementDraft === "host"
    ? machines?.machines.find((machine) => machine.isHost)
    : machines?.machines.find((machine) => machine.name === placementDraft);
  const placementProjectReady = placementDraft === "host" || (card.project ? detailLoadoutReady === true : card.scope === "personal");
  const placementRuntime = routeRuntimeRequirement(card.expectedRoute) || machines?.defaultRuntime || null;
  const placementReady = placementDraft === "host" || Boolean(
    machineSupportsRuntime(selectedMachine, placementRuntime) && placementProjectReady
  );
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
        <button
          className="chip mono chip-id"
          title="card id — click to copy"
          onClick={() => { void navigator.clipboard?.writeText(card.id); }}
        >
          {card.id}
        </button>
        {card.project
          ? <span className="chip">proj: {card.project}</span>
          : <span className="chip muted">no project</span>}
        {card.scope === "personal" && <span className="chip goal">personal</span>}
        <span className="chip">list: {card.list}</span>
        <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {!frozenAt && (
          <button
            className={`chip chip-toggle${card.autonomous ? " on" : ""}`}
            title={card.autonomous
              ? "Autonomous ON — runs end to end without asking. Click to turn off."
              : "Autonomous OFF — pauses after planning and asks before doing the work. Click to turn on."}
            onClick={() => { void toggleAutonomous(); }}
          >
            autonomous: {card.autonomous ? "on" : "off"}
          </button>
        )}
        {card.runId && <span className="chip">run: {card.runId.slice(0, 8)}</span>}
        {card.sliceId && <span className="chip">slice: {card.sliceId}</span>}
      </div>

      {frozenAt && (
        <div className="state-callout frozen">
          Frozen history - a record from before the Conversations migration. It can be read and
          deleted, not edited, moved or run.
        </div>
      )}

      {/* THE APPROVAL ASK, at full width — same block the card front wears,
          uncapped: in here the whole plan is readable and the decision is one
          click, with the conversation right below for anything deeper. */}
      {card.awaitingApproval && card.status !== "running" && !readOnly && (
        <div className="approval-ask detail-approval">
          <div className="aa-head">Waiting for your approval</div>
          <div className="aa-next">next: {card.awaitingApproval.next}</div>
          {card.awaitingApproval.plan && <p className="aa-plan">{card.awaitingApproval.plan}</p>}
          {card.awaitingApproval.items.length > 0 && (
            <ul className="aa-items">
              {card.awaitingApproval.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          )}
          <div className="aa-actions">
            <button
              className="btn primary"
              title="approve the plan and let the conversation continue"
              onClick={() => actions?.onApprove?.(card)}
            >
              <PlayIcon /> Approve &amp; continue
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              or write into the conversation below - any reply approves
            </span>
          </div>
        </div>
      )}

      {/* Header actions: open the rich Log (Watch) or an interactive Terminal.
          Every one of them acts on a live card, so a frozen record is offered
          none of them. */}
      {!readOnly && (
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
        {/* A conversation card reaches its raw phase log from the conversation
            header instead, where the rest of that surface's controls live. */}
        {!conversationId && (
          <button className="btn small" onClick={() => onWatch?.(card)}>
            <WatchIcon /> Raw log
          </button>
        )}
        {(card.project || card.scope === "personal") && (
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
      )}
      {card.drill && (
        <div className="drill-detail">
          <DrillBlock drill={card.drill} />
        </div>
      )}

      {/* Current-state callout — the single most important "what's going on" line. */}
      {running && (
        <div className="state-callout running">
          <span className="run-spin" aria-hidden />
          <span>Running · <Elapsed since={card.runningSince} /> — the conversation below streams live.</span>
        </div>
      )}
      {parked && card.attentionReason && (
        <div className="state-callout parked">{card.attentionReason}</div>
      )}
      {card.waitingOn && (
        <div className="state-callout waiting">
          Waiting on <b>{waitingLabel(card.waitingOn)}</b>: {waitingClause(card.waitingOn)}
        </div>
      )}

      {/* RUN CONFIGURATION — secondary, collapsed by default. A parked card opens
          it so its routing/placement retry controls are reachable at a glance.
          The whole section is scope/placement/routing/schedule EDITORS, so a
          frozen record - which will never run again - is shown none of it. */}
      {!readOnly && (
      <Section
        title="Run configuration"
        defaultOpen={parked}
        tone={parked ? "attn" : undefined}
        badge={parked ? <span className="chip attn">needs attention</span> : undefined}
      >
      {!lockedCard && (
        <div className="detail-desc">
          <div className="dd-title">Task scope</div>
          <label className="row" htmlFor={`personal-${card.id}`}>
            <input
              id={`personal-${card.id}`}
              type="checkbox"
              checked={card.scope === "personal"}
              disabled={Boolean(card.runId) || savingScope}
              onChange={(e) => void savePersonalScope(e.target.checked)}
            />
            Personal task
          </label>
          {!card.runId ? (
            <>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <input
                  aria-label="Project"
                  value={projectDraft ?? card.project ?? ""}
                  placeholder="project name"
                  onChange={(e) => setProjectDraft(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button className="btn small" disabled={savingProject} onClick={() => void saveProjectScope()}>
                  {savingProject ? "Saving…" : "Save project"}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
                Personal is independent of project. A personal task without a project skips automatic inference; use Infer if you deliberately want one.
              </p>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
              Scope is fixed after the first run starts because its artifacts belong to that execution context. Create a fresh card to use a different project or personal scope.
            </p>
          )}
          {actionErr && <div className="dispatch-err" style={{ marginTop: 8 }}>{actionErr}</div>}
        </div>
      )}
      <div className="detail-desc placement-control">
        <div className="dd-title">Execution location</div>
        <p className="muted routing-help">
          Placement chooses the machine; runtime and model remain controlled by Run routing. Project work is claimed only after its Loadout and vault requirements validate.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            aria-label="Execution location"
            value={placementDraft}
            disabled={claimActive || savingPlacement}
            onChange={(event) => setPlacementDraft(event.target.value)}
          >
            <option value="host">This machine (Garrison host)</option>
            {(machines?.machines ?? []).filter((machine) => !machine.isHost).map((machine) => (
              <option
                key={machine.name}
                value={machine.name}
                disabled={!machineSupportsRuntime(machine, placementRuntime)}
              >
                {machine.label} — bridge {machine.bridge ?? (machine.connected ? "connected" : "offline")} · worker {machine.worker?.state ?? "offline"}{placementRuntime && !machineSupportsRuntime(machine, placementRuntime) ? ` · needs ${placementRuntime.key}` : ""}
              </option>
            ))}
          </select>
          {!parked && (
            <button className="btn small" disabled={claimActive || savingPlacement || !placementReady} onClick={() => void savePlacement()}>
              {savingPlacement ? "Saving…" : "Save location"}
            </button>
          )}
          {parked && (
            <>
              <button className="btn small primary" disabled={claimActive || savingPlacement || !placementReady} onClick={() => void savePlacement(placementDraft, true)}>
                {savingPlacement ? "Starting…" : placementDraft === (card.placement?.target || "host") ? "Retry here" : "Choose this location & retry"}
              </button>
              {placementDraft !== "host" && (
                <button className="btn small" disabled={claimActive || savingPlacement} onClick={() => void savePlacement("host", true)}>
                  Run on host
                </button>
              )}
            </>
          )}
        </div>
        {claimActive ? (
          <div className="spec-note">Claimed by {card.dispatch?.machine || card.placement?.target}; use Stop &amp; reroute in Watch before changing placement.</div>
        ) : placementDraft !== "host" && selectedMachine ? (
          <div className="spec-note">
            {selectedMachine.worker?.detail || `Worker ${selectedMachine.worker?.state ?? "offline"}`}
            {selectedMachine.worker?.error ? ` — ${selectedMachine.worker.error}` : ""}
          </div>
        ) : null}
        {placementDraft !== "host" && !card.project && card.scope !== "personal" && (
          <div className="loadout-panel blocked" role="status">
            <div className="loadout-head"><b>Project Loadout</b><span className="chip alarm">blocked</span></div>
            <p>Assign the project before choosing a node. Project inference cannot substitute for a pre-placement Loadout check.</p>
          </div>
        )}
        <LoadoutPanel
          project={card.project || ""}
          active={placementDraft !== "host" && Boolean(card.project)}
          onReady={setDetailLoadoutReady}
        />
      </div>
      {!lockedCard && !running && routingDraft !== null && (
        <div className="detail-desc routing-recovery">
          <div className="dd-title">Run routing</div>
          <p className="muted routing-help">
            Changes apply to the next Run or Retry. Existing logs and run context stay with this card.
          </p>
          <RunSpec
            spec={routingDraft}
            setSpec={setRoutingDraft}
            options={routeOptions}
            optionsError={routeOptionsError}
            emphasise={parked}
          />
          <div className="routing-actions">
            {parked && (
              <button className="btn small" disabled={savingRouting || retrying} onClick={() => void saveRouting()}>
                {savingRouting && !retrying ? "Saving…" : "Save only"}
              </button>
            )}
            <button
              className="btn small primary"
              disabled={savingRouting || retrying}
              onClick={() => parked ? void retryWithRouting() : void saveRouting()}
            >
              {retrying ? "Retrying…" : savingRouting ? "Saving…" : parked ? "Save & Retry" : "Save routing"}
            </button>
          </div>
        </div>
      )}
      {/* SCHEDULE — one-time hold or recurring template. The fixed Scheduled
          column owns placement; targetList is where an occurrence/release goes. */}
      <div className="detail-desc sched-block">
        <div className="dd-title">Schedule</div>
        {(card.schedule || card.scheduledFor) && schedDraft === null && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {/* Quiet when a separate deadline chip carries the colour. */}
            <span className={`chip sched${hasSplitDeadline(card) ? " muted" : urgencyClass(cardUrgency(card))}`}>
              <ClockIcon /> {scheduleChip(card)}{card.scheduleAction === "run" ? " · auto-run" : " · notify"}
            </span>
            {hasSplitDeadline(card) && (
              <span className={`chip sched due-chip${urgencyClass(cardUrgency(card))}`} title={dueInstant(card) ?? undefined}>
                {dueChip(card)}
              </span>
            )}
            {card.schedule?.kind === "cron" && <span className="chip muted">{repeatLabel(card.schedule)} · {card.schedule.timezone}</span>}
            {card.schedule?.targetList && <span className="chip muted">to {card.schedule.targetList}</span>}
            {card.schedule?.cutoverPending && (
              <span className="chip attn" title="Verify with Run now, remove the legacy scheduler job, then rerun Kanban setup">
                legacy cutover pending
              </span>
            )}
            {card.schedule?.lastAt && <span className="chip muted" title={card.schedule.lastAt}>last {fmtSchedule(card.schedule.lastAt)}</span>}
            {card.scheduleNotifiedAt && <span className="chip muted" title={card.scheduleNotifiedAt}>reminder sent</span>}
            <button className="btn small" disabled={running || savingSched} onClick={() => beginScheduleEdit(card)}>
              Change
            </button>
            {card.schedule?.kind === "cron" && (
              <button
                className="btn small"
                disabled={running || savingSched || card.schedule.cutoverPending === true}
                title={card.schedule.cutoverPending ? "Run now to verify; recurring activation happens after the legacy job is removed" : undefined}
                onClick={() => void toggleSchedule(card)}
              >
                {card.schedule.enabled ? "Pause" : "Resume"}
              </button>
            )}
            <button className="btn small primary" disabled={running || savingSched} onClick={() => void runScheduledNow(card)}>
              Run now
            </button>
            <button className="btn small" disabled={running || savingSched} title="defer the next occurrence/release one hour" onClick={() => void snoozeSchedule(new Date(Date.now() + 3600_000).toISOString(), card.scheduleAction === "run" ? "run" : "notify")}>
              +1h
            </button>
            <button className="btn small" disabled={running || savingSched} title="defer the next occurrence/release until tomorrow 09:00" onClick={() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); void snoozeSchedule(d.toISOString(), card.scheduleAction === "run" ? "run" : "notify"); }}>
              Tomorrow 9
            </button>
            <button className="btn small" disabled={running || savingSched} onClick={() => void clearSchedule()}>
              Clear
            </button>
          </div>
        )}
        {!card.schedule && !card.scheduledFor && schedDraft === null && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" disabled={running} title={running ? "the card is running" : "hold or repeat this card on a schedule"} onClick={() => beginScheduleEdit(card)}>
              <ClockIcon /> Set a schedule
            </button>
          </div>
        )}
        {schedDraft !== null && (
          <div className="sched-editor">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select aria-label="Schedule kind" value={schedKindDraft} onChange={(e) => setSchedKindDraft(e.target.value as "once" | "cron" | "repeat")}>
              <option value="once">one time</option>
              <option value="repeat">repeats…</option>
              <option value="cron">cron (advanced)</option>
            </select>
            {schedKindDraft === "once" && (
              <DateTimePicker label="Scheduled time" value={schedDraft} onChange={(next) => setSchedDraft(next)} />
            )}
            {schedKindDraft === "cron" && (
              <input aria-label="Five-field cron" type="text" value={schedCronDraft} placeholder="0 8 * * 1-5" onChange={(e) => setSchedCronDraft(e.target.value)} />
            )}
            <select value={schedActionDraft} onChange={(e) => setSchedActionDraft(e.target.value === "run" ? "run" : "notify")}>
              <option value="notify">notify me (tell Zeca to run/snooze)</option>
              <option value="run">run automatically</option>
            </select>
            <input aria-label="Schedule timezone" type="text" value={schedTimezoneDraft} onChange={(e) => setSchedTimezoneDraft(e.target.value)} />
            <select aria-label="Schedule target list" value={schedTargetDraft} onChange={(e) => setSchedTargetDraft(e.target.value)}>
              {(board?.lists ?? []).filter((list) => list.kind === "manual" && !list.terminal).map((list) => (
                <option key={list.id} value={list.id}>then move to {list.title}</option>
              ))}
            </select>
            <button
              className="btn small primary"
              disabled={savingSched || (
                schedKindDraft === "once" ? !schedDraft || !isoFromLocalInput(schedDraft)
                  : schedKindDraft === "cron" ? !schedCronDraft.trim()
                  : false
              )}
              onClick={() => void saveScheduleDraft(card)}
            >
              {savingSched ? "Saving…" : "Set"}
            </button>
            <button className="btn small" onClick={() => setSchedDraft(null)}>Cancel</button>
            </div>
            {schedKindDraft === "repeat" && (
              <RecurrenceBuilder value={schedRecDraft} onChange={setSchedRecDraft} />
            )}
            {/* THE DEADLINE. Optional, and separate from the release instant
                above: the card lands on its list at the release time and is DUE
                here. Left empty, the two are the same moment — today's rule. */}
            {(schedKindDraft !== "cron" || card.schedule?.nextAt) ? (
              <div className="rec-row sched-due-row">
                <span className="rec-label">Due</span>
                <DateTimePicker label="Due time" value={schedDueDraft} onChange={setSchedDueDraft} />
                <span className="muted rec-note">
                  {schedDueDraft
                    ? "the card lands at the time above and turns amber, then red, as this deadline arrives"
                    : "optional — leave empty and the card is due the moment it lands"}
                </span>
              </div>
            ) : (
              <span className="muted rec-note">
                A due time needs a release baseline — arm this cron schedule first, or use once/repeat.
              </span>
            )}
            {schedKindDraft === "cron" && (
              <div className="sched-presets">
                <button className="btn tiny" type="button" onClick={() => setSchedCronDraft("0 8 * * *")}>Daily 08:00</button>
                <button className="btn tiny" type="button" onClick={() => setSchedCronDraft("0 8 * * 1-5")}>Weekdays 08:00</button>
                <button className="btn tiny" type="button" onClick={() => setSchedCronDraft("0 9 * * 1")}>Mondays 09:00</button>
                <span className="muted">minute · hour · day · month · weekday</span>
              </div>
            )}
          </div>
        )}
        {card.schedule?.lastError && <div className="dispatch-err">Schedule degraded: {card.schedule.lastError}</div>}
        {card.scheduleTemplateId && (
          <div className="muted schedule-link">
            Occurrence of template{" "}
            <a
              className="schedule-card-ref"
              href={scheduleCardHref(card.scheduleTemplateId)}
              onClick={(event) => {
                if (!onOpenCard || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpenCard(card.scheduleTemplateId!);
              }}
            >
              {board?.cards.find((candidate) => candidate.id === card.scheduleTemplateId)?.title ?? card.scheduleTemplateId}
            </a>{" "}
            at {card.occurrenceAt ? fmtSchedule(card.occurrenceAt) : "an unsupplied instant"}.
          </div>
        )}
        {card.schedule?.kind === "cron" && (
          <div className="schedule-link schedule-occurrences">
            <span className="muted">Occurrences:</span>{" "}
            {occurrenceCards.length === 0 ? (
              <span className="muted">none yet</span>
            ) : occurrenceCards.map((occurrence, index) => (
              <span key={occurrence.id}>
                {index > 0 && " · "}
                <a
                  className="schedule-card-ref"
                  href={scheduleCardHref(occurrence.id)}
                  onClick={(event) => {
                    if (!onOpenCard || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpenCard(occurrence.id);
                  }}
                  title={occurrence.occurrenceAt ?? occurrence.created ?? undefined}
                >
                  {fmtSchedule(occurrence.occurrenceAt ?? occurrence.created) || occurrence.title}
                </a>
              </span>
            ))}
          </div>
        )}
        {card.morningBriefDelivery && (
          <div className="morning-delivery" aria-label="Morning briefing delivery status">
            <span className={`chip ${card.morningBriefDelivery.web?.status === "delivered" ? "ok" : "attn"}`}>Web: {card.morningBriefDelivery.web?.status ?? "pending"}</span>
            <span className={`chip ${card.morningBriefDelivery.omi?.status === "delivered" ? "ok" : "attn"}`}>Omi: {card.morningBriefDelivery.omi?.status ?? "pending"}</span>
            <span className={`chip ${card.morningBriefDelivery.calendar?.status === "reported" ? "ok" : "attn"}`}>Calendar: {card.morningBriefDelivery.calendar?.status ?? "pending"}</span>
          </div>
        )}
      </div>
      </Section>
      )}

      {/* CONTENT — description, checklist, attachments: the primary "what this
          card is" tier, always expanded. */}
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
              <AutoTextarea
                aria-label="Edit description"
                value={descDraft}
                autoFocus
                onChange={setDescDraft}
                onSubmit={() => void saveDescription()}
                onCancel={() => setDescDraft(null)}
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
          operative's dispatch prompt. Benign patch, editable everywhere except
          on a frozen record, where an empty list is nothing but a stray header. */}
      {(checklist.length > 0 || !readOnly) && (
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
                {readOnly ? (
                  <span className={`cl-box${item.done ? " checked" : ""}`} role="img" aria-label={item.done ? "done" : "not done"} />
                ) : (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={item.done}
                    className={`cl-box${item.done ? " checked" : ""}`}
                    title={item.done ? "mark as not done" : "mark as done"}
                    onClick={() => void saveChecklist(checklist.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))}
                  />
                )}
                {readOnly ? (
                  <span className="cl-text">{item.text}</span>
                ) : checkDraft?.id === item.id ? (
                  <div className="cl-editor">
                    <AutoTextarea
                      aria-label="Edit checklist item"
                      value={checkDraft.text}
                      onChange={(text) => setCheckDraft({ id: item.id, text })}
                      onSubmit={() => void saveCheckItem()}
                      onCancel={() => setCheckDraft(null)}
                    />
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn tiny primary" disabled={!checkDraft.text.trim()} onClick={() => void saveCheckItem()}>Save item</button>
                      <button className="btn tiny" onClick={() => setCheckDraft(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="cl-text cl-text-button"
                    title="edit checklist item"
                    onClick={() => setCheckDraft({ id: item.id, text: item.text })}
                  >
                    {item.text}
                  </button>
                )}
                {!readOnly && checkDraft?.id !== item.id && (
                  <button
                    type="button"
                    className="cl-edit"
                    title="edit this item"
                    aria-label={`edit checklist item ${item.text.slice(0, 80)}`}
                    onClick={() => setCheckDraft({ id: item.id, text: item.text })}
                  >
                    Edit
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    className="cl-del"
                    title="remove this item"
                    aria-label={`remove "${item.text}"`}
                    onClick={() => void saveChecklist(checklist.filter((i) => i.id !== item.id))}
                  >
                    <CloseIcon />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* The input takes the card's full width on its own row and the Add button
            sits under it. Sharing a flex row with the button is what made it
            narrow, and a fixed 4 rows made it tall - the opposite of what a
            mostly-one-line field wants. */}
        {!readOnly && (
          <div className="cl-add">
            <AutoTextarea
              aria-label="New checklist item"
              value={checkText}
              placeholder="Add an item. Enter adds it; Shift+Enter for a new line."
              onChange={setCheckText}
              onSubmit={addCheckItem}
            />
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <button className="btn small" disabled={!checkText.trim()} onClick={addCheckItem}>
                <PlusIcon /> Add
              </button>
            </div>
          </div>
        )}
      </div>

      )}

      {/* ATTACHMENTS - card-owned uploads (deletable, folded into the dispatch
          prompt as context) plus the legacy ClaudeChat description-block files.
          Images render inline (click to enlarge); other files link out. On a
          frozen record the files are still readable; every way IN is closed. */}
      {(attachments.length > 0 || !readOnly) && (
      <div
        className={`evidence${dragOver ? " drag-over" : ""}`}
        onDragOver={readOnly ? undefined : (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={readOnly ? undefined : () => setDragOver(false)}
        onDrop={readOnly ? undefined : (e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          setDragOver(false);
          void uploadFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="dd-title">
          Attachments
          {/* A real button that opens the picker programmatically, rather than a
              <label> wrapping a hidden input. Implicit label activation is the
              part that does not survive every context this board runs in - the
              board is framed cross-origin inside Garrison, and WebKit in
              particular declines to open a picker that way, which is what "attach
              is not working" looked like. Clicking the input directly always
              works. Drag-and-drop onto this panel and Cmd+V paste are the other
              two routes in, so a blocked picker is no longer a dead end. */}
          {!readOnly && (
          <button
            type="button"
            className="btn tiny"
            disabled={uploading}
            title="attach a file - the operative reads it as context when the card runs. You can also drop files here or paste an image."
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "uploading…" : "attach"}
          </button>
          )}
          {!readOnly && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // Visually hidden but STILL RENDERED: iOS/WebKit silently ignores a
            // programmatic `.click()` on a `display:none` (or `visibility:hidden`)
            // file input, which is what "attach does nothing" looked like on the
            // phone. An off-screen, zero-size, rendered input takes the click.
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" }}
            tabIndex={-1}
            aria-hidden
            disabled={uploading}
            onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void uploadFiles(files); }}
          />
          )}
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
                ) : isVideoName(a.name) ? (
                  <button type="button" className="ev-file" onClick={() => setOpenArt({ kind: "serve", url: a.url, name: a.name, video: true })} title={a.name}>
                    <LinkIcon /> {a.name}
                  </button>
                ) : (
                  <a className="ev-file" href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                    <LinkIcon /> {a.name}
                  </a>
                )}
                {a.uploaded && !readOnly && (
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
      )}

      {card.lastReply && (
        <div className="detail-desc">
          <div className="dd-title">Last operative reply</div>
          <p className="reply-quote">“{card.lastReply}”</p>
        </div>
      )}

      {/* THE CONVERSATION - the card's own thread: every stretch that ran, every
          handoff and delegation it recorded, and the composer that writes the next
          message into it. One id, one record: the conversation is the card. */}
      {conversationId && (
        <div className="conv-block" ref={conversationRef}>
          <CardConversation
            conversationId={conversationId}
            title={card.title}
            generation={`${card.rev}:${card.status}`}
            frozen={readOnly}
            onRawLog={() => onWatch?.(card)}
            onOpenRuntimeTranscript={(sessionId) => setOpenTranscript({
              sessionId,
              index: (card.sessionIds ?? []).indexOf(sessionId)
            })}
          />
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

      {/* HISTORY & ARTIFACTS — secondary, collapsed by default: the full record
          of what happened to this card and the pointers to its artifacts. */}
      <Section title="History & artifacts">
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
        <LinkRow label="runtime transcripts" refs={links.sessions} onOpen={setOpenArt} />
        <LinkRow label="phase gates" refs={links.gates} onOpen={setOpenArt} />
        <LinkRow label="gate markers" refs={links.gateMarkers} onOpen={setOpenArt} />
        <LinkRow label="evidence index" refs={links.evidenceIndex} onOpen={setOpenArt} />
        <LinkRow label="video" refs={links.video} onOpen={setOpenArt} />
        <LinkRow label="logs" refs={links.logs} onOpen={setOpenArt} />
      </div>

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
      </Section>

      {/* The artifact viewer is hoisted out of the collapsibles above: evidence and
          attachments (outside History) also open it, so a collapsed History section
          must never unmount the overlay. */}
      {openArt && <ArtifactModal cardId={card.id} art={openArt} onClose={() => setOpenArt(null)} />}
      {openTranscript && (
        <RuntimeTranscriptModal
          cardId={card.id}
          sessionId={openTranscript.sessionId}
          index={openTranscript.index}
          onClose={() => setOpenTranscript(null)}
        />
      )}

      {/* The same action row the card front carries, at the bottom of the opened
          card - so everything you can do to a card is reachable from wherever you
          are looking at it. Literally the same component, not a copy, and it
          brings the card's id with it (withId) for quoting into an agent prompt.
          `list` comes from the board; without it there is nothing to derive the
          available actions from, so the row is simply omitted. */}
      {actions && cardList && !readOnly && (
        <div className="detail-actions detail-actions-footer">
          <CardActions card={card} list={cardList} busy={false} withId handlers={actions} />
        </div>
      )}

      <div className="danger-zone">
        {/* Prepared revert (S2, Q7): the exact commits to be reverted (short shas),
            the conflict-risk count, the state tag, and the guarded Confirm-revert
            button. Clustered here with Abandon/Delete so every recovery/destructive
            action lives in one place. */}
        {card.preparedRevert && !readOnly && (
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
        {/* Abandon (S2, Q7): prepare a revert of the card's committed work + park it.
            Offered on a non-running card that hasn't already been abandoned; the
            confirm() guard and the separate revert step keep it deliberate. */}
        {!running && !card.preparedRevert && !readOnly && (
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

// ── raw log sheet - the card's phase log over SSE ────────────────────────────
// The rich account of what happened lives in the card's conversation (the opened
// card renders it); this sheet is the RAW layer under it - the phase log the run
// wrote line by line, plus the Panic control for a card that has to be stopped.
// The interactive TERMINAL has its own modal.
function WatchSheet({
  card,
  onClose,
  onChanged,
  onReviewRouting
}: {
  card: CardSummary;
  onClose: () => void;
  onChanged: () => void;
  onReviewRouting: () => void;
}) {
  const [lines, setLines] = useState<string>("");
  const [live, setLive] = useState<boolean | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [panicking, setPanicking] = useState(false);
  const [panicResult, setPanicResult] = useState<{ message: string; affectedCardIds: string[] } | null>(null);
  const [panicError, setPanicError] = useState<string | null>(null);
  const scrRef = useRef<HTMLDivElement | null>(null);
  const remoteRun = (card.placement?.target || "host") !== "host" &&
    ["claimed", "running", "cancelling"].includes(card.dispatch?.state || "");

  async function panic() {
    if (!window.confirm(remoteRun
      ? "Request that the remote node stop this process group? The card stays locked until the worker confirms cancellation; then its partial evidence is preserved and it returns to Needs attention."
      : "Stop this card's active agent turn? Partial output will be kept but ignored, and the card will park in Needs attention. If this is a shared batch, every card in that runtime turn will stop."
    )) return;
    setPanicking(true);
    setPanicError(null);
    try {
      const result = await api.panic(card.id);
      setPanicResult({ message: result.message, affectedCardIds: result.affectedCardIds });
      onChanged();
    } catch (e) {
      setPanicError(e instanceof Error ? e.message : String(e));
    } finally {
      setPanicking(false);
    }
  }

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
  }, [lines]);

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
    <Sheet title={`Raw log: ${card.title}`} onClose={onClose} size="wide">
      {card.status === "needs-attention" && card.attentionReason && (
        <div className="state-callout parked" style={{ marginTop: 0 }}>{card.attentionReason}</div>
      )}
      {card.status === "running" && !panicResult && (
        <div className="panic-bar">
          <div>
            <b>Need to stop this run?</b>
            <span>{remoteRun ? " Stop & reroute asks the worker to stop its process group. The claim stays locked until the worker acknowledges cancellation, and partial evidence is preserved." : " Panic interrupts only the active turn proven to contain this card."}</span>
          </div>
          <button className="btn danger small" disabled={panicking} onClick={() => void panic()}>
            {panicking ? "Stopping…" : remoteRun ? "Stop & reroute" : "Panic"}
          </button>
        </div>
      )}
      {panicResult && (
        <div className="state-callout parked panic-result">
          <span>{panicResult.message} Review the routing before retrying if the runtime was wrong.</span>
          <button className="btn small" onClick={onReviewRouting}>Review routing &amp; retry</button>
        </div>
      )}
      {panicError && <div className="dispatch-err panic-error">{remoteRun ? "Stop & reroute" : "Panic"} did not stop anything: {panicError}</div>}
      <div className="watch">
        <div className="wbar">
          card {card.id.slice(0, 6)} · {card.list}
          <span className={`live${live ? "" : " off"}`}>
            {live === null ? "connecting…" : live ? "live" : "static logs"}
          </span>
        </div>
        <div className="wscr" ref={scrRef}>
          {lines ? rendered : <span className="muted">{done ? "no log output" : "waiting for output…"}</span>}
        </div>
      </div>
      {done && (
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

      <div className="transfer-row">
        <div>
          <div className="dd-title">Export tasks</div>
          <div className="muted" style={{ fontSize: 11 }}>Downloads this list as a content-only JSON bundle. Run state and machine paths are excluded.</div>
        </div>
        <a className="btn small" href={api.exportListUrl(cfg.id)} download>Export list (JSON)</a>
      </div>

      {/* Remove list - a user-created human-managed list (dropped straight from the
          board) OR a derived duty column (deselects its DUTY from the composition).
          The fixed human head/tail (backlog, todo, discuss, done, needs-attention)
          is structural and never removable. Either way, cards sitting here are
          parked to Needs attention. */}
      {(cfg.userCreated || (cfg.kind === "agent" && !cfg.interactive)) && !["backlog", "todo", "discuss", "done", "needs-attention"].includes(cfg.id) && (
        <div className="danger-zone" style={{ marginTop: 16 }}>
          <div className="dd-title">Remove list</div>
          {!confirmRemove ? (
            <button className="btn danger small" disabled={removing} onClick={() => setConfirmRemove(true)}>
              Remove list…
            </button>
          ) : (
            <div>
              <p className="muted" style={{ fontSize: 12 }}>
                {cfg.userCreated ? (
                  <>This removes the <strong>{cfg.title}</strong> list from the board. Cards
                  currently on it will be moved to Needs attention.</>
                ) : (
                  <>This removes the <strong>{cfg.id}</strong> duty from the composition as
                  well - the operative will no longer route work through this phase. Cards
                  currently on this list will be moved to Needs attention. Cards whose
                  journey includes it will re-route past it.</>
                )}
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
                  {removing ? "Removing…" : cfg.userCreated ? "Yes, remove list" : "Yes, remove list + duty"}
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

// ── focused conversation modal ──────────────────────────────────────────────
// The card's conversation as the WHOLE surface: what the web channel is to a
// thread, this sheet is to a card - stream on top, composer pinned at the
// bottom, everything else one click deeper. Card fronts open THIS (the log
// buttons are gone from the front; the raw log lives in the conversation's own
// header), and the full detail sheet is behind the Card details button.
function ConversationSheet({ cardId, onClose, onOpenCard, onWatch, onStart, busy = false }: {
  cardId: string;
  onClose: () => void;
  onOpenCard: (cardId: string) => void;
  onWatch: (c: CardSummary) => void;
  onStart?: (c: CardSummary) => void;
  busy?: boolean;
}) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openTranscript, setOpenTranscript] = useState<{ sessionId: string; index: number } | null>(null);
  // Same 3s pull the detail sheet uses: the stream renders itself over SSE, but
  // the modal still needs the card's own state (list, conversation id, autonomy)
  // live - a Start pressed here materialises the conversation into this poll.
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
  const card = detail?.card ?? null;
  const frozen = Boolean(card?.frozen?.at);
  const conversationId = card?.conversationId ?? null;
  return (
    <Sheet title={card?.title ?? "Conversation"} onClose={onClose} size="conv">
      {err && !card && <div className="banner">Could not load the card: {err}</div>}
      {card && (
        <div className="conv-meta">
          <button className="chip mono chip-id" title="copy the card id" onClick={() => { void navigator.clipboard?.writeText(card.id); }}>{card.id}</button>
          <span className="chip">{card.list}</span>
          {card.autonomous && <span className="chip">autonomous</span>}
          {card.project && <span className="chip">{card.project}</span>}
          <span className="conv-meta-spacer" />
          <button className="btn small" title="the full card - description, checklist, run configuration, history" onClick={() => onOpenCard(card.id)}>
            Card details
          </button>
        </div>
      )}
      {card && conversationId && (
        <div className="conv-focus">
          <CardConversation
            conversationId={conversationId}
            title={card.title}
            generation={`${card.rev}:${card.status}`}
            frozen={frozen}
            onRawLog={() => onWatch(card)}
            onOpenRuntimeTranscript={(sessionId) => setOpenTranscript({
              sessionId,
              index: (card.sessionIds ?? []).indexOf(sessionId)
            })}
          />
        </div>
      )}
      {card && !conversationId && (
        <div className="conv-empty">
          <p className="muted">No conversation yet - this card has not been started.</p>
          {!frozen && onStart && (
            <button className="btn primary" disabled={busy || card.status === "running"} onClick={() => onStart(card)}>
              <PlayIcon /> Start
            </button>
          )}
        </div>
      )}
      {openTranscript && (
        <RuntimeTranscriptModal
          cardId={cardId}
          sessionId={openTranscript.sessionId}
          index={openTranscript.index}
          onClose={() => setOpenTranscript(null)}
        />
      )}
    </Sheet>
  );
}

// ── generic modal sheet ─────────────────────────────────────────────────────
function Sheet({ title, onClose, children, size = "default" }: { title: string; onClose: () => void; children: ReactNode; size?: "default" | "mid" | "wide" | "conv" }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${size === "wide" ? " wide" : size === "mid" ? " mid" : size === "conv" ? " wide conv" : ""}`} onClick={(e) => e.stopPropagation()}>
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
  | { kind: "new"; placement?: string }
  | { kind: "move"; card: CardSummary }
  | { kind: "detail"; cardId: string; focus?: "conversation" }
  | { kind: "conversation"; cardId: string }
  | { kind: "watch"; card: CardSummary }
  | { kind: "terminal"; card: CardSummary }
  | { kind: "config"; listId: string }
  | { kind: "feedback"; card: CardSummary }
  | { kind: "import" }
  | null;

function initialOverlayFromLocation(): Overlay {
  if (typeof window === "undefined") return null;
  const cardId = cardIdFromLocation(window.location);
  if (cardId) return { kind: "detail", cardId };
  const query = new URLSearchParams(window.location.search);
  if (query.get("new") !== "1") return null;
  const placement = (query.get("placement") || "").trim();
  return { kind: "new", ...(placement ? { placement } : {}) };
}

// ── card import sheet ───────────────────────────────────────────────────────
// Accepts either Garrison's content-only card bundle or Trello's raw board JSON
// export. The server owns detection, sanitisation, and preview so a future live
// Trello connector can feed the same adapter without changing this surface.
function ImportSheet({
  board,
  onClose,
  onImported
}: {
  board: BoardView;
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const manualLists = board.lists.filter(isManualImportTarget);
  const [bundle, setBundle] = useState<unknown | null>(null);
  const [fileName, setFileName] = useState("");
  const [targetList, setTargetList] = useState(manualLists.find((list) => list.id === "todo")?.id ?? manualLists[0]?.id ?? "");
  const [sourceList, setSourceList] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [preview, setPreview] = useState<CardImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!bundle || !targetList) return;
    let alive = true;
    setPreviewing(true);
    setErr(null);
    api.importCards({
      bundle,
      targetList,
      preview: true,
      sourceList: sourceList || null,
      includeArchived
    }).then((result) => {
      if (alive && "preview" in result) setPreview(result);
    }).catch((e) => {
      if (alive) { setPreview(null); setErr(e instanceof Error ? e.message : String(e)); }
    }).finally(() => { if (alive) setPreviewing(false); });
    return () => { alive = false; };
  }, [bundle, targetList, sourceList, includeArchived]);

  async function pickFile(file: File | null) {
    if (!file) return;
    setErr(null);
    setPreview(null);
    setSourceList("");
    if (file.size > 50 * 1024 * 1024) {
      setErr("That JSON file is larger than 50 MB. Export a single Trello board or a smaller Garrison list.");
      return;
    }
    try {
      setBundle(JSON.parse(await file.text()));
      setFileName(file.name);
    } catch {
      setBundle(null);
      setFileName("");
      setErr("The selected file is not valid JSON.");
    }
  }

  async function confirmImport() {
    if (!bundle || !targetList || !preview?.count) return;
    setImporting(true);
    setErr(null);
    try {
      const result = await api.importCards({
        bundle,
        targetList,
        sourceList: sourceList || null,
        includeArchived
      });
      if (!("imported" in result)) throw new Error("The import returned another preview instead of creating cards.");
      onImported(result.imported);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setImporting(false);
    }
  }

  return (
    <Sheet title="Import tasks" onClose={onClose} size="mid">
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Choose a Garrison card bundle or a Trello board JSON export. For Trello:
        Board menu → Print, Export and Share → Export as JSON. The file stays on
        this Garrison machine; comments, members, attachments, and runtime data are not imported.
      </p>
      <label className="import-drop">
        <span>{fileName || "Choose a .json file"}</span>
        <input type="file" accept=".json,application/json" onChange={(e) => void pickFile(e.target.files?.[0] ?? null)} />
      </label>

      {preview?.sourceFormat === "trello" && (
        <>
          <div className="field">
            <label htmlFor="import-source-list">Trello source list</label>
            <select id="import-source-list" value={sourceList} onChange={(e) => setSourceList(e.target.value)}>
              <option value="">All open lists</option>
              {preview.sourceLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.title}{list.archived ? " (archived list)" : ""} · {list.count ?? 0} open
                </option>
              ))}
            </select>
          </div>
          <label className="check-row import-archived">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            Include archived Trello cards and cards on archived lists
          </label>
        </>
      )}

      <div className="field">
        <label htmlFor="import-target-list">Garrison destination list</label>
        <select id="import-target-list" value={targetList} onChange={(e) => setTargetList(e.target.value)}>
          {manualLists.map((list) => <option key={list.id} value={list.id}>{list.title}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 11 }}>Imported cards are inserted at the top. Agent lists are excluded so an import cannot start runs.</span>
      </div>

      {previewing && <div className="banner info">Reading and validating the import…</div>}
      {preview && !previewing && (
        <div className="import-preview">
          <div><strong>{preview.count}</strong> task{preview.count === 1 ? "" : "s"} ready from {preview.sourceName}</div>
          {preview.warnings.length > 0 && (
            <details>
              <summary>{preview.warnings.length} import note{preview.warnings.length === 1 ? "" : "s"}</summary>
              <ul>{preview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      {err && <div className="banner">{err}</div>}
      <button className="btn primary" disabled={importing || previewing || !preview?.count} onClick={() => void confirmImport()}>
        {importing ? "Importing…" : preview ? `Import ${preview.count} task${preview.count === 1 ? "" : "s"}` : "Choose a file to preview"}
      </button>
    </Sheet>
  );
}

// ── drag-and-drop wrappers (Trello-style) ───────────────────────────────────
// Cards sort within a column and move across columns; columns reorder by being
// dragged anywhere on their surface. The sortable transform provides the slot
// gap; the floating copy rides DragOverlay. Engine-owned cards may reorder inside
// their own column (position is a benign patch) but never change column by drag.

/**
 * Gate a sortable's activator on `shouldActivateDrag` so a press inside a text
 * field never becomes a drag. Everything else on the surface stays live — see
 * drag-activation.ts for why the exemption lives here and not at each control.
 * Returns the listener map unchanged in shape, so it still spreads onto a node.
 */
type HoldActivators = Record<string, (event: { target: EventTarget | null }) => void>;

function useHoldActivators(listeners: Record<string, Function> | undefined): HoldActivators | undefined {
  return useMemo(() => {
    if (!listeners) return undefined;
    const gated: HoldActivators = {};
    for (const [name, handler] of Object.entries(listeners)) {
      gated[name] = (event) => {
        if (!shouldActivateDrag(event?.target ?? null)) return;
        (handler as (e: unknown) => void)(event);
      };
    }
    return gated;
  }, [listeners]);
}

function SortableCardWrap({ card, listId, children }: { card: CardSummary; listId: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", card, listId },
    disabled: listId === "scheduled"
  });
  const holdActivators = useHoldActivators(listeners);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      className={`sortable-card${isDragging ? " drag-source" : ""}`}
      {...attributes}
      {...holdActivators}
    >
      {children}
    </div>
  );
}

// The column body is itself a drop target so a card can land in an EMPTY list.
function ListBodyDroppable({ listId, children }: { listId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `body:${listId}`, data: { type: "body", listId }, disabled: listId === "scheduled" });
  return (
    <div ref={setNodeRef} className={`lbody${isOver ? " drop-over" : ""}`}>
      {children}
    </div>
  );
}

// A column: sortable from ANYWHERE on it, header and body alike. A card drag
// still wins over its column's — the card's activator is the inner one, so it
// runs first and marks the press as captured, and dnd-kit then skips the column.
// The header keeps `attributes` (role/aria) as the column's accessible handle;
// only the activators widen to the whole section.
function SortableColumn({ list, className, header, children }: { list: ListView; className: string; header: ReactNode; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `col:${list.id}`,
    data: { type: "column", listId: list.id },
    disabled: list.id === "scheduled"
  });
  const holdActivators = useHoldActivators(listeners);
  return (
    <section
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      className={`${className}${isDragging ? " drag-source" : ""}`}
      {...holdActivators}
    >
      <div className="col-drag-handle" {...attributes}>
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
  const [overlay, setOverlay] = useState<Overlay>(initialOverlayFromLocation);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The board / frozen-History switch. Deliberately component state and not a
  // route: History is a place you visit and leave, a reload landing back on the
  // board is the right default, and a card link (?card= / #card=) still opens
  // its modal over whichever of the two is showing.
  const [view, setView] = useState<"board" | "history">("board");
  // Bumped when an open card writes back, so History re-reads GET /history. A
  // frozen record only ever changes one way - it is deleted - and that has to
  // leave the column it was in, or the count above it starts lying.
  const [historyRev, setHistoryRev] = useState(0);
  // ── drag state ────────────────────────────────────────────────────────────
  // During a drag the board renders from these overrides (membership order per
  // list / column order) so items shift live; the poll is paused (a reload
  // mid-drag would rip the dragged node out of the DOM). Cleared after the
  // post-drop reload lands.
  const [cardOrderOverride, setCardOrderOverride] = useState<Record<string, string[]> | null>(null);
  const [colOrderOverride, setColOrderOverride] = useState<string[] | null>(null);
  const [activeDrag, setActiveDrag] = useState<{ type: "card"; card: CardSummary } | { type: "column"; listId: string } | null>(null);
  // Empty autonomous columns are hidden so the human scrolls past phases that
  // hold work, not phases that could. The preference is per-browser and sticky:
  // someone who wants the whole rail wants it on the next visit too.
  const [showAllLists, setShowAllLists] = useState<boolean>(() => {
    try { return window.localStorage.getItem("garrison.kanban.showAllLists") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem("garrison.kanban.showAllLists", showAllLists ? "1" : "0"); } catch { /* private mode: the session-only default is fine */ }
  }, [showAllLists]);
  // A hash-only navigation does NOT reload the document, so a card link opened
  // while the board is already up (the common case - the board is a standing
  // tab) reaches us only through hashchange. Without this, the first card link
  // works and every later one silently does nothing.
  useEffect(() => {
    const onHashCard = () => {
      const cardId = cardIdFromLocation(window.location);
      if (cardId) setOverlay({ kind: "detail", cardId });
    };
    window.addEventListener("hashchange", onHashCard);
    return () => window.removeEventListener("hashchange", onHashCard);
  }, []);
  // Closing the sheet must also drop the card out of the URL, or re-clicking the
  // SAME link fires no hashchange (the hash never changed) and nothing opens.
  const closeCardOverlay = useCallback(() => {
    setOverlay(null);
    if (typeof window === "undefined") return;
    if (!cardIdFromLocation(window.location)) return;
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("card");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);
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
  // Drag activation is INPUT-SPECIFIC (see drag-activation.ts for the full why):
  //
  //  - Touch is a deliberate long-press: the finger must stay down (within
  //    DRAG_HOLD_TOLERANCE_TOUCH px) for DRAG_HOLD_MS before a card or column
  //    lifts. Move past the tolerance first and the gesture is a scroll — that is
  //    what stops the board picking cards up when you meant to scroll the phone.
  //  - Mouse is distance-based: press and travel DRAG_MOUSE_DISTANCE px and the
  //    drag starts immediately (the desktop norm); a stationary press stays a
  //    click and opens the card.
  //
  // MouseSensor + TouchSensor, deliberately NOT PointerSensor. On a touch device
  // `pointerdown` beats `touchstart`, so a PointerSensor captures the gesture and
  // then loses it: the board's lists scroll (`touch-action: manipulation`), so the
  // moment the finger moves the browser claims the gesture for panning and fires
  // `pointercancel` - the hold succeeded and the drag died on the first
  // millimetre. TouchSensor owns the touch path instead and preventDefaults
  // `touchmove` once activated, which holds the scroll off for the drag's duration.
  const dndSensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: DRAG_MOUSE_DISTANCE }
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: DRAG_HOLD_MS, tolerance: DRAG_HOLD_TOLERANCE_TOUCH }
    })
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

  async function onRunSchedule(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      const result = await api.runScheduleNow(card.id);
      await load();
      setNotice(result.occurrence
        ? `${result.created ? "Created" : "Found"} scheduled occurrence ${result.card.id.slice(-6)}`
        : "Released the one-time schedule to run now");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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

  // Delete straight from the card front. Irreversible and it takes the card's run
  // directory with it, so it always asks first and names the card in the prompt -
  // the board is a grid of near-identical tiles and "are you sure?" is not enough
  // to tell you which one you are about to destroy.
  async function onDelete(card: CardSummary) {
    if (!window.confirm(`Delete "${card.title || card.id}"? This removes the card and its run history for good.`)) return;
    setBusyCard(card.id);
    setNotice(null);
    try {
      await api.del(card.id);
      await load();
      setNotice("Card deleted");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // WS2 (D7): continue a DONE card's work in one click — create a successor card
  // (continues=<id>, its prompt seeded from the predecessor's handoff packet) on
  // To do. Starting it kicks a fresh conversation seeded from that handoff.
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

  // Talking about a card IS its conversation, and the conversation deserves the
  // whole modal: Discuss opens the focused conversation sheet (the web-channel
  // experience, straight on the board). The full card detail stays one click
  // away inside it. A card whose first stretch has not run yet still opens -
  // the sheet offers Start and the surface appears the moment a conversation
  // exists.
  function onDiscuss(card: CardSummary) {
    setOverlay({ kind: "conversation", cardId: card.id });
  }

  // One click IS the approval: the nod lands in the conversation as a real
  // user message (exactly what typing "go ahead" does), which un-arms the
  // autonomy gate and kicks the next stretch.
  async function onApprove(card: CardSummary) {
    if (!card.conversationId) {
      setNotice("This card has no conversation to approve.");
      return;
    }
    setBusyCard(card.id);
    setNotice(null);
    try {
      const res = await fetch(`${CONVERSATION_BASE}/${encodeURIComponent(card.conversationId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Approved - continue.", origin: "kanban" })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `The approval could not be delivered (${res.status}).`);
      }
      setNotice("Approved - the conversation continues.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setBusyCard(null);
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
    return [...lists].sort((a, b) => {
      if (a.id === "scheduled") return -1;
      if (b.id === "scheduled") return 1;
      return 0;
    });
  }, [board, colOrderOverride, cardOrderOverride, cardById]);

  // What the rail actually renders. displayLists stays the COMPLETE ordered set
  // (drag snapshots order from it, so a hidden column keeps its place); this is
  // that set minus the empty autonomous phases. A drag reveals everything again
  // - a column that disappeared when you picked a card up cannot be dropped on.
  const boardLists = useMemo(
    () => visibleLists(displayLists, { showAll: showAllLists, dragging: Boolean(activeDrag) }),
    [displayLists, showAllLists, activeDrag]
  );
  const hiddenCount = useMemo(
    () => hiddenListCount(displayLists, { showAll: showAllLists, dragging: Boolean(activeDrag) }),
    [displayLists, showAllLists, activeDrag]
  );

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
    // A short haptic tick the instant a card/column lifts, so a long-press on a
    // phone confirms itself in the hand as well as on screen. Feature-detected —
    // a no-op on desktop and anywhere the Vibration API is absent or denied.
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(10); } catch { /* some engines throw if denied */ }
    }
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
    // Raise the click guard synchronously, before the first awaited PATCH/load.
    // Browsers dispatch the pointer-up click immediately; doing this in finally
    // was too late and opened the card while the network write was still running.
    dragActiveRef.current = false;
    markDragJustEnded();
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
      <TopBar
        onNew={() => setOverlay({ kind: "new" })}
        onImport={board ? () => setOverlay({ kind: "import" }) : undefined}
        // History carries its own Back control, so the top-bar entry is offered
        // only from the board - one way in, one way out, never two live toggles.
        onHistory={view === "board" ? () => setView("history") : undefined}
        status={board ? `${board.cards.length} cards` : "loading…"}
        // The rail only exists on the board, so its control is offered there.
        hiddenLists={view === "board" ? hiddenCount : 0}
        showAllLists={showAllLists}
        onToggleAllLists={view === "board" ? () => setShowAllLists((v) => !v) : undefined}
      />
      {runtime?.noGateway && (
        <div className="banner" role="status">
          No gateway running - agent lists won&apos;t dispatch. Bring the composition up (Run / `npm start`).
        </div>
      )}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}
      {view === "history" ? (
        <HistoryView
          refreshKey={historyRev}
          onBack={() => setView("board")}
          onOpenCard={(cardId) => setOverlay({ kind: "detail", cardId })}
        />
      ) : (
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
              <SortableContext items={boardLists.map((l) => `col:${l.id}`)} strategy={horizontalListSortingStrategy}>
                {boardLists.map((list) => (
                  <SortableColumn
                    key={list.id}
                    list={list}
                    className={listClass(list)}
                    header={
                      <div className="lh">
                        <div className="lname">
                          <span className="lname-text">{list.title}</span>
                          <span className="count">{list.cards.length}</span>
                          {!list.system && (
                            <button
                              className="gear"
                              title={`Configure ${list.title}`}
                              aria-label={`Configure ${list.title}`}
                              onClick={() => setOverlay({ kind: "config", listId: list.id })}
                            >
                              <GearIcon />
                            </button>
                          )}
                        </div>
                        <div className="lkind">
                          {list.id === "scheduled" ? (
                            "system · schedules"
                          ) : list.id === "running" ? (
                            "system · conversations"
                          ) : (
                            `${list.kind} · ${list.trigger}`
                          )}
                        </div>
                      </div>
                    }
                  >
                    <ListBodyDroppable listId={list.id}>
                      {/* Backlog and To Do lead with direct-create affordances. The
                          server inserts into that list under the same top-order lock,
                          so there is no transient Backlog card or create-then-move
                          activity. These controls replace the bare empty state. */}
                      {canAddCardDirectly(list.id) && (
                        <ListAddCard
                          listId={list.id}
                          listTitle={list.title}
                          onCreated={() => void load()}
                        />
                      )}
                      {list.cards.length === 0 && !canAddCardDirectly(list.id) && (
                        <div className="lempty">{list.id === "scheduled" ? "No scheduled tasks" : "empty"}</div>
                      )}
                      {(() => {
                        const renderCard = (card: CardSummary, sortable = true) => {
                          const inner = (
                            <Card
                              key={sortable ? undefined : card.id}
                              card={card}
                              list={list}
                              busy={busyCard === card.id}
                              onStart={onStart}
                              onApprove={onApprove}
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
                              onDelete={onDelete}
                              onWatch={(c) => setOverlay({ kind: "watch", card: c })}
                              onTerminal={(c) => setOverlay({ kind: "terminal", card: c })}
                              onOpen={(c) => setOverlay({ kind: "detail", cardId: c.id })}
                              onRenamed={load}
                              onContinue={onContinue}
                              onDrill={onDrill}
                              onFeedback={(c) => setOverlay({ kind: "feedback", card: c })}
                              onRunSchedule={onRunSchedule}
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
      )}

      {overlay?.kind === "new" && (
        <NewCardSheet board={board} initialPlacement={overlay.placement} onClose={() => setOverlay(null)} onCreated={() => void load()} />
      )}
      {overlay?.kind === "move" && board && (
        <MoveSheet card={overlay.card} board={board} onClose={() => setOverlay(null)} onMoved={() => void load()} />
      )}
      {overlay?.kind === "detail" && (
        <DetailSheet
          key={overlay.cardId}
          cardId={overlay.cardId}
          board={board}
          focus={overlay.focus}
          onClose={closeCardOverlay}
          onChanged={() => { void load(); setHistoryRev((n) => n + 1); }}
          onWatch={(c) => setOverlay({ kind: "watch", card: c })}
          onTerminal={(c) => setOverlay({ kind: "terminal", card: c })}
          onOpenCard={(cardId) => setOverlay({ kind: "detail", cardId })}
          actions={{
            onStart,
            onApprove,
            onMove: (c) => setOverlay({ kind: "move", card: c }),
            onQuickMove,
            // The sheet is showing the card that just went away, so close it.
            onDelete: async (c) => { await onDelete(c); setOverlay(null); },
            onWatch: (c) => setOverlay({ kind: "watch", card: c }),
            onTerminal: (c) => setOverlay({ kind: "terminal", card: c }),
            onInfer,
            onDiscuss,
            onContinue,
            onDrill,
            onFeedback: (c) => setOverlay({ kind: "feedback", card: c }),
            onRunSchedule
          }}
        />
      )}
      {overlay?.kind === "conversation" && (
        <ConversationSheet
          key={overlay.cardId}
          cardId={overlay.cardId}
          onClose={closeCardOverlay}
          onOpenCard={(cardId) => setOverlay({ kind: "detail", cardId })}
          onWatch={(c) => setOverlay({ kind: "watch", card: c })}
          onStart={onStart}
          busy={busyCard === overlay.cardId}
        />
      )}
      {overlay?.kind === "watch" && (
        <WatchSheet
          card={overlay.card}
          onClose={() => setOverlay(null)}
          onChanged={() => void load()}
          onReviewRouting={() => setOverlay({ kind: "detail", cardId: overlay.card.id })}
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
      {overlay?.kind === "import" && board && (
        <ImportSheet
          board={board}
          onClose={() => setOverlay(null)}
          onImported={(count) => { setNotice(`Imported ${count} task${count === 1 ? "" : "s"}`); void load(); }}
        />
      )}
    </>
  );
}

function TopBar({ onNew, onImport, onHistory, status, hiddenLists, showAllLists, onToggleAllLists }: {
  onNew: () => void; onImport?: () => void; onHistory?: () => void; status: string;
  /** How many empty autonomous columns the rail is holding back right now. */
  hiddenLists?: number;
  showAllLists?: boolean;
  onToggleAllLists?: () => void;
}) {
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
      {/* Offered only when it would change something: either columns are hidden
          right now, or every column is showing BECAUSE the human asked. */}
      {onToggleAllLists && (showAllLists || (hiddenLists ?? 0) > 0) && (
        <button
          className="btn"
          aria-pressed={Boolean(showAllLists)}
          title={showAllLists
            ? "hide autonomous phases that hold no cards"
            : `show ${hiddenLists} empty autonomous phase${hiddenLists === 1 ? "" : "s"}`}
          onClick={onToggleAllLists}
        >
          {showAllLists ? "Hide empty" : `Show all (${hiddenLists})`}
        </button>
      )}
      {onHistory && <button className="btn" onClick={onHistory}>History</button>}
      <a className="btn" href={api.exportBoardUrl()} download>Export</a>
      {onImport && <button className="btn" onClick={onImport}>Import</button>}
      <button className="btn primary" onClick={onNew}><PlusIcon /> New card</button>
    </header>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
