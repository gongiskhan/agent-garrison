"use client";

import { useEffect, useRef, useState } from "react";
import { errStyle, monoStyle } from "./types";

// The raw-JSON textarea, extracted from the old panel. A half-typed value is
// surfaced as a parse error and excluded from the patch queue (onInvalid); it
// re-queues the moment it parses — and passes the optional structural
// validator (used for the deep-union keys like enabledPlugins). Empty text
// means "remove this key".
export function JsonEditor({
  value,
  onChange,
  onInvalid,
  testId,
  validate,
  minHeight = 64,
  placeholder
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testId: string;
  validate?: (parsed: unknown) => string | null;
  minHeight?: number;
  placeholder?: string;
}) {
  const seed = () => (value === undefined ? "" : JSON.stringify(value, null, 2));
  const [text, setText] = useState(seed);
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(JSON.stringify(value ?? null));
  useEffect(() => {
    // Reset the draft only when the VALUE changed from outside (load, reload,
    // another editor); the editor's own emissions update last.current first.
    const incoming = JSON.stringify(value ?? null);
    if (incoming !== last.current) {
      last.current = incoming;
      setText(value === undefined ? "" : JSON.stringify(value, null, 2));
      setErr(null);
    }
  }, [value]);

  const handle = (t: string) => {
    setText(t);
    if (t.trim() === "") {
      setErr(null);
      onInvalid?.(null);
      last.current = JSON.stringify(null);
      onChange(undefined, { immediate: false });
      return;
    }
    try {
      const parsed = JSON.parse(t);
      const msg = validate?.(parsed) ?? null;
      if (msg) {
        setErr(msg);
        onInvalid?.(msg);
        return;
      }
      setErr(null);
      onInvalid?.(null);
      last.current = JSON.stringify(parsed ?? null);
      onChange(parsed, { immediate: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid JSON";
      setErr(msg);
      onInvalid?.(msg);
    }
  };

  return (
    <>
      <textarea
        className="text"
        data-testid={testId}
        style={{ ...monoStyle, width: "100%", minHeight }}
        value={text}
        placeholder={placeholder}
        onChange={(e) => handle(e.target.value)}
      />
      {err ? <p style={errStyle}>{err}</p> : null}
    </>
  );
}
