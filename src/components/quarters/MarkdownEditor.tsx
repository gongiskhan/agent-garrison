"use client";

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { useAutosave, type AutosaveStatus } from "@/hooks/useAutosave";

const STATUS_WORD: Record<AutosaveStatus, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "save failed"
};

type Mode = "edit" | "preview" | "split";

// Reusable autosaving markdown editor — no save button. Debounced writes, flush
// on blur. Edit / Preview / Split modes render the markdown via `marked` (the
// content is the user's own ~/.claude files in a single-user local app, so
// rendering it with dangerouslySetInnerHTML is acceptable). Used by the Context
// (CLAUDE.md) and Plans surfaces.
export function MarkdownEditor({
  value,
  onSave,
  minHeight = 420,
  testId
}: {
  value: string;
  onSave: (value: string) => Promise<void>;
  minHeight?: number;
  testId?: string;
}) {
  const [text, setText] = useState(value);
  const [mode, setMode] = useState<Mode>("edit");

  // Reload when the source changes (e.g. switching files / scopes).
  useEffect(() => {
    setText(value);
  }, [value]);

  const { status, schedule, flush } = useAutosave({ value: text, onSave });

  const html = useMemo(() => {
    if (mode === "edit") return "";
    try {
      return marked.parse(text, { async: false }) as string;
    } catch {
      return "<p>(could not render markdown)</p>";
    }
  }, [text, mode]);

  const editor = (
    <textarea
      className="text"
      data-testid={testId}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        schedule();
      }}
      onBlur={() => void flush()}
      style={{
        width: "100%",
        minHeight,
        fontFamily: "var(--font-mono), monospace",
        fontSize: 13,
        lineHeight: 1.5
      }}
    />
  );

  const preview = (
    <div
      data-testid={testId ? `${testId}-preview` : "markdown-preview"}
      className="markdown-body"
      style={{
        minHeight,
        border: "1px solid var(--rule)",
        background: "white",
        padding: "14px 18px",
        overflow: "auto",
        fontSize: 13.5,
        lineHeight: 1.6
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }} role="tablist" aria-label="Editor mode">
        {(["edit", "preview", "split"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={testId ? `${testId}-mode-${m}` : `md-mode-${m}`}
            onClick={() => setMode(m)}
            className="btn small ghost"
            style={{
              textTransform: "capitalize",
              background: mode === m ? "var(--paper)" : "transparent",
              fontWeight: mode === m ? 600 : 400
            }}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "split" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {editor}
          {preview}
        </div>
      ) : mode === "preview" ? (
        preview
      ) : (
        editor
      )}

      <div style={{ marginTop: 6, fontSize: 11.5, color: status === "error" ? "var(--alarm)" : "var(--mute)" }}>
        <span data-testid="autosave-status">{STATUS_WORD[status]}</span>
      </div>
    </div>
  );
}
