"use client";

// A Muster section header that collapses to a one-line summary (S5c). Applies the
// Quarters collapse rule: a header button toggles the body, and at narrow width
// the section starts COLLAPSED (the summary alone) so the mobile page is a scan of
// section headers rather than a long scroll. Initial render matches SSR (open) and
// the narrow-default is applied after mount to avoid a hydration mismatch; a user
// toggle sticks thereafter.

import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import styles from "./Orchestrator.module.css";

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={clsx(styles.collapseCaret, open && styles.open)}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M4 2.5L8 6l-4 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CollapsibleSection({
  label,
  summary,
  children,
  testId
}: {
  label: string;
  summary?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(true);
  const touched = useRef(false);

  useEffect(() => {
    // Collapse by default on a narrow viewport (unless the user has toggled). A
    // resize across the breakpoint re-applies the default so the section tracks
    // the layout, never fighting an explicit toggle.
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => {
      if (!touched.current) setOpen(!mq.matches);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <div data-testid={testId}>
      <button
        type="button"
        className={styles.collapseHead}
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <Caret open={open} />
        <span className={styles.collapseLabel}>{label}</span>
        {summary != null ? <span className={styles.collapseSummary}>{summary}</span> : null}
      </button>
      {open ? (
        <div className={styles.collapseBody} data-testid={testId ? `${testId}-body` : undefined}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
