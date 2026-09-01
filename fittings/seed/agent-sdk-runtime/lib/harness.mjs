// harness.mjs — THE HARNESS (BRIEF: Agent SDK Runtime §"THE HARNESS").
//
// The Agent SDK does NOT reproduce the Claude Code harness by default: out of the
// box it ships a minimal tool-calling system prompt, does NOT load CLAUDE.md, and
// does not auto-mount skills. Running non-Anthropic models through that stripped
// harness makes every model look worse than it is and corrupts cross-model
// comparison. So the harness is EXPLICIT and per-target via `promptMode`:
//
//   full   -> systemPrompt: { type: "preset", preset: "claude_code" }
//             settingSources: ["project"]  (loads project CLAUDE.md; preset alone
//             does NOT — both are required), skills auto-mount from ./.claude/skills.
//             Used for agentic roles on third-party endpoints.
//   coding -> the full harness PLUS the user's real Claude Code profile:
//             settingSources: ["user", "project"] loads ~/.claude settings, skills
//             and hooks, so a coding turn behaves exactly like the user's own
//             Claude Code session (the ekoa sdk-host pattern). Anthropic-
//             subscription providers ONLY — the adapter downgrades it to `full`
//             for any provider with a base-URL override (see #217 below).
//   lean   -> a minimal custom system string, settingSources: [] (no CLAUDE.md, no
//             skills). Used for chat / classification / non-coding roles. Also a
//             MARGIN lever: the full claude_code prompt carries a ~14k-token floor
//             per turn (20–30k with tool schemas); lean targets stop paying it.
//
// `full` and `lean` NEVER include "user" in settingSources → the user
// ~/.claude/settings.json env block does not load, so a stray env there can't
// silently redirect the SDK's base URL (the #217 trap). `coding` accepts that
// env block BY DESIGN — but only on the Anthropic subscription path, where
// there is no base URL to redirect (the adapter enforces this).
//
// `appendSystemPrompt` is deprecated in the renamed SDK; the structured
// systemPrompt object (preset / string / preset+append) is the supported form.

export const LEAN_SYSTEM_PROMPT =
  "You are a concise assistant. Answer the question directly in one or two sentences. Do not use tools.";

// Built-in Claude Code tools. A `lean` (chat / classification) target disables
// ALL of them so a non-coding turn is a PURE chat completion: a small local model
// then just answers instead of hallucinating an agentic tool call (and the prompt
// is far smaller, so the turn is much faster). `full` (coding) keeps tools.
export const BUILTIN_TOOLS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit", "BashOutput", "KillBash", "Skill"
];

// Build the SDK harness config for a promptMode. The returned shape is asserted
// by tests, never scraped from model output.
export function buildHarness(promptMode = "full", opts = {}) {
  const mode = promptMode === "lean" ? "lean" : promptMode === "coding" ? "coding" : "full";

  if (mode === "lean") {
    const basePrompt = opts.leanPrompt ?? LEAN_SYSTEM_PROMPT;
    return {
      promptMode: "lean",
      // Lean uses a custom prompt rather than the Claude Code preset, so include
      // the composition's assembled append explicitly at this same spawn seam.
      // The adapter snapshots the resulting string before a Query is opened.
      systemPrompt: opts.append ? `${basePrompt}\n\n${opts.append}` : basePrompt,
      settingSources: [], // no CLAUDE.md, no user settings, no skills
      preset: null,
      claudeMdLoaded: false,
      skillsMounted: false,
      disallowedTools: BUILTIN_TOOLS // pure chat — no tools
    };
  }

  return {
    promptMode: mode,
    systemPrompt: opts.append
      ? { type: "preset", preset: "claude_code", append: opts.append }
      : { type: "preset", preset: "claude_code" },
    // coding = the user's real Claude Code profile (~/.claude settings, skills,
    // hooks) + project CLAUDE.md; full excludes "user" (#217).
    settingSources: mode === "coding" ? ["user", "project"] : ["project"],
    preset: "claude_code",
    claudeMdLoaded: true,
    // skills auto-load from ./.claude/skills/*/SKILL.md when project settings load.
    skillsMounted: true,
    disallowedTools: [] // coding role — tools enabled
  };
}

// ── tool inventory profiles ─────────────────────────────────────────────────
//
// The Agent SDK's `tools` option takes a POSITIVE allow-list of built-in tool
// names (`string[]`), which is the only lever that actually shrinks the tool
// schemas in the request. `disallowedTools` also removes them, but it has to
// name every tool the installed CLI happens to offer, so a CLI upgrade silently
// re-adds whatever it introduced. An allow-list cannot drift that way.
//
// Measured 2026-08-29 on a live first API call: the preset inventory is 37 tools
// and 31,238 tokens on haiku-4-5 / 41,275 on sonnet-5 - about 40% of the whole
// boot prefix. Across 33 recorded conversations and 5,829 tool calls, duties
// invoked exactly NINE distinct tools: Bash, Edit, Write, Read, Agent,
// ToolSearch, TaskOutput, AskUserQuestion (plus one unnamed). Everything else -
// Workflow (6,393 tokens on its own), DesignSync, Monitor, the Cron family, the
// worktree and plan-mode pairs, ScheduleWakeup, SendMessage, PushNotification,
// RemoteTrigger - was never called once. The profiles below are that
// measurement, not a guess; `bench/prefix-2026-08-29/tool-usage.json` is the
// evidence and re-running it is how you revise them.
export const TOOL_PROFILES = {
  // THE ONE EVERY STRETCH CARRIES. The union of the tools any duty was ever
  // measured invoking, so no duty is starved, and identical for every duty so
  // the cache prefix stays byte-stable across stretches - see the note in the
  // gateway's harness-profiles.mjs for why sharing beats narrowing by 10x.
  shared: ["Bash", "Read", "Write", "Edit", "Agent", "TaskOutput", "AskUserQuestion"],
  // Write and Read are universal: EVERY duty ends by writing its handoff file.
  code: ["Bash", "Read", "Write", "Edit", "Agent"],
  "code-web": ["Bash", "Read", "Write", "Edit", "Agent", "WebSearch", "WebFetch"],
  test: ["Bash", "Read", "Write", "Edit", "TaskOutput"],
  // A reading duty still writes - its handoff, and nothing else.
  read: ["Bash", "Read", "Write"],
  "read-ask": ["Bash", "Read", "Write", "AskUserQuestion"],
  none: [],
};

/** Resolve a profile name to the tool list the SDK should be given, or
 *  undefined for "leave the preset inventory alone". */
export function toolsForProfile(profile) {
  if (profile == null) return undefined;
  if (Array.isArray(profile)) return [...profile];
  return TOOL_PROFILES[profile] ? [...TOOL_PROFILES[profile]] : undefined;
}

// Coding / agentic roles default to `full`; chat / classification / media roles
// default to `lean`. Never silently minimal-by-accident.
export const CODING_ROLES = new Set(["expert", "standard", "review"]);

export function defaultPromptModeForRole(role) {
  return CODING_ROLES.has(role) ? "full" : "lean";
}
