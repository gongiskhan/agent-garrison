// harness.mjs - the per-target harness for the OpenAI Agents runtime.
//
// Unlike the Claude Agent SDK, `@openai/agents` has NO "claude_code" preset: an
// Agent is just instructions + a model + tools. So the harness is EXPLICIT and
// per-target via `promptMode`, mirroring the agent-sdk runtime's full/lean split:
//
//   full  -> a software-engineering system prompt + the cwd-confined file tools
//            (read_file / write_file / list_dir) enabled. Coding / agentic roles.
//   lean  -> a minimal system string, tools DISABLED (pure chat completion). Chat /
//            classification / media roles - a small local model then answers
//            directly instead of hallucinating an agentic tool call, and the turn
//            is cheaper.
//
// The returned shape is asserted by tests, never scraped from model output.

export const LEAN_SYSTEM_PROMPT =
  "You are a concise assistant. Answer the question directly in one or two sentences. Do not call tools.";

export const FULL_SYSTEM_PROMPT =
  "You are a capable software-engineering agent operating inside a working directory. " +
  "Use the provided file tools (read_file, write_file, list_dir) to inspect and change files " +
  "relative to that directory. Work step by step and produce a self-contained result.";

// Build the harness config for a promptMode.
//   opts.leanPrompt - override the lean system string (chat roles)
//   opts.append     - extra instructions appended to the full system prompt
export function buildHarness(promptMode = "full", opts = {}) {
  const mode = promptMode === "lean" ? "lean" : "full";

  if (mode === "lean") {
    return {
      promptMode: "lean",
      instructions: opts.leanPrompt ?? LEAN_SYSTEM_PROMPT,
      toolsEnabled: false, // pure chat - no tools
      preset: null
    };
  }

  const instructions = opts.append ? `${FULL_SYSTEM_PROMPT}\n\n${opts.append}` : FULL_SYSTEM_PROMPT;
  return {
    promptMode: "full",
    instructions,
    toolsEnabled: true, // coding role - file tools enabled
    preset: "software-engineering"
  };
}

// Coding / agentic roles default to `full`; chat / classification / media roles
// default to `lean`. Never silently minimal-by-accident.
export const CODING_ROLES = new Set(["expert", "standard", "review"]);

export function defaultPromptModeForRole(role) {
  return CODING_ROLES.has(role) ? "full" : "lean";
}
