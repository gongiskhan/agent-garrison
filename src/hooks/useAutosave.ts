"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Debounced autosave for the no-save-button surfaces. The editor updates its
// controlled value and calls schedule() on each user edit; the hook flushes
// after `delay` of quiet, and on blur / unmount (so an in-flight edit is never
// lost on navigation). Programmatic value changes (e.g. loading a file) do NOT
// schedule — only the caller's schedule() does.

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave<T>({
  value,
  onSave,
  delay = 600
}: {
  value: T;
  onSave: (value: T) => Promise<void>;
  delay?: number;
}): { status: AutosaveStatus; schedule: () => void; flush: () => Promise<void> } {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const latest = useRef(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = value;

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setStatus("saving");
    try {
      await onSave(latest.current);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [onSave]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  }, [flush, delay]);

  // Flush any pending edit on unmount.
  useEffect(() => () => void flush(), [flush]);

  return { status, schedule, flush };
}
