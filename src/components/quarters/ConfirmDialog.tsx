"use client";

import { useState } from "react";
import { QuartersDrawer } from "./QuartersDrawer";

// Small confirm modal reusing QuartersDrawer's shell. Used before destructive
// Quarters actions (remove an MCP server, delete a loose skill/script). Awaits an
// async onConfirm and surfaces its error inline rather than closing on failure.
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Remove",
  onConfirm,
  onClose,
  testId = "confirm-dialog"
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <QuartersDrawer
      title={title}
      onClose={onClose}
      testId={testId}
      footer={
        <>
          <button type="button" className="btn small ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn small"
            data-testid="confirm-action"
            onClick={() => void run()}
            disabled={busy}
            style={{ background: "var(--alarm)", borderColor: "var(--alarm)", color: "white" }}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink)", lineHeight: 1.55 }}>{body}</p>
      {error ? (
        <p style={{ margin: "12px 0 0", color: "var(--alarm)", fontSize: 12 }} data-testid="confirm-error">
          {error}
        </p>
      ) : null}
    </QuartersDrawer>
  );
}
