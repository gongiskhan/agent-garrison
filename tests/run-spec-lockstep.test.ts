import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The board's modules are untyped .mjs inside a fitting (tsconfig sets
// allowJs:false), so they load through pathToFileURL exactly as
// tests/kanban-gate-verdict.test.ts already does rather than as a static import.
let CARD_ROUTING_FIELDS: string[];
let sanitiseCardRouting: (raw: unknown) => Record<string, unknown> | null;
let boardPhaseToggles: (csv: unknown) => Record<string, boolean> | null;
let cardTurnRouting: (card: unknown) => Record<string, unknown> | null;

// RUN-SPEC-V1 lockstep.
//
// One run spec crosses FOUR processes: the browser (TurnRouting), the web channel's
// thread store, the kanban board's card, and the gateway's security edge. None of
// them can import the others — the fittings are separate installed packages at
// runtime and the gateway holds the only copy of the compiled policy. So each is a
// hand-maintained MIRROR, and the failure mode is silent: `sanitizeRouting` is a
// CLOSED whitelist that hard-drops an unknown key with NO rejection recorded, so a
// dimension added on one side and forgotten on another produces a pin that appears
// to be set, changes nothing, and says nothing. This file is the drift alarm —
// the same discipline tests/gateway-run-context.test.ts already applies to
// TURN_EFFORTS/dutyEfforts and tests/dispatch-lease-parity.test.ts to the lease.
//
// Source-text assertions rather than imports where a module cannot be loaded here
// (gateway-pty.mjs boots a server on import; threads.mjs is plain data).

const REPO = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const load = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);

beforeAll(async () => {
  const board = await load("fittings/seed/kanban-loop/lib/board.mjs");
  const policy = await load("fittings/seed/kanban-loop/lib/policy.mjs");
  const client = await load("fittings/seed/kanban-loop/lib/gateway-client.mjs");
  CARD_ROUTING_FIELDS = board.CARD_ROUTING_FIELDS;
  sanitiseCardRouting = board.sanitiseCardRouting;
  boardPhaseToggles = policy.phaseTogglesFromCsv;
  cardTurnRouting = client.cardTurnRouting;
});

/** The canonical dimension list. Adding one here fails every mirror that has not
 *  learned it, which is the point. */
const RUN_SPEC_FIELDS = [
  "target",
  "model",
  "effort",
  "duty",
  "level",
  "project",
  "account",
  "tier",
  "flow",
  "phasesOff",
  // 2026-08-22 (routing modal): phases ADDED beyond the resolved flow's plan.
  "phasesOn",
] as const;

describe("RUN-SPEC-V1: every whitelist knows every dimension", () => {
  it("the client type TurnRouting declares them all", () => {
    const src = read("packages/claude-chat/src/transport.ts");
    const body = src.slice(src.indexOf("export interface TurnRouting"), src.indexOf("export type ChatEvent"));
    for (const field of RUN_SPEC_FIELDS) {
      expect(body, `TurnRouting is missing ${field}`).toMatch(new RegExp(`\\b${field}\\?:`));
    }
  });

  it("the gateway's security edge validates them all", () => {
    // The edge is where a pin lives or dies: a field absent here is dropped with no
    // rejection, so the user sees a control that silently does nothing.
    const src = read("fittings/seed/http-gateway/scripts/gateway-pty.mjs");
    const body = src.slice(src.indexOf("export function sanitizeRouting"), src.indexOf("export function turnAttribution"));
    for (const field of RUN_SPEC_FIELDS) {
      expect(body, `sanitizeRouting does not handle ${field}`).toContain(field);
    }
  });

  it("the web channel persists them all, or a pin dies on reload", () => {
    // threads.mjs re-sanitises on BOTH write and read, so a field missing from
    // ROUTING_FIELDS makes a pin work for exactly one send and then vanish.
    const src = read("fittings/seed/web-channel-default/scripts/threads.mjs");
    const body = src.slice(src.indexOf("const ROUTING_FIELDS"), src.indexOf("function cleanString"));
    for (const field of RUN_SPEC_FIELDS) {
      expect(body, `ROUTING_FIELDS is missing ${field}`).toMatch(new RegExp(`\\b${field}:`));
    }
  });

  it("the kanban card stores them all", () => {
    expect([...CARD_ROUTING_FIELDS].sort()).toEqual([...RUN_SPEC_FIELDS].sort());
  });

  it("the rail can pin every one of them", () => {
    const src = read("packages/claude-chat/src/AttributionRail.tsx");
    const body = src.slice(src.indexOf("export type PinField"), src.indexOf("export type PinPatch"));
    for (const field of RUN_SPEC_FIELDS) {
      expect(body, `PinField is missing ${field}`).toContain(`"${field}"`);
    }
  });

  it("the board's phasesOff converter matches the gateway's byte for byte", () => {
    // Duplicated on purpose (cross-fitting imports break containment), so the two
    // must agree on every shape - including the empty cases, where a wrong answer
    // means a card silently stores `phases: {}` instead of null.
    const gatewaySrc = read("fittings/seed/http-gateway/scripts/gateway-pty.mjs");
    const fn = gatewaySrc.slice(gatewaySrc.indexOf("export function phaseTogglesFromCsv"));
    const gatewayImpl = fn.slice(0, fn.indexOf("\n}\n") + 2);
    const gatewayPhaseToggles = new Function(`${gatewayImpl.replace("export function", "return function")}`)() as (
      csv: unknown
    ) => Record<string, boolean> | null;
    for (const input of ["review", "review,walkthrough", " a , b ", "", null, undefined, " , ", "x,,y"]) {
      expect(boardPhaseToggles(input), JSON.stringify(input)).toEqual(gatewayPhaseToggles(input));
    }
  });
});

