import type { RouteAttribution } from "./transport";

// Render-time cleanup for assistant replies that were SCRAPED off the Claude Code
// TUI screen (the gateway reads the headless xterm mirror — see @garrison/claude-pty).
// Screen scraping is lossy: a reply can carry transient TUI noise that is not part
// of the assistant's prose —
//   • tool-activity progress lines: "Searching for 12 patterns, reading 2 files,
//     running 1 shell command…" (a live counter the TUI repaints each tick);
//   • thinking blocks: a "Thinking for 6s…" summary then a "⎿ …" tree line;
//   • gateway/router status badges the model is TOLD to emit and that downstream
//     scripts parse: "[route: cc-sonnet-med | rule: row:research | profile: balanced]"
//     and "[orchestrator-active]".
// The badges are LOAD-BEARING for the kanban engine + integration-check (the model
// must keep emitting them), so we never ask the model to drop them — we strip them
// from the DISPLAYED text and surface the routing as a compact chip instead. The
// noise lines are removed outright. Legit prose is never touched: every pattern is
// anchored so an ordinary sentence that merely starts with "Thinking" or contains a
// parenthetical can't match.

export interface AssistantRouteMeta {
  /** The routed target id, e.g. "cc-sonnet-med". */
  route?: string;
  /** The matched routing rule id, e.g. "row:research". */
  rule?: string;
  /** The active routing profile, e.g. "balanced". */
  profile?: string;
}

export interface SanitizedReply {
  /** The assistant prose with TUI noise + status badges removed. */
  text: string;
  /** Routing metadata lifted out of the trailing "[route: …]" badge, if present. */
  meta: AssistantRouteMeta;
  /** True when any status badge ("[route: …]" / "[orchestrator-active]") was stripped. */
  hadBadges: boolean;
}

// "[route: <target> | rule: <id> | profile: <name>]" — the model-router status badge.
// Capture the three fields; rule/profile are optional so a partial badge still parses.
const ROUTE_RE =
  /\[route:\s*([^|\]]+?)\s*(?:\|\s*rule:\s*([^|\]]+?)\s*)?(?:\|\s*profile:\s*([^\]]+?)\s*)?\]/i;
const ROUTE_RE_G = new RegExp(ROUTE_RE.source, "gi");
const ORCH_RE_G = /\[orchestrator-active\]/gi;

// Spinner glyphs the TUI cycles through on a working/thinking line.
const GLYPH = "[✻✶✷✵✳✲✴✦✧❋❉∗*·•✽✢✜✛]";

// A thinking SUMMARY line: just the word, optionally "for <N>s", optionally an
// ellipsis — e.g. "Thinking…", "Thinking for 6s…", "✻ Thought for 2s". Anchored to
// the WHOLE line so prose like "Thinking about it more, we should…" never matches.
const THINKING_SUMMARY_RE = new RegExp(
  `^\\s*(?:${GLYPH}\\s*)?(?:thinking|thought)(?:\\s+for\\s+\\d+(?:\\.\\d+)?s)?\\s*(?:…|\\.\\.\\.)?\\s*$`,
  "i"
);

// A thinking / tool-result tree continuation line: "⎿  <text>" (and the ASCII/box
// variants the terminal may render). These are never assistant prose.
const TREE_MARKER_RE = /^\s*[⎿└╰┗├]\s?/;

// One clause of a tool-activity progress line. The TUI joins these with commas and
// ends the line with "…": "Thinking for 27s, searching for 16 patterns, reading 2
// files, listing 2 directories, running 1 shell command…". Each clause is a verb +
// a count + a noun (or "thinking for <N>s"), so a clause can't be ordinary prose.
const ACTIVITY_CLAUSE_RE =
  /^(?:thinking for \d+(?:\.\d+)?s|searching for \d+ patterns?|reading \d+ files?|running \d+ (?:shell )?commands?|writing \d+ files?|wrote \d+ files?|editing \d+ files?|edited \d+ files?|fetching \d+ \w+|listing \d+ \w+|creating \d+ \w+)$/i;

/** A tool-activity progress line: ends in "…" and every comma-segment is an activity
 *  clause. Tight enough that prose ending in "…" (with no activity clauses) is kept. */
function isActivityLine(trimmed: string): boolean {
  if (!trimmed.endsWith("…") && !trimmed.endsWith("...")) return false;
  const body = trimmed.replace(/(?:…|\.\.\.)\s*$/, "");
  const segs = body.split(",").map((s) => s.trim()).filter(Boolean);
  return segs.length > 0 && segs.every((s) => ACTIVITY_CLAUSE_RE.test(s));
}

