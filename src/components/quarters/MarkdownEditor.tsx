"use client";

import { useEffect, useState } from "react";
import { useAutosave, type AutosaveStatus } from "@/hooks/useAutosave";

const STATUS_WORD: Record<AutosaveStatus, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "save failed"
};

// Reusable autosaving markdown editor — no save button. Debounced writes, flush
// on blur. Used by the Context (CLAUDE.md) and Plans surfaces.
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
  // Reload when the source changes (e.g. switching files / scopes).
  useEffect(() => {
    setText(value);
  }, [value]);

  const { status, schedule, flush } = useAutosave({ value: text, onSave });

  return (
    <div>
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
      <div style={{ marginTop: 6, fontSize: 11.5, color: status === "error" ? "var(--alarm)" : "var(--mute)" }}>
        <span data-testid="autosave-status">{STATUS_WORD[status]}</span>
      </div>
    </div>
  );
}
