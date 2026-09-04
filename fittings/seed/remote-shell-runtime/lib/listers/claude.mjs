// Claude Code sessions on this node: the live registry (~/.claude/sessions),
// past transcripts (~/.claude/projects), and `claude --bg` background agents.
// All three readers are @garrison/claude-pty's own (lifted from dev-env) -
// this module only shapes their output into Row partials.

import path from "node:path";
import { isInternalCwd, listBackgroundAgents, listHistory, readLiveRegistry } from "@garrison/claude-pty/claude-sessions.mjs";
import { claudeProjectDirForCwd } from "@garrison/claude-pty/paths.mjs";
import { projectName } from "./common.mjs";

function transcriptPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  return path.join(claudeProjectDirForCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * `backgroundAgents`: an optional pre-fetched array, for tests - unlike
 * every other read in this module, `claude agents --json` is a LIVE CLI call
 * against the real machine's running claude daemon and is not sandboxable
 * via GARRISON_CLAUDE_HOME. Pass `[]` to isolate a test from whatever
 * background agents happen to exist on the box running the suite.
 */
export function list({ windowDays = 5, backgroundAgents } = {}) {
  const rows = [];
  const live = readLiveRegistry();
  const liveIds = new Set(live.map((r) => r.sessionId));

  for (const r of live) {
    rows.push({
      id: r.sessionId,
      runtime: "claude",
      kind: "cli",
      cwd: r.cwd,
      project: projectName(r.cwd),
      title: null,
      status: r.status === "busy" ? "working" : "idle",
      statusSource: "registry",
      startedAt: Number.isFinite(r.startedAt) ? new Date(r.startedAt).toISOString() : null,
      lastActivityAt: Number.isFinite(r.updatedAt)
        ? new Date(r.updatedAt).toISOString()
        : Number.isFinite(r.startedAt) ? new Date(r.startedAt).toISOString() : null,
      resumable: true,
      attachable: false,
      resumeRef: r.sessionId,
      transcript: { format: "claude-jsonl", path: transcriptPath(r.cwd, r.sessionId) }
    });
  }

  // Past sessions not already covered by the live registry above. listHistory
  // does not filter internal cwds itself (readLiveRegistry does, via its own
  // default excludeCwd) - filter here.
  for (const h of listHistory({ windowDays, limit: 300 })) {
    if (liveIds.has(h.sessionId) || isInternalCwd(h.cwd)) continue;
    rows.push({
      id: h.sessionId,
      runtime: "claude",
      kind: "cli",
      cwd: h.cwd,
      project: projectName(h.cwd),
      title: h.title,
      // A Claude transcript with no live registry entry belongs to a process
      // that is no longer running - this is a real "ended", not a guess.
      status: "ended",
      statusSource: "registry",
      startedAt: h.startedAt,
      lastActivityAt: new Date(h.lastActivityAt).toISOString(),
      resumable: true,
      attachable: false,
      resumeRef: h.sessionId,
      transcript: h.cwd ? { format: "claude-jsonl", path: transcriptPath(h.cwd, h.sessionId) } : null
    });
  }

  for (const b of backgroundAgents ?? listBackgroundAgents()) {
    if (isInternalCwd(b.cwd)) continue;
    rows.push({
      id: b.sessionId,
      runtime: "claude",
      kind: "bg",
      cwd: b.cwd,
      project: projectName(b.cwd),
      title: b.name,
      status: b.state === "running" ? "working" : b.state === "blocked" ? "idle" : "unknown",
      statusSource: "registry",
      startedAt: Number.isFinite(b.startedAt) ? new Date(b.startedAt).toISOString() : null,
      lastActivityAt: Number.isFinite(b.startedAt) ? new Date(b.startedAt).toISOString() : null,
      // Attach, not resume: `claude attach <bg-id>` reopens the SAME running
      // process rather than starting a new one against its session id.
      resumable: false,
      attachable: true,
      resumeRef: b.id,
      transcript: { format: "claude-jsonl", path: transcriptPath(b.cwd, b.sessionId) }
    });
  }

  return rows;
}
