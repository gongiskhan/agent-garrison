// The input box for an owned shell thread: types a line + Enter into the
// pane (POST /sessions/:id/input), or a named key (POST .../keys). Mobile-
// first - typing directly into xterm on a phone is miserable, this is not.

import React, { useCallback, useRef, useState } from "react";

const KEYS: Array<{ label: string; name: string }> = [
  { label: "Esc", name: "Escape" },
  { label: "Ctrl+C", name: "C-c" },
  { label: "Up", name: "Up" },
  { label: "Down", name: "Down" },
  { label: "Tab", name: "Tab" },
  { label: "Enter", name: "Enter" },
  { label: "Ctrl+D", name: "C-d" },
];

export function ShellComposer({
  onSend,
  onKeys,
  disabled = false,
  draftKey,
}: {
  onSend: (text: string) => void;
  onKeys: (keys: string) => void;
  disabled?: boolean;
  /** localStorage key for the per-thread draft, e.g. `shell-draft:<threadId>`. */
  draftKey?: string;
}) {
  const [value, setValue] = useState(() => {
    if (!draftKey) return "";
    try { return window.localStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  const [keysOpen, setKeysOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const setDraft = useCallback((v: string) => {
    setValue(v);
    if (!draftKey) return;
    try {
      if (v) window.localStorage.setItem(draftKey, v);
      else window.localStorage.removeItem(draftKey);
    } catch { /* best effort */ }
  }, [draftKey]);

  const send = useCallback(() => {
    const text = value;
    if (!text.trim() && text.indexOf("\n") < 0) return;
    onSend(text);
    setDraft("");
  }, [value, onSend, setDraft]);

  return (
    <div className="wc-wb-composer">
      {keysOpen && (
        <div className="wc-wb-keys">
          {KEYS.map((k) => (
            <button key={k.name} type="button" className="wc-wb-key" data-testid={`wb-key-${k.name.toLowerCase()}`} onClick={() => onKeys(k.name)}>
              {k.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="wc-wb-key wc-wb-keys-toggle"
        data-testid="wb-keys-toggle"
        aria-pressed={keysOpen}
        title="Control keys"
        onClick={() => setKeysOpen((v) => !v)}
      >
        ⌘
      </button>
      <textarea
        ref={taRef}
        className="wc-wb-composer-input"
        data-testid="wb-composer-input"
        rows={1}
        placeholder="Type into this shell…"
        value={value}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button type="button" className="wc-wb-composer-send" data-testid="wb-composer-send" disabled={disabled} onClick={send}>
        Send
      </button>
    </div>
  );
}
