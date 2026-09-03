// The runtime catalog: how to start or resume each CLI agent in a pane, and
// how to probe which of them exist on a transport. `agentCommand` (the
// transport's standing default) stays the fallback path when no runtime is
// named - this catalog is additive, never a replacement for it.

import { shellQuote } from "./shell-quote.mjs";

export const RUNTIMES = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    newArgv: () => ["claude"],
    resumeArgv: (ref) => ["claude", "--resume", ref],
    attachArgv: (ref) => ["claude", "attach", ref],
    refPattern: /^[0-9a-f-]{8,64}$/i,
    resumable: true,
    attachable: true,
    statusSource: "registry"
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    newArgv: () => ["codex"],
    resumeArgv: (ref) => ["codex", "resume", ref],
    attachArgv: null,
    refPattern: /^[0-9a-f-]{8,64}$/i,
    resumable: true,
    attachable: false,
    statusSource: "hooks"
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    bin: "cursor-agent",
    newArgv: () => ["cursor-agent"],
    resumeArgv: (ref) => ["cursor-agent", "--resume", ref],
    attachArgv: null,
    refPattern: /^[A-Za-z0-9_-]{6,80}$/,
    resumable: true,
    attachable: false,
    statusSource: "hooks"
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    newArgv: () => ["gemini"],
    // A gemini resume ref is always a STRING here: "latest" or a positive
    // integer index (the lister that produces it decides which).
    resumeArgv: (ref) => ["gemini", "--resume", ref === "latest" ? "latest" : String(Number(ref))],
    attachArgv: null,
    refPattern: /^(latest|\d+)$/,
    resumable: true,
    attachable: false,
    statusSource: "hooks"
  },
  shell: {
    id: "shell",
    label: "Shell",
    bin: null,
    newArgv: () => [],
    resumeArgv: () => [],
    attachArgv: null,
    refPattern: null,
    resumable: false,
    attachable: false,
    statusSource: "none"
  }
};

/** argv -> a shell-quoted command line, for typing into a pane or recording
 *  as `resumeCommand`. */
export function commandLine(argv) {
  return argv.map(shellQuote).join(" ");
}

const BINNED_RUNTIMES = Object.values(RUNTIMES).filter((r) => r.bin);

/** The login-shell probe script: one exec finds every runtime's binary (or
 *  its absence) on a transport, rather than one exec per candidate. */
export function buildRuntimeProbeScript() {
  return BINNED_RUNTIMES.map(
    (r) => `p=$(command -v ${shellQuote(r.bin)} 2>/dev/null); printf '%s\\t%s\\n' ${shellQuote(r.id)} "\${p:-}"`
  ).join("; ");
}

/** Parse buildRuntimeProbeScript's stdout into the /runtimes response rows. */
export function parseRuntimeProbe(stdout) {
  const found = new Map();
  for (const line of String(stdout).split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    const p = line.slice(tab + 1).trim();
    if (RUNTIMES[id]) found.set(id, p);
  }
  const checkedAt = new Date().toISOString();
  return BINNED_RUNTIMES.map((r) => ({
    id: r.id,
    label: r.label,
    bin: r.bin,
    available: Boolean(found.get(r.id)),
    path: found.get(r.id) || null,
    resumable: r.resumable,
    attachable: r.attachable,
    checkedAt
  }));
}
