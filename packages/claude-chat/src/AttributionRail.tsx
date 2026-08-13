import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RouteAttribution, TurnRouting } from "./transport";
import { railBadges, type RailBadge } from "./run-context";

// The Turn Rail: ONE horizontally-scrolling line of small mono badges where each
// badge that names a settable dimension IS its own dropdown.
//
// Two hard constraints shape this file:
//
//  1. The class prefix is `.cc-rbadge`, never `.cc-badge`. `.cc-badge` already
//     exists for the slash-command source chips (9px, uppercase, light-theme
//     overrides) and the web channel concatenates its own `ui/styles.css` AFTER
//     claude-chat.css, so reusing the name would silently inherit - and lose to -
//     rules written for a completely different widget.
//  2. The badge TEXT comes from `railBadges()` in run-context.ts and nowhere else.
//     That module owns the honesty rules (an unreported dimension has no badge;
//     `account: null` means "machine login"; a refused effort says so). This file
//     only adds the two things a pure badge model cannot know: which dimension a
//     badge lets you CHANGE, and whether the user has pinned something that has
//     not reached a turn yet.

/** The dimensions a user can pin. Mirrors {@link TurnRouting} exactly - `runtime`
 *  and `model` are not independently settable, so `runtime`'s badge pins a TARGET
 *  (a target picks runtime+provider+model coherently). */
export type PinField =
  | "target"
  | "model"
  | "effort"
  | "duty"
  | "level"
  | "project"
  | "account"
  | "tier"
  | "flow"
  | "phasesOff";

/** A sparse change to the pins. A `null` value CLEARS that pin (back to the
 *  composition's routing) - it never means "pin the value null". */
export type PinPatch = Partial<Record<PinField, string | number | null>>;

/** Which pin(s) a given badge key speaks for. `duty` covers `level` too: the two
 *  are one badge ("plan L2") because a level without a duty is meaningless. */
const BADGE_FIELDS: Record<string, PinField[]> = {
  duty: ["duty", "level"],
  runtime: ["target"],
  model: ["model"],
  effort: ["effort"],
  account: ["account"],
  project: ["project"],
  target: ["target"],
  tier: ["tier"],
  flow: ["flow", "phasesOff"],
};

/** The dimension order used for pins that have no resolved badge yet, and for the
 *  flight rail's placeholders. Mirrors railBadges' meaning-first order. */
const PIN_ORDER: PinField[] = [
  "duty",
  "tier",
  "target",
  "model",
  "effort",
  "account",
  "project",
  "flow",
  "phasesOff",
];

/** Human dimension names, used for a placeholder badge's label and for every
 *  menu heading. Deliberately lowercase - the rail is a mono line, not prose. */
const FIELD_LABEL: Record<PinField, string> = {
  target: "target",
  model: "model",
  effort: "effort",
  duty: "duty",
  level: "level",
  project: "project",
  account: "account",
  tier: "tier",
  flow: "flow",
  phasesOff: "phases",
};

/** The "stop pinning this" row per dimension. Says what happens INSTEAD, because
 *  "clear" alone does not tell the user what will run. */
