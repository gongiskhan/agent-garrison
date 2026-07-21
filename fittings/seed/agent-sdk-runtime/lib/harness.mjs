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
    return {
      promptMode: "lean",
      systemPrompt: opts.leanPrompt ?? LEAN_SYSTEM_PROMPT,
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

// Coding / agentic roles default to `full`; chat / classification / media roles
// default to `lean`. Never silently minimal-by-accident.
export const CODING_ROLES = new Set(["expert", "standard", "review"]);

export function defaultPromptModeForRole(role) {
  return CODING_ROLES.has(role) ? "full" : "lean";
}
