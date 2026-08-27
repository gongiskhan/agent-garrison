// The run spec, as the board speaks it (RUN-SPEC-V1).
//
// The board and the Web Channel now edit routing through the SAME console —
// `RoutingModal` from @garrison/claude-chat — because the card asked for the
// same model AND the same functionality, and a second hand-rolled form was
// exactly how `phasesOn` came to exist on the wire and on the server while no
// board control could express it.
//
// What lives here is the seam, and only the seam: the modal speaks `PinPatch`
// and `RailOptions`; a card stores `CardRouting` and reads `RouteOptionsView`.
// Both translations are pure so they can be tested without a browser.
//
// The one rule that survives from the old form: AUTOMATIC IS ABSENCE. A pin is
// in force only when it holds a real value; clearing it deletes the key rather
// than storing "" or null, because the server's own `sanitiseCardRouting` drops
// blanks and a card that round-trips through it must come back byte-equal.
import type { PinField, PinPatch, RailOptions } from "@garrison/claude-chat";
import type { CardRouting, RouteOptionsView } from "./api";

/** Every dimension a card may pin. Deliberately the SAME MEMBERSHIP as the
 *  server's `CARD_ROUTING_FIELDS` (lib/board.mjs) — a parity test pins the two
 *  sets together (order differs; only membership is load-bearing): a patch
 *  field outside it would be dropped on save without a word, so it is dropped
 *  here instead — at the seam, where the loss is visible to a test. */
export const RUN_SPEC_FIELDS: PinField[] = [
  "duty",
  "level",
  "tier",
  "target",
  "model",
  "effort",
  "account",
  "project",
  "flow",
  "phasesOff",
  "phasesOn",
];

/** The board owns a card's working directory through the card's own Project
 *  field (and `cardTurnRouting` lets `routing.project` WIN over it). Rather
 *  than ship two controls where the quieter one wins, the console is told the
 *  dimension is spoken for, and says so. */
export const PROJECT_OWNED_BY_CARD =
  "The card's own Project field decides where this runs — set it on the card, not here.";

const GATEWAY_DOWN = "The session gateway is not running — start the composition to choose a runtime.";

function level(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[0-9]+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : null;
}

function text(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return "";
}

/**
 * Apply one console patch to a card's spec.
 *
 * A `null` (or blank, or absent-valued) field CLEARS that pin — it never means
 * "pin the value null". Fields the patch does not mention are untouched, which
 * is what lets the console send sparse patches like `{ level: 2 }`.
 */
export function applyPinPatch(spec: CardRouting | null | undefined, patch: PinPatch): CardRouting {
  const next: Record<string, unknown> = { ...(spec ?? {}) };
  for (const field of RUN_SPEC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (field === "level") {
      const n = level(patch.level);
      if (n === null) delete next.level;
      else next.level = n;
      continue;
    }
    const value = text(patch[field]);
    if (value) next[field] = value;
    else delete next[field];
  }
  // A level without a duty is meaningless — the rail's own rule, and the reason
  // the console's duty rows always clear `level` alongside. Enforced here too so
  // a stored card can never carry the orphan.
  if (!text(next.duty)) delete next.level;
  return next as CardRouting;
}

/** The pins in force, in dimension order — the summary line on the host, and
 *  the count that tells an unopened console whether it holds anything. */
export function pinnedSummary(spec: CardRouting | null | undefined): { field: PinField; label: string }[] {
  if (!spec) return [];
  const out: { field: PinField; label: string }[] = [];
  const duty = text(spec.duty);
  const lvl = level(spec.level);
  if (duty) out.push({ field: "duty", label: lvl ? `${duty} L${lvl}` : duty });
  const simple: [PinField, string, (v: string) => string][] = [
    ["tier", text(spec.tier), (v) => v],
    ["target", text(spec.target), (v) => v],
    ["model", text(spec.model), (v) => v],
    ["effort", text(spec.effort), (v) => `effort ${v}`],
    ["account", text(spec.account), (v) => v],
    ["project", text(spec.project), (v) => v],
    ["flow", text(spec.flow), (v) => `flow ${v}`],
  ];
  for (const [field, value, label] of simple) if (value) out.push({ field, label: label(value) });
  const off = splitPhases(spec.phasesOff);
  if (off.length) out.push({ field: "phasesOff", label: `−${off.length} phase${off.length > 1 ? "s" : ""}` });
  const on = splitPhases(spec.phasesOn);
  if (on.length) out.push({ field: "phasesOn", label: `+${on.length} phase${on.length > 1 ? "s" : ""}` });
  return out;
}

function splitPhases(csv: string | null | undefined): string[] {
  return text(csv)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The board's routing vocabulary in the console's shape.
 *
 * `phaseCatalog` and `tierDefinitions` are NOT new server work: the board's
 * `/route-options` proxies the gateway body verbatim, so both have always
 * arrived — the board's own form simply had nowhere to put them.
 *
 * When the gateway is down (or the fetch failed) every dimension is reported
 * unavailable WITH THE REASON, so the console offers the reason instead of
 * empty menus that would read as broken.
 */
export function railOptionsFor(
  options: RouteOptionsView | null | undefined,
  optionsError?: string | null
): RailOptions {
  const down = !options || options.sources?.gateway === false;
  const reason = down
    ? GATEWAY_DOWN
    : optionsError
      ? `Could not load the routing options (${optionsError}).`
      : null;
  const unavailable: Partial<Record<PinField, string>> = { project: PROJECT_OWNED_BY_CARD };
  if (reason) for (const field of RUN_SPEC_FIELDS) if (field !== "project") unavailable[field] = reason;
  return {
    targets: options?.targets ?? [],
    duties: options?.duties ?? [],
    efforts: options?.efforts ?? [],
    accounts: options?.accounts ?? [],
    projects: [],
    tiers: options?.tiers ?? [],
    tierDefinitions: options?.tierDefinitions ?? null,
    flows: options?.flows ?? [],
    phaseCatalog: options?.phaseCatalog ?? [],
    defaultFlow: options?.defaultFlow ?? null,
    unavailable,
  };
}
