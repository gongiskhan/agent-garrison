"use client";

// Spinner — the in-progress indicator for waits Garrison cannot shorten: a host
// PTY starting, a browser authorization, a provider probe. SVG (never an emoji
// or a text glyph, which render inconsistently and jitter the line box), tinted
// with currentColor so it inherits whatever tone the surrounding row uses.

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="spin"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
      <path
        d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A one-line "working on it" row: spinner + label, used inline in forms. */
export function BusyLine({ label, testId }: { label: string; testId?: string }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)" }}
      role="status"
      aria-live="polite"
      data-testid={testId}
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