/** True for a single line that is TUI noise rather than assistant prose. Blank lines
 *  are NOT noise (they hold paragraph structure) — they're collapsed later. */
function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (THINKING_SUMMARY_RE.test(t)) return true;
  if (TREE_MARKER_RE.test(t)) return true;
  if (isActivityLine(t)) return true;
  return false;
}

/**
 * Strip scraped TUI noise + status badges from an assistant reply, lifting the
 * routing badge into structured `meta`. Pure + deterministic so it can run on every
 * render and be unit-tested. Empty/blank input round-trips to an empty result.
 */
export function sanitizeAssistantText(raw: string | null | undefined): SanitizedReply {
  const input = typeof raw === "string" ? raw : "";
  const meta: AssistantRouteMeta = {};
  const routeMatch = ROUTE_RE.exec(input);
  if (routeMatch) {
    if (routeMatch[1]?.trim()) meta.route = routeMatch[1].trim();
    if (routeMatch[2]?.trim()) meta.rule = routeMatch[2].trim();
    if (routeMatch[3]?.trim()) meta.profile = routeMatch[3].trim();
  }
  const hadBadges = routeMatch != null || /\[orchestrator-active\]/i.test(input);

  const withoutBadges = input.replace(ROUTE_RE_G, " ").replace(ORCH_RE_G, " ");
  const kept = withoutBadges.split("\n").filter((l) => !isNoiseLine(l));
  const text = kept
    .join("\n")
    .replace(/[ \t]+\n/g, "\n") // trailing whitespace a stripped badge left behind
    .replace(/\n{3,}/g, "\n\n") // collapse the gaps stripped noise lines left
    .trim();

  return { text, meta, hadBadges };
}

/** A short, human label for the routing chip, e.g. "cc-sonnet-med" → "Sonnet".
 *  Falls back to the raw target id when the shape isn't recognised. */
export function routeChipLabel(meta: AssistantRouteMeta): string | null {
  const route = meta.route;
  if (!route) return null;
  const m = /(opus|sonnet|haiku|gpt|codex|gemini)/i.exec(route);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return route;
}

/**
 * Build the enriched routing-chip label + tooltip from the STRUCTURED per-turn
 * attribution the gateway sends on a settled turn (RouteAttribution), which
 * carries the actual runtime/model/tier rather than depending on the model
 * emitting the "[route: …]" text badge. Returns null when there is nothing worth
 * showing, so the caller can fall back to the text-badge-derived meta chip.
 *
 * Label: "<runtime>/<model> · <tier> · <effort status>", dropping missing parts —
 *   "agent-sdk/claude-haiku-4-5 · T0-trivial · low effort",
 *   "claude-code/opus" (no tier/effort), or the friendly model-family label
 *   (routeChipLabel) when neither runtime nor model is known but a target id is.
 * Title: "target <route> · rule <ruleId> · profile <profile>", plus
 *   "honored: yes/no" when the router reported it.
 */
export function routeChipFromAttribution(
  route: RouteAttribution
): { label: string; title?: string } | null {
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const idParts = [s(route.runtime), s(route.model)].filter(Boolean);
  let label = idParts.join("/");
  if (!label) label = routeChipLabel({ route: s(route.route) || undefined }) ?? "";
  const tier = s(route.tier);
  if (label && tier) label = `${label} · ${tier}`;
  const effort = s(route.effort);
  if (label && effort) {
    const effortLabel =
      route.effortApplied === true
        ? `${effort} effort`
        : route.effortApplied === false
          ? `${effort} effort not applied`
          : `${effort} effort unverified`;
    label = `${label} · ${effortLabel}`;
  }
  if (!label) return null;

  const titleParts: string[] = [];
  if (s(route.route)) titleParts.push(`target ${s(route.route)}`);
  if (s(route.ruleId)) titleParts.push(`rule ${s(route.ruleId)}`);
  if (s(route.profile)) titleParts.push(`profile ${s(route.profile)}`);
  if (effort) {
    const state = route.effortApplied === true ? "applied" : route.effortApplied === false ? "not applied" : "application unknown";
    titleParts.push(`effort ${effort}: ${state}`);
  }
  if (typeof route.honored === "boolean") titleParts.push(`honored: ${route.honored ? "yes" : "no"}`);
  const title = titleParts.join(" · ");
  return { label, title: title || undefined };
}