const AUTO_LABEL: Record<PinField, string> = {
  target: "Automatic - the composition's routing",
  model: "Automatic - the resolved target's model",
  effort: "Automatic - the duty's effort",
  duty: "Automatic - routing inference decides",
  level: "Automatic",
  project: "Automatic - the operative's own directory",
  account: "Automatic - the composition's account",
  tier: "Automatic - routing inference decides",
  // 2026-08-13: flows carry levelled duty lists now; the router derives the flow
  // from the routed duty and the flow's level defines the plan. "Inferred from
  // the tier" was the pre-coherence world and read as if nothing had shipped.
  flow: "Automatic - the router picks the flow, its level picks the plan",
  phasesOff: "Automatic - every phase in the plan runs",
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Parse `phasesOff` ("a,b") into ids. Tolerant of spaces and empty segments, so a
 *  hand-edited pin or a trailing comma does not silently disable nothing. */
export function splitPhasesOff(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Serialize an OFF set back to the wire form, ordered by the plan (not by tap
 *  order) so the same selection always produces the same string - the pin is
 *  persisted and compared, and a set that reorders itself reads as a change. */
export function joinPhasesOff(off: string[], planOrder: string[]): string | null {
  const set = new Set(off);
  const ordered = planOrder.filter((p) => set.has(p));
  // Anything not in the plan is kept at the end rather than dropped: silently
  // discarding a phase id would turn a stale-but-explicit pin into a fake "all on".
  for (const p of off) if (!planOrder.includes(p)) ordered.push(p);
  return ordered.length ? ordered.join(",") : null;
}

/** A pin is "in force" when it holds a real value. `null`/`undefined`/blank all
 *  mean "not pinned" - see PinPatch. */
function pinnedValue(pins: TurnRouting | null | undefined, field: PinField): string | number | null {
  if (!pins) return null;
  const raw = (pins as Record<string, unknown>)[field];
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
  const s = str(raw);
  return s ? s : null;
}

/** What actually RAN for a dimension, so a pin that has already taken effect is
 *  not mislabelled "applies next turn". */
function ranValue(route: RouteAttribution | null | undefined, field: PinField): string | number | null {
  if (!route) return null;
  switch (field) {
    case "target":
      return str(route.route) || null;
    case "model":
      return str(route.model) || null;
    case "effort":
      return str(route.effort) || null;
    case "duty":
      return str(route.duty) || null;
    case "level":
      return typeof route.level === "number" && Number.isFinite(route.level) ? Math.trunc(route.level) : null;
    case "project":
      return str(route.project) || null;
    case "account":
      return str(route.account) || null;
    case "tier":
      return str(route.tier) || null;
    case "flow":
      return str(route.flow) || null;
    case "phasesOff":
      return str(route.phasesOff) || null;
  }
}

/** A badge as the rail renders it: the pure model plus the interaction facts. */
export interface RailDisplayBadge extends RailBadge {
  /** The dimension this badge opens a menu for; absent = information only. */
  field?: PinField;
  /** A pin is in force for this dimension. */
  pinned?: boolean;
  /** The pin has NOT reached a turn yet (changed mid-turn, or set before the next
   *  send). Renders `.cc-rbadge-pending` / "applies next turn" - never a silent
   *  mid-turn re-route: preRoute has already resolved for the running turn. */
  pending?: boolean;
  /** Nothing ran and nothing is pinned: the label is the DIMENSION NAME and the
   *  badge exists only so the dimension is reachable. Never a fake value. */
  placeholder?: boolean;
  /**
   * The orchestrator chose this value, not the user. Set only when the turn
   * REPORTED a value for a dimension that carries no pin - so it is a fact about
   * the turn, never an assumption about an unreported dimension (which gets no
   * badge at all). This is what makes "everything defaults to auto" legible: an
   * unmarked badge is yours, a marked one is the orchestrator's, and the marked
   * ones are exactly the set worth confirming or correcting afterwards.
   */
  auto?: boolean;
}

/**
 * The rail's badge list = the pure attribution badges, plus a badge for any pin
 * that the attribution does not already speak for, plus (flight rail only)
 * a placeholder per still-unpinned dimension.
 *
 * The placeholders are the one concession to usability, and they stay inside the
 * honesty rule: their label is the dimension's NAME ("project"), never a guessed
 * value, and their tooltip says "not pinned". Without them a fresh conversation
 * would render an empty rail with no way to pin anything at all.
 *
 * Pure: no React, no DOM, no clock - the tests drive it directly.
 */
export function railDisplayBadges(opts: {
  route?: RouteAttribution | null;
  pins?: TurnRouting | null;
  pendingFields?: readonly PinField[];
  offerAll?: boolean;
}): RailDisplayBadge[] {
  const { route, pins, pendingFields = [], offerAll = false } = opts;
  const pendingSet = new Set(pendingFields);
  const spokenFor = new Set<PinField>();

  const base: RailDisplayBadge[] = railBadges(route ?? {}).map((b) => {
    const fields = BADGE_FIELDS[b.key] ?? [];
    fields.forEach((f) => spokenFor.add(f));
    const field = fields[0];
    if (!field) return { ...b };
    // "pending" = the user's pin differs from what this turn actually ran (or was
    // touched while the turn was in flight). Comparing against the RESOLVED value
    // is what keeps a pin that already took effect from nagging forever.
    const drifted = fields.some((f) => {
      const pin = pinnedValue(pins, f);
      return pin !== null && pin !== ranValue(route, f);
    });
    const pinned = fields.some((f) => pinnedValue(pins, f) !== null);
    const pending = fields.some((f) => pendingSet.has(f)) || drifted;
    // Auto = the turn reported a value here and the user pinned nothing. Derived
    // from the two facts already in hand rather than from `via`: `via` describes
    // how the ROUTE as a whole resolved, so a turn-override on one dimension would
    // otherwise mark every other dimension as user-chosen when they were not.
    const auto = !pinned && fields.some((f) => ranValue(route, f) !== null);
    return {
      ...b,
      field,
      ...(pinned ? { pinned: true } : {}),
      ...(pending ? { pending: true } : {}),
      ...(auto ? { auto: true } : {}),
    };
  });

  const extra: RailDisplayBadge[] = [];
  for (const field of PIN_ORDER) {
    if (spokenFor.has(field)) continue;
    const pin = pinnedValue(pins, field);
    if (pin !== null) {
      // A pin with no resolved counterpart: the dimension was pinned but no turn
      // has reported it yet. Label it with what the user chose and say plainly
      // that it has not run.
      const level = field === "duty" ? pinnedValue(pins, "level") : null;
      extra.push({
        key: field,
        field,
        label: `${pin}${level !== null ? ` L${level}` : ""}`,
        title: `pinned ${FIELD_LABEL[field]} ${pin} - applies to your next message`,
        pinned: true,
        pending: true,
      });
      continue;
    }
    if (offerAll) {
      extra.push({
        key: field,
        field,
        label: FIELD_LABEL[field],
        title: `${FIELD_LABEL[field]}: not pinned - open to choose one for your next message`,
        tone: "dim",
        placeholder: true,
      });
    }
  }

  return [...base, ...extra];
}

// ── Option lists (host-supplied; this package never fetches) ─────────────────
// Shapes mirror the gateway's GET /route/options one-for-one so the host can hand
// the parsed payload straight through.

export interface RailTargetOption {
  id: string;
  runtime?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  account?: string | null;
}
export interface RailDutyOption {
  id: string;
  title?: string | null;
  levels?: { n: number; description?: string | null }[] | null;
}
export interface RailAccountOption {
  name: string;
  platform?: string | null;
}
/** One flow from the compiled policy, with the phases its plan runs (in plan
 *  order). `phases` is what the phases menu offers - a phase outside the selected
 *  kind's plan is not toggleable, because turning it ON is not a thing the rail can
 *  do (`railForCard` only ever reads `toggles[id] === false`). */
export interface RailFlowOption {
  id: string;
  description?: string | null;
  phases?: string[] | null;
}
export interface RailOptions {
  targets?: RailTargetOption[] | null;
  duties?: RailDutyOption[] | null;
  efforts?: string[] | null;
  accounts?: RailAccountOption[] | null;
  projects?: string[] | null;
  tiers?: string[] | null;
  flows?: RailFlowOption[] | null;
  /** The flow used when none is pinned - labelled "(default)" in the menu so
   *  "Automatic" is not mistaken for "no plan". */
  defaultFlow?: string | null;
  /**
   * Why a dimension cannot be pinned right now, keyed by field (e.g. effort on a
   * provider with no effort control, project while the board is down). The menu
   * then offers the reason instead of rows that would be refused - honest limits
   * shipped as limits.
   */
  unavailable?: Partial<Record<PinField, string>> | null;
}

export interface RailMenuRow {
  key: string;
  label: string;
  detail?: string;
  /** The pin change this row applies. Absent on a note/link row. */
  patch?: PinPatch;
  selected?: boolean;
  disabled?: boolean;
  /** A link row (composition defaults live in Muster) - never a radio. */
  href?: string;
}

export interface RailMenu {
  field: PinField;
  /** Popover heading, also its accessible name. */
  label: string;
  rows: RailMenuRow[];
  /** The typed escape hatch. Model only: there is no model catalog anywhere in the
   *  repo, so a menu alone cannot express "the model I actually want". */
  freeText?: { field: PinField; label: string; placeholder: string };
}

/**
 * Build the dropdown for one dimension. Returns null for an information-only
 * badge (skill / card / stopped / transcript / override…): those are facts about
 * what happened, not switches, and a dropdown that cannot change anything is
 * worse than no dropdown.
 *
 * Pure, so the whole menu vocabulary is unit-testable without a DOM.
 */
export function menuForField(
  field: PinField,
  options?: RailOptions | null,
  pins?: TurnRouting | null,
  musterUrl?: string | null
): RailMenu | null {
  const rows: RailMenuRow[] = [];
  const current = pinnedValue(pins, field);
  const blocked = str(options?.unavailable?.[field]);

  const auto: RailMenuRow = {
    key: "auto",
    label: AUTO_LABEL[field],
    // The duty menu speaks for BOTH axes since they merged (2026-08-07), so its
    // Automatic row releases the flow pin too.
    patch: field === "duty"
      ? { duty: null, level: null, flow: null, phasesOff: null }
      : ({ [field]: null } as PinPatch),
    selected: field === "duty" ? current === null && pinnedValue(pins, "flow") === null : current === null,
  };

  if (field === "duty") {
    rows.push(auto);
    // Duty and flow are ONE question ("what is this work?") that used to be
    // asked as two sibling badges: a phased flow spans several duty-named
    // lists, so pinning both read as a contradiction. The duty menu now offers
    // the phased plans first; picking one pins flow and clears the
    // duty/level pins (and vice versa below). The flow badge remains as the
    // read-only home of the phase toggles.
    for (const k of options?.flows ?? []) {
      const id = str(k.id);
      if (!id) continue;
      const phases = (k.phases ?? []).filter((p) => str(p));
      rows.push({
        key: `plan:${id}`,
        label: str(options?.defaultFlow) === id ? `${id} (default plan)` : `${id} (plan)`,
        detail: phases.length ? `plan: ${phases.join(" → ")}` : str(k.description) || undefined,
        patch: { flow: id, duty: null, level: null, phasesOff: null },
        selected: pinnedValue(pins, "flow") === id && current === null,
      });
    }
    for (const duty of options?.duties ?? []) {
      const id = str(duty.id);
      if (!id) continue;
      const levels = (duty.levels ?? []).filter((l) => typeof l?.n === "number" && l.n > 0);
      if (!levels.length) {
        rows.push({
          key: id,
          label: id,
          detail: str(duty.title) || undefined,
          patch: { duty: id, level: null, flow: null, phasesOff: null },
          selected: current === id && pinnedValue(pins, "level") === null,
        });
        continue;
      }
      // Duty and level are flattened into one list ("plan L2") rather than a
      // submenu: a nested popover on a phone bottom sheet is a trap, and the
      // pair is only ever chosen together.
      for (const l of levels) {
        rows.push({
          key: `${id}:${l.n}`,
          label: `${id} L${l.n}`,
          detail: str(l.description) || str(duty.title) || undefined,
          patch: { duty: id, level: Math.trunc(l.n), flow: null, phasesOff: null },
          selected: current === id && pinnedValue(pins, "level") === Math.trunc(l.n),
        });
      }
    }
  } else if (field === "target") {
    rows.push(auto);
    for (const t of options?.targets ?? []) {
      const id = str(t.id);
      if (!id) continue;
      rows.push({
        key: id,
        label: id,
        detail: [str(t.runtime), str(t.model)].filter(Boolean).join(" / ") || undefined,
        // Pinning a target supersedes a stale free-text model: the target is the
        // coherent runtime+provider+model triple, a leftover model overlay is not.
        patch: { target: id, model: null },
        selected: current === id,
      });
    }
  } else if (field === "model") {
    rows.push(auto);
    const seen = new Set<string>();
    for (const t of options?.targets ?? []) {
      const model = str(t.model);
      if (!model || seen.has(model)) continue;
      seen.add(model);
      rows.push({
        key: model,
        label: model,
        detail: `from target ${str(t.id)}`,
        patch: { model },
        selected: current === model,
      });
    }
  } else if (field === "effort") {
    rows.push(auto);
    for (const e of options?.efforts ?? []) {
      const id = str(e);
      if (!id) continue;
      rows.push({ key: id, label: id, patch: { effort: id }, selected: current === id });
    }
  } else if (field === "account") {
    rows.push(auto);
    for (const a of options?.accounts ?? []) {
      const name = str(a.name);
      if (!name) continue;
      rows.push({
        key: name,
        label: name,
        detail: str(a.platform) || undefined,
        patch: { account: name },
        selected: current === name,
      });
    }
  } else if (field === "project") {
    rows.push(auto);
    for (const p of options?.projects ?? []) {
      const name = str(p);
      if (!name) continue;
      rows.push({ key: name, label: name, patch: { project: name }, selected: current === name });
    }
  } else if (field === "tier") {
    rows.push(auto);
    for (const t of options?.tiers ?? []) {
      const id = str(t);
      if (!id) continue;
      rows.push({
        key: id,
        label: id,
        // Pinning a tier is half of the {taskType, tier} pair. On its own it still
        // needs the classifier for the task type, so the detail says so rather than
        // implying it bought a skipped classification it did not.
        detail: pinnedValue(pins, "duty") ? "with the pinned duty: no classifier runs" : "the classifier still picks the task type",
        patch: { tier: id },
        selected: current === id,
      });
    }
  } else if (field === "flow") {
    rows.push(auto);
    for (const k of options?.flows ?? []) {
      const id = str(k.id);
      if (!id) continue;
      const phases = (k.phases ?? []).filter((p) => str(p));
      const isDefault = str(options?.defaultFlow) === id;
      rows.push({
        key: id,
        label: isDefault ? `${id} (default)` : id,
        detail: str(k.description) || (phases.length ? phases.join(" → ") : undefined),
        // Switching plans invalidates the OFF set: those phase ids belong to the
        // OLD plan, and carrying them over would silently disable phases the user
        // never looked at.
        patch: { flow: id, phasesOff: null },
        selected: current === id,
      });
    }
  } else if (field === "phasesOff") {
    // Not a radio: each row TOGGLES one phase of the selected plan. The rows are
    // the plan's phases in plan order, so the menu doubles as a preview of what
    // the run will walk.
    const kindId = str(pinnedValue(pins, "flow")) || str(options?.defaultFlow);
    const kind = (options?.flows ?? []).find((k) => str(k.id) === kindId);
    const planPhases = (kind?.phases ?? []).map((p) => str(p)).filter(Boolean);
    const off = new Set(splitPhasesOff(current));
    rows.push({ ...auto, selected: off.size === 0 });
    for (const phase of planPhases) {
      const isOff = off.has(phase);
      const next = new Set(off);
      if (isOff) next.delete(phase);
      else next.add(phase);
      rows.push({
        key: phase,
        // The label carries the state because these rows are toggles, not a
        // single-choice list - a tick alone would not say which way it goes.
        label: isOff ? `${phase} - off` : phase,
        detail: isOff ? "tap to run it again" : "tap to turn it off for this run",
        patch: { phasesOff: joinPhasesOff([...next], planPhases) },
        selected: !isOff,
      });
    }
  } else {
    return null;
  }

  // Only the "Automatic" row survived: the source is empty (the kanban board is
  // down, no accounts are sealed, …). Say which, rather than presenting a menu
  // that looks broken.
  if (rows.length === 1) {
    rows.push({
      key: "empty",
      label: `no ${FIELD_LABEL[field]} options available`,
      disabled: true,
    });
  }

  if (blocked) {
    // A blocked dimension keeps its rows visible (so the user can see what WOULD
    // be offered) but every one of them is inert, with the reason on top.
    for (const row of rows) row.disabled = true;
    rows.unshift({ key: "blocked", label: blocked, disabled: true });
  }

  if (musterUrl) {
    // Composition DEFAULTS are deliberately not editable here: they mutate
    // apm.yml for every future turn and mostly only take effect at the next up().
    rows.push({ key: "muster", label: "Composition defaults live in Muster", href: musterUrl });
  }

  return {
    field,
    label:
      field === "phasesOff"
        ? "Phases this run walks"
        : `Pin ${FIELD_LABEL[field]} for the next message`,
    rows,
    ...(field === "model"
      ? { freeText: { field: "model" as PinField, label: "Any model id", placeholder: "model id" } }
      : {}),
  };
}

export interface AttributionRailProps {
  /** What ran (or is running) for this turn. */
  route?: RouteAttribution | null;
  /** The pins in force for the NEXT message. */
  pins?: TurnRouting | null;
  /** Pins touched while a turn was in flight - they apply to the next turn. */
  pendingFields?: readonly PinField[];
  /** Menu vocabulary. Absent = a read-only rail (dev-env, persisted history). */
  options?: RailOptions | null;
  /** Apply a pin change. The HOST owns persistence; this package never fetches. */
  onPin?: (patch: PinPatch) => void;
  /** Open the routed runtime's own transcript for `route.sessionId`. */
  onOpenTranscript?: (sessionId: string) => void;
  /** `flight` = the live rail in the composer (bigger targets, opens upward, and
   *  offers every unpinned dimension); `settled` = the per-turn record. */
  variant?: "settled" | "flight";
  /** Accessible name for the toolbar. */
  label?: string;
  /** Where "Composition defaults live in Muster" points. Must be same-origin or
   *  already host-rewritten - the browser is almost never on the Garrison box. */
  musterUrl?: string | null;
  /** Right-hand slot (the flight rail's elapsed time + Stop pair). */
  children?: React.ReactNode;
}

export function AttributionRail({
  route,
  pins,
  pendingFields,
  options,
  onPin,
  onOpenTranscript,
  variant = "settled",
  label,
  musterUrl,
  children,
}: AttributionRailProps) {
  const interactive = typeof onPin === "function" && Boolean(options);
  const badges = useMemo(
    () => railDisplayBadges({ route, pins, pendingFields, offerAll: variant === "flight" && interactive }),
    [route, pins, pendingFields, variant, interactive]
  );

  /** Roving tabindex: the whole rail is ONE Tab stop and ArrowLeft/Right walks it,
   *  because a line of 8 badges would otherwise cost 8 tabs to step past. */
  const [focusIdx, setFocusIdx] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [menuIdx, setMenuIdx] = useState(0);
  const [freeText, setFreeText] = useState("");
  const itemsRef = useRef<(HTMLElement | null)[]>([]);
  const railRef = useRef<HTMLDivElement>(null);

  // A badge that disappears (its dimension stopped being reported) must not leave
  // the roving index pointing past the end, and must not leave a dead popover.
  useEffect(() => {
    if (focusIdx > badges.length - 1) setFocusIdx(Math.max(0, badges.length - 1));
    if (openKey && !badges.some((b) => b.key === openKey)) setOpenKey(null);
  }, [badges, focusIdx, openKey]);

  const openBadge = badges.find((b) => b.key === openKey) ?? null;
  const menu = useMemo(
    () => (openBadge?.field ? menuForField(openBadge.field, options, pins, musterUrl) : null),
    [openBadge, options, pins, musterUrl]
  );
  const rows = menu?.rows ?? [];

  const focusItem = useCallback((idx: number) => {
    setFocusIdx(idx);
    itemsRef.current[idx]?.focus();
  }, []);

  const closeMenu = useCallback(
    (restoreIdx?: number) => {
      setOpenKey(null);
      setMenuIdx(0);
      setFreeText("");
      if (typeof restoreIdx === "number") itemsRef.current[restoreIdx]?.focus();
    },
    []
  );

  const toggleMenu = useCallback(
    (badge: RailDisplayBadge, idx: number) => {
      if (!badge.field || !interactive) return;
      setFocusIdx(idx);
      setOpenKey((prev) => (prev === badge.key ? null : badge.key));
      setMenuIdx(0);
      setFreeText("");
    },
    [interactive]
  );

  const applyRow = useCallback(
    (row: RailMenuRow, restoreIdx: number) => {
      if (row.disabled || !row.patch) return;
      onPin?.(row.patch);
      closeMenu(restoreIdx);
    },
    [onPin, closeMenu]
  );

  // Close on an outside press. Only while a popover is open, so the rail costs
  // nothing when idle.
  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = railRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) closeMenu();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [openKey, closeMenu]);

  const onToolbarKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (openKey) return; // the popover owns the keyboard while it is open
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = (focusIdx + dir + badges.length) % Math.max(1, badges.length);
        focusItem(next);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        focusItem(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        focusItem(badges.length - 1);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const badge = badges[focusIdx];
        if (badge?.field && interactive) {
          e.preventDefault();
          toggleMenu(badge, focusIdx);
        }
      }
    },
    [openKey, focusIdx, badges, focusItem, interactive, toggleMenu]
  );

  const onMenuKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        // stopPropagation matters: Escape is ALSO the chat's cancel-the-turn
        // keybinding, and dismissing a menu must not kill the running turn.
        e.preventDefault();
        e.stopPropagation();
        closeMenu(focusIdx);
        return;
      }
      const pickable = rows.map((r, i) => ({ r, i })).filter(({ r }) => !r.disabled);
      if (!pickable.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const at = pickable.findIndex(({ i }) => i === menuIdx);
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next = pickable[(Math.max(0, at) + dir + pickable.length) % pickable.length];
        setMenuIdx(next.i);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const row = rows[menuIdx];
        if (row && !row.disabled && row.patch) {
          e.preventDefault();
          applyRow(row, focusIdx);
        }
      }
    },
    [rows, menuIdx, closeMenu, focusIdx, applyRow]
  );

  if (!badges.length) return null;

  const badgeClass = (b: RailDisplayBadge) =>
    [
      "cc-rbadge",
      b.tone ? `cc-rbadge-${b.tone}` : "",
      b.pinned ? "cc-rbadge-pinned" : "",
      b.pending ? "cc-rbadge-pending" : "",
      b.placeholder ? "cc-rbadge-empty" : "",
      b.auto ? "cc-rbadge-auto" : "",
      openKey === b.key ? "cc-rbadge-open" : "",
    ]
      .filter(Boolean)
      .join(" ");

  const title = (b: RailDisplayBadge) =>
    [
      b.title,
      // Spelled out on every auto badge, not just as a colour: "who chose this"
      // is the question the whole rail exists to answer, and colour alone cannot
      // answer it for a screen reader or a colour-blind user.
      b.auto ? "chosen automatically - you pinned nothing here" : null,
      b.pending ? "applies next turn" : null,
    ]
      .filter(Boolean)
      .join(" - ");

  return (
    <div className={`cc-rail cc-rail-${variant}`} ref={railRef}>
      <div
        className="cc-railscroll"
        role="toolbar"
        aria-label={label ?? "Run context"}
        aria-orientation="horizontal"
        onKeyDown={onToolbarKey}
      >
        {badges.map((b, i) => {
          const tab = i === Math.min(focusIdx, badges.length - 1) ? 0 : -1;
          const ref = (el: HTMLElement | null) => {
            itemsRef.current[i] = el;
          };
          // "next" wins over "auto" when both apply: a pending pin is about to
          // REPLACE the auto choice, so saying "auto" there would describe a state
          // the user has already left.
          const mark = b.pending ? (
            <span className="cc-rbadge-next">next</span>
          ) : b.auto ? (
            <span className="cc-rbadge-automark" aria-hidden="true">
              auto
            </span>
          ) : null;
          if (b.href) {
            return (
              <a
                key={b.key}
                ref={ref as (el: HTMLAnchorElement | null) => void}
                className={badgeClass(b)}
                href={b.href}
                target="_blank"
                rel="noopener noreferrer"
                title={title(b)}
                tabIndex={tab}
                onFocus={() => setFocusIdx(i)}
              >
                <span className="cc-rbadge-label">{b.label}</span>
              </a>
            );
          }
          if (b.action === "transcript") {
            const sessionId = str(route?.sessionId);
            const usable = Boolean(sessionId) && typeof onOpenTranscript === "function";
            return (
              <button
                key={b.key}
                ref={ref as (el: HTMLButtonElement | null) => void}
                type="button"
                className={`${badgeClass(b)} cc-rbadge-action`}
                title={usable ? title(b) : `${b.title} - no transcript viewer is wired up here`}
                aria-disabled={usable ? undefined : true}
                tabIndex={tab}
                onFocus={() => setFocusIdx(i)}
                onClick={() => usable && onOpenTranscript!(sessionId)}
              >
                <span className="cc-rbadge-label">{b.label}</span>
              </button>
            );
          }
          const canOpen = Boolean(b.field) && interactive;
          return (
            <button
              key={b.key}
              ref={ref as (el: HTMLButtonElement | null) => void}
              type="button"
              className={badgeClass(b)}
              title={title(b)}
              tabIndex={tab}
              {...(canOpen
                ? { "aria-haspopup": "menu" as const, "aria-expanded": openKey === b.key }
                : { "aria-disabled": true })}
              {...(b.pinned ? { "aria-pressed": true } : {})}
              onFocus={() => setFocusIdx(i)}
              onClick={() => canOpen && toggleMenu(b, i)}
            >
              <span className="cc-rbadge-label">{b.label}</span>
              {mark}
            </button>
          );
        })}
      </div>
      {children ? <div className="cc-railend">{children}</div> : null}
      {menu && (
        <>
          {/* The scrim only exists as the bottom sheet's outside-tap target on a
              phone; CSS hides it above 560px, where the document listener above
              already handles an outside click. */}
          <div className="cc-railscrim" onClick={() => closeMenu(focusIdx)} />
          <div className="cc-railmenu" role="menu" aria-label={menu.label} onKeyDown={onMenuKey}>
            <div className="cc-railmenu-head">{menu.label}</div>
            {menu.rows.map((row, i) =>
              row.href ? (
                <a
                  key={row.key}
                  className="cc-railitem cc-railitem-link"
                  href={row.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                >
                  <span className="cc-railitem-label">{row.label}</span>
                </a>
              ) : (
                <button
                  key={row.key}
                  type="button"
                  className={`cc-railitem${i === menuIdx ? " cc-railitem-active" : ""}`}
                  role="menuitemradio"
                  aria-checked={Boolean(row.selected)}
                  aria-disabled={row.disabled ? true : undefined}
                  autoFocus={i === 0}
                  onMouseEnter={() => !row.disabled && setMenuIdx(i)}
                  onClick={() => applyRow(row, focusIdx)}
                >
                  <span className="cc-railitem-label">{row.label}</span>
                  {row.detail && <span className="cc-railitem-detail">{row.detail}</span>}
                  {row.selected && <span className="cc-railitem-on">pinned</span>}
                </button>
              )
            )}
            {menu.freeText && (
              <div className="cc-railfree">
                <input
                  className="cc-railfree-input"
                  value={freeText}
                  placeholder={menu.freeText.placeholder}
                  aria-label={menu.freeText.label}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && freeText.trim()) {
                      e.preventDefault();
                      onPin?.({ [menu.freeText!.field]: freeText.trim() } as PinPatch);
                      closeMenu(focusIdx);
                    }
                  }}
                />
                <button
                  type="button"
                  className="cc-railfree-set"
                  disabled={!freeText.trim()}
                  onClick={() => {
                    onPin?.({ [menu.freeText!.field]: freeText.trim() } as PinPatch);
                    closeMenu(focusIdx);
                  }}
                >
                  Pin
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
