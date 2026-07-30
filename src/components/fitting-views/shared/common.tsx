"use client";

import { useEffect, useRef, useState } from "react";

// Shared building blocks for the shape-aware Fitting views (skill / prompt /
// runtime / connector / manage). Every Fitting declares a view (2026-07-29
// fittings/views refit); these keep the per-shape components small.

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono"
      style={{
        fontSize: 10,
        letterSpacing: "0.17em",
        textTransform: "uppercase",
        color: "var(--brass)",
        margin: "0 0 8px"
      }}
    >
      {children}
    </div>
  );
}

export function SaveBadge({ state, error }: { state: SaveState; error?: string | null }) {
  const label =
    state === "saving"
      ? "saving…"
      : state === "saved"
        ? "saved"
        : state === "dirty"
          ? "unsaved"
          : state === "error"
            ? "save failed"
            : "";
  if (!label) return null;
  return (
    <span
      className="font-mono"
      role={state === "error" ? "alert" : "status"}
      title={state === "error" ? (error ?? undefined) : undefined}
      style={{
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color:
          state === "error" ? "var(--alarm)" : state === "saved" ? "var(--sage)" : "var(--mute)"
      }}
    >
      {label}
    </span>
  );
}

// Debounced autosave driver — the no-save-button invariant. Call `schedule`
// with the latest payload; `flushNow` forces a pending save (blur). The save
// function is kept in a ref so callers may pass a fresh closure per render.
export function useAutosave<T>(save: (value: T) => Promise<void>, delayMs = 800) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<T | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const run = async () => {
    if (pending.current === null) return;
    const value = pending.current;
    pending.current = null;
    setState("saving");
    setError(null);
    try {
      await saveRef.current(value);
      setState((s) => (pending.current !== null ? s : "saved"));
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const schedule = (value: T) => {
    pending.current = value;
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), delayMs);
  };

  const flushNow = () => {
    if (timer.current) clearTimeout(timer.current);
    void run();
  };

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      // Last-chance flush on unmount so a just-typed edit is not lost.
      void run();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, error, schedule, flushNow };
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        border: "1px dashed var(--rule-2)",
        background: "var(--surface)",
        padding: "12px 14px",
        fontSize: 12.5,
        lineHeight: 1.6,
        color: "var(--mute)",
        margin: 0
      }}
    >
      {children}
    </p>
  );
}

export const cardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--rule)",
  borderLeft: "2px solid var(--brass)",
  padding: "14px 16px"
};

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data as T;
}