describe("RUN-SPEC-V1: a card's spec becomes exactly one routing pin", () => {
  it("keeps only real values, so 'absent' still means automatic", () => {
    expect(sanitiseCardRouting({ target: "cc-opus", model: "", effort: null, account: "  " })).toEqual({
      target: "cc-opus",
    });
    // Nothing pinned stores null, not {} - the two read identically and null is
    // what every card created before the run spec existed already has.
    expect(sanitiseCardRouting({})).toBe(null);
    expect(sanitiseCardRouting(null)).toBe(null);
    expect(sanitiseCardRouting("target=opus")).toBe(null);
  });

  it("refuses a level outside 1..9 and coerces a digit string from a menu", () => {
    expect(sanitiseCardRouting({ level: "3" })).toEqual({ level: 3 });
    for (const bad of [0, 10, 2.5, true, "two"]) {
      expect(sanitiseCardRouting({ level: bad }), JSON.stringify(bad)).toBe(null);
    }
  });

  it("drops a field that is not part of the spec rather than forwarding it", () => {
    expect(sanitiseCardRouting({ target: "cc-opus", runtime: "gemini", cwd: "/etc" })).toEqual({ target: "cc-opus" });
  });

  it("normalises the project to a dev-root NAME, whichever half of the card it came from", () => {
    // A real board stores `project` as both a slug and an absolute path, and the
    // gateway's resolveProjectName refuses anything containing a slash.
    expect(cardTurnRouting({ project: "/home/ggomes/dev/ekoa-code" })).toEqual({ project: "ekoa-code" });
    expect(cardTurnRouting({ project: "garrison" })).toEqual({ project: "garrison" });
    // An explicit pin BEATS the card's label: if the user chose where this runs,
    // that is the answer.
    expect(cardTurnRouting({ project: "garrison", routing: { project: "ekoa-code" } })).toEqual({ project: "ekoa-code" });
  });

  it("sends nothing at all for an unpinned card", () => {
    // Back-compat: an unpinned card's body must stay byte-identical to the shape
    // that shipped before the run spec existed.
    expect(cardTurnRouting({})).toBe(null);
    expect(cardTurnRouting({ project: "  " })).toBe(null);
    expect(cardTurnRouting(null)).toBe(null);
  });

  it("carries the whole spec through as one routing object", () => {
    expect(
      cardTurnRouting({
        project: "garrison",
        routing: { target: "cc-opus-high", effort: "high", tier: "T2-deep", flow: "ui-change", phasesOff: "walkthrough" },
      })
    ).toEqual({
      target: "cc-opus-high",
      effort: "high",
      tier: "T2-deep",
      flow: "ui-change",
      phasesOff: "walkthrough",
      project: "garrison",
    });
  });
});
