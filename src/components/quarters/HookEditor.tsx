"use client";

import { useEffect, useState } from "react";
import { QuartersDrawer } from "./QuartersDrawer";
import type { SurfaceEditorProps } from "./surfaceEditors";

const FIELD: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "7px 10px",
  border: "1px solid var(--rule)",
  background: "white",
  fontFamily: "var(--font-mono), monospace"
};
const LABEL: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, margin: "0 0 5px" };
const ROW: React.CSSProperties = { marginBottom: 14 };

// The common Claude Code hook events (datalist suggestions; the field stays free
// text since the set evolves).
const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact"
];

interface HookGroupShape {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

// "hook:SessionStart#0" -> { event, index }
function parseHookId(id: string): { event: string; index: number } {
  const rest = id.replace(/^hook:/, "");
  const hash = rest.lastIndexOf("#");
  return { event: rest.slice(0, hash), index: Number(rest.slice(hash + 1)) };
}

// Create / edit a HAND-AUTHORED (untagged) settings.json hook group. Event is
// chosen on create and fixed on edit; matcher is optional (e.g. a tool-name
// pattern for PreToolUse); command is the shell command the hook runs.
export function HookEditor({ rec, onClose, onSaved }: SurfaceEditorProps) {
  const isEdit = !!rec;
  const parsed = rec ? parseHookId(rec.id) : null;
  const [event, setEvent] = useState(parsed?.event ?? "");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutVal] = useState<string>("");
  const [loading, setLoading] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rec) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/quarters/primitive?id=${encodeURIComponent(rec.id)}`);
        const data = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(data?.error ?? res.statusText);
        const group = (data.group ?? {}) as HookGroupShape;
        setMatcher(typeof group.matcher === "string" ? group.matcher : "");
        const first = Array.isArray(group.hooks) ? group.hooks[0] : undefined;
        setCommand(first?.command ?? "");
        setTimeoutVal(first?.timeout !== undefined ? String(first.timeout) : "");
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [rec]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const t = timeout.trim() === "" ? undefined : Number(timeout);
    const body =
      isEdit && parsed
        ? { action: "hook.update", event: parsed.event, index: parsed.index, matcher, command, timeout: t }
        : { action: "hook.create", event: event.trim(), matcher, command, timeout: t };
    try {
      const res = await fetch("/api/quarters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error ?? data?.code ?? res.statusText);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <QuartersDrawer
      title={isEdit ? `Edit hook — ${parsed?.event}` : "New hook"}
      subtitle="A hand-authored hook group in ~/.claude/settings.json (untagged — not fitting-owned)."
      onClose={onClose}
      testId="hook-form"
      footer={
        <>
          <button type="button" className="btn small ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn small" data-testid="hook-save" onClick={() => void save()} disabled={busy || loading}>
            {busy ? "Saving…" : isEdit ? "Save changes" : "Create hook"}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="ld" style={{ fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <div style={ROW}>
            <label style={LABEL}>Event</label>
            <input
              className="text"
              data-testid="hook-event"
              style={{ ...FIELD, opacity: isEdit ? 0.6 : 1 }}
              value={event}
              list="hook-events"
              disabled={isEdit}
              placeholder="PreToolUse"
              onChange={(e) => setEvent(e.target.value)}
            />
            <datalist id="hook-events">
              {EVENTS.map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
          </div>

          <div style={ROW}>
            <label style={LABEL}>Matcher — optional (e.g. a tool-name pattern for PreToolUse)</label>
            <input
              className="text"
              data-testid="hook-matcher"
              style={FIELD}
              value={matcher}
              placeholder="Bash"
              onChange={(e) => setMatcher(e.target.value)}
            />
          </div>

          <div style={ROW}>
            <label style={LABEL}>Command</label>
            <textarea
              className="text"
              data-testid="hook-command"
              style={{ ...FIELD, minHeight: 90 }}
              value={command}
              placeholder="$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh"
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>

          <div style={ROW}>
            <label style={LABEL}>Timeout (seconds) — optional</label>
            <input
              className="text"
              type="number"
              data-testid="hook-timeout"
              style={FIELD}
              value={timeout}
              onChange={(e) => setTimeoutVal(e.target.value)}
            />
          </div>

          {error ? (
            <div className="banner alarm" data-testid="hook-form-error" style={{ marginTop: 4 }}>
              <span className="glyph">!</span>
              <div><p style={{ margin: 0 }}>{error}</p></div>
            </div>
          ) : null}
        </>
      )}
    </QuartersDrawer>
  );
}
