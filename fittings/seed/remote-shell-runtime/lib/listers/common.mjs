// Shared helpers for the four session listers (claude/codex/cursor/gemini).
// Kept tiny and dependency-free on purpose - each lister stays independently
// testable against its own fixture.

/** The project chip: the last path segment, or the whole string when there
 *  is no slash. Never throws on a null/empty cwd. */
export function projectName(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const trimmed = cwd.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop();
  return seg || trimmed || null;
}

// A pane a human is actively watching prints something at least this often;
// past this, "still running" is a guess this fitting should not make without
// hook evidence. Deliberately generous - session-index.mjs's hook layer is
// the precise signal, this is only the fallback for a CLI with none.
export const TRANSCRIPT_WORKING_WINDOW_MS = 20_000;

/** The honest baseline status for a session with no hook/registry signal: a
 *  transcript written to in the last TRANSCRIPT_WORKING_WINDOW_MS reads as
 *  working, anything older is unknown (never "idle" - idle implies a process
 *  that finished a turn and is waiting, which this fitting cannot see). */
export function transcriptStatus(mtimeMs, now = Date.now()) {
  if (!Number.isFinite(mtimeMs)) return { status: "unknown", statusSource: "none" };
  return now - mtimeMs <= TRANSCRIPT_WORKING_WINDOW_MS
    ? { status: "working", statusSource: "transcript" }
    : { status: "unknown", statusSource: "transcript" };
}
