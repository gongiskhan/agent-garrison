// harness-profiles.mjs — what a duty is allowed to carry into its stretch.
//
// A stretch pays for its whole boot prefix on its first API call, every time,
// because each stretch is a fresh runtime session. Measured on a live
// conversation (2026-08-29, `bench/prefix-2026-08-29/`):
//
//   triage / haiku-4-5     77,571 billed prefix tokens
//   implement / sonnet-5  105,188
//
// decomposing (count_tokens against the literal captured request) into roughly
// 40% tool schemas, 43% the composition's assembled prompt, 8% the claude_code
// preset, 8% injected system-reminders plus the brief. The brief itself - the
// thing that looks expensive - is under 1,500 tokens.
//
// This module owns the first of those: which tools a duty actually needs. The
// list per profile lives in the runtime fitting's harness.mjs beside the
// evidence; the duty -> profile mapping lives here because the gateway is what
// knows about duties.
//
// The mapping is deliberately generous where a duty has thin evidence: a duty
// that has barely run gets the profile its DESCRIPTION implies, not an empty
// one, and an unknown duty falls back to the full coding profile. Starving a
// duty of a tool it needs is a worse failure than paying for a schema.

import { TOOL_PROFILES, toolsForProfile } from "../../../agent-sdk-runtime/lib/harness.mjs";

// duty -> profile name. Anything absent gets DEFAULT_PROFILE.
//
// SHARED BY DEFAULT, and that is a deliberate reversal. Narrowing the inventory
// per duty is the obvious way to shrink the tool block, and it works: `read`
// costs 4,357 tokens against `code`'s 6,937. But the cache prefix hashes
// tools -> system -> messages, so a tools block that differs per duty forks the
// prefix and no stretch can ever read another stretch's cache. Measured on run
// B: implement booted at 43,276 tokens and test at 41,352 - close, and
// therefore two separate cache writes rather than one write and one read.
//
// The arithmetic is not close. Four sonnet stretches writing a 43k prefix each
// at the 5-minute rate cost 4 x 43,000 x $2.50/1e6 = $0.43. One 1-hour write
// plus three reads costs $0.172 + 3 x $0.0086 = $0.198. Sharing saves ~$0.23;
// the widest per-duty narrowing saves ~1,900 tokens a stretch, about $0.02.
//
// So every duty gets the same block: the union of what any duty has ever
// actually invoked. The per-duty machinery below stays because tool search
// makes narrowing free again - the block collapses to the search tool plus
// three or four hot tools and is identical everywhere by construction.
export const DUTY_TOOL_PROFILES = {};

// The per-duty sets that WOULD apply if the prefix did not have to be
// byte-stable. Kept as the measured record and as the shape to return to once
// deferred loading lands; nothing reads them while SHARED_PROFILE is in force.
export const NARROW_DUTY_TOOL_PROFILES = {
  implement: "code",
  plan: "code",
  ops: "code",
  drill: "code",
  "ux-qa": "code",
  walkthrough: "code",
  writing: "code",
  image: "code",
  video: "code",
  other: "code",
  research: "code-web",
  discuss: "code-web",
  test: "test",
  review: "read",
  "adversarial-review": "read",
  "adversarial-test": "code",
  "security-review": "read",
  "codex-checkpoint": "read",
  validate: "read",
  report: "read",
  "probe-question": "read",
  triage: "read-ask",
  responder: "read-ask",
};

// The one block every agent-sdk stretch carries: the union of the nine tools
// any duty was ever measured invoking, minus ToolSearch (a deferral mechanism,
// absent when the inventory is explicit) and minus the unnamed one.
export const SHARED_PROFILE = "shared";

export const DEFAULT_PROFILE = SHARED_PROFILE;

// Which MCP tools a duty carries. Measured: across 33 recorded conversations NO
// stretch of any duty ever called one of the nine legacy garrison tools, and
// their schemas cost 2,268 tokens on haiku / 2,744 on sonnet in EVERY stretch's
// boot prefix. So the default is none, and a duty names what it actually needs.
//
// `garrison_capability_doc` is what makes the trimmed capability catalogue
// honest: the prompt carries a one-line index and this fetches the provider's
// full guidance for the one capability a stretch is about to use.
const CAPABILITY_DOC = "garrison_capability_doc";
// Layer 3: search the conversation's full record, fetch a record or the
// tool-result-free digest. Every call is recorded as a `layer3-access` ledger
// event so "did any stretch ever look?" stops being unanswerable.
const LAYER3 = ["garrison_conversation_search", "garrison_conversation_fetch"];

// One MCP set for every duty, for exactly the reason the tool profile is
// shared: these schemas live in the tools block, and a block that varies per
// duty forks the cache prefix. Three schemas, ~1,700 tokens, against a ~43k
// prefix that six stretches would otherwise each rewrite.
export const SHARED_MCP_TOOLS = [CAPABILITY_DOC, ...LAYER3];

export const DUTY_MCP_TOOLS = {};

export function toolProfileForDuty(duty) {
  return DUTY_TOOL_PROFILES[duty] ?? DEFAULT_PROFILE;
}

/** What a duty WOULD carry if the prefix did not have to be byte-stable.
 *  Reporting and tests only. */
export function narrowToolProfileForDuty(duty) {
  return NARROW_DUTY_TOOL_PROFILES[duty] ?? "code";
}

/**
 * Fold a duty's harness profile onto a resolved route's target, in place of the
 * preset "every tool the CLI has" inventory.
 *
 * A target that already names `tools` in the manifest wins: an operator who
 * pinned an inventory meant it. Non-agent-sdk runtimes are untouched - the tool
 * inventory is an Agent SDK concept and a codex/cursor target has its own.
 */
export function applyDutyHarnessProfile(route, duty, opts = {}) {
  if (!route?.target || route.target.runtime !== "agent-sdk") return route;
  if (route.target.tools !== undefined) return route;
  // A lean target is already tool-free; narrowing it would be a no-op that
  // only makes the assembly harder to read.
  if (route.target.promptMode === "lean") return route;
  const profile = opts.profile ?? toolProfileForDuty(duty);
  const tools = toolsForProfile(profile);
  if (!tools) return route;
  const mcpTools = opts.mcpTools ?? DUTY_MCP_TOOLS[duty] ?? SHARED_MCP_TOOLS;
  route.target = {
    ...route.target,
    tools,
    toolProfile: profile,
    // `null` is the explicit "no MCP servers for this stretch" signal the
    // assembly resolver understands; undefined would mean "unspecified".
    ...(mcpTools && mcpTools.length ? { mcpTools: [...mcpTools] } : { mcpServers: null }),
  };
  return route;
}

export { TOOL_PROFILES };
