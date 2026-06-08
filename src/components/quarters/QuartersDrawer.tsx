"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

// Reusable modal panel for the Quarters CRUD editors. Built on the shell's
// existing `.scrim` overlay (grid-centered) so it inherits the visual language —
// no new design idiom. Esc and scrim-click close; the panel itself stops
// propagation. Footer is an optional actions row.
export function QuartersDrawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testId
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" data-testid={testId} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--paper)",
          border: "1px solid var(--rule)",
          width: "min(620px, calc(100vw - 48px))",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 18px 50px rgba(24,33,28,0.22)"
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "16px 20px",
            borderBottom: "1px solid var(--rule)",
            background: "white"
          }}
        >
          <div style={{ flex: 1 }}>
            <h2 className="font-display" style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{title}</h2>
            {subtitle ? (
              <p style={{ margin: "3px 0 0", color: "var(--mute)", fontSize: 12 }}>{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn small ghost"
            aria-label="Close"
            data-testid="drawer-close"
            onClick={onClose}
            style={{ display: "grid", placeItems: "center", padding: 6 }}
          >
            <X size={15} aria-hidden />
          </button>
        </div>

        <div style={{ padding: "18px 20px", overflow: "auto", flex: 1 }}>{children}</div>

        {footer ? (
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "flex-end",
              padding: "14px 20px",
              borderTop: "1px solid var(--rule)",
              background: "white"
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
