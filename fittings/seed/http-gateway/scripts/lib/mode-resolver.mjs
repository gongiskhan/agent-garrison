// Mode resolution for the gateway's orchestrator/soul mode: which face
// (Gary/Joe/James) handles an inbound turn.
//
// Rules (from BRIEF-garrison-modes-fitting): a mode NAME at the start of a
// message is an explicit, sticky switch ("Joe, fix the build" → joe). No name
// keeps the current mode — sticky, never re-inferred mid-session. At session
// start (no current mode) with no name, the channel default applies (dev-env →
// joe, slack → gary). Auto-inference is shy and is NOT performed mid-session here
// (a name is required to switch), honoring "sticky rather than twitchy".
import { promises as fs } from "node:fs";
import path from "node:path";

// Match a leading mode name: optional greeting, then the name at the very start,
// terminated by end-of-string or punctuation/whitespace (so "Gary's" and
// "Garyfication" do NOT match, but "Gary," / "Gary " / "Gary" do).
export function parseLeadingMode(message, names) {
  if (!message || !Array.isArray(names)) return null;
  let s = String(message).replace(/^\s+/, "");
  s = s.replace(/^(?:hey|hi|ok|okay|yo)\s+/i, "");
  const lower = s.toLowerCase();
  for (const name of names) {
    const n = String(name).toLowerCase();
    if (!lower.startsWith(n)) continue;
    const rest = lower.slice(n.length);
    if (rest === "" || /^[\s,:.!?]/.test(rest)) return name;
  }
  return null;
}

// Resolve the mode for a turn. Returns { mode, trigger, switched, priorMode }.
// trigger ∈ explicit_name | sticky | channel_default (auto_inferred / correction
// are reserved for a later shy-inference pass and never produced here).
export function resolveMode({
  message,
  channel = "main",
  currentMode = null,
  channelDefaults = {},
  defaultMode = "gary",
  names = []
}) {
  const named = parseLeadingMode(message, names);
  if (named) {
    return {
      mode: named,
      trigger: "explicit_name",
      switched: named !== currentMode,
      priorMode: currentMode
    };
  }
  if (currentMode) {
    return { mode: currentMode, trigger: "sticky", switched: false, priorMode: currentMode };
  }
  const fromChannel = channelDefaults[channel];
  const mode = names.includes(fromChannel) ? fromChannel : defaultMode;
  return { mode, trigger: "channel_default", switched: true, priorMode: null };
}

// Build one structured switch-log record. Fields per the brief: timestamp,
// channel, prior_mode, chosen_mode, trigger, corrected_from (only on a
// correction), and a short signals snapshot.
export function buildSwitchEntry({ channel = "main", priorMode = null, mode, trigger, nowIso, signals = {} }) {
  return {
    timestamp: nowIso,
    channel,
    prior_mode: priorMode ?? null,
    chosen_mode: mode,
    trigger,
    corrected_from: trigger === "correction" ? signals.correctedFrom ?? null : null,
    signals
  };
}

// Append a switch entry to the append-only JSONL switch-log (one line per switch).
export async function appendSwitchLog(filePath, entry) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}
