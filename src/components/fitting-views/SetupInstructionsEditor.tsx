"use client";

import { useRef, useState } from "react";
import type { SetupStep } from "@/lib/types";

type SaveStatus = "idle" | "saving" | "saved" | "error";

// The Setup Instructions editor on a promoted Fitting's detail view. An ordered,
// inline-editable list of setup steps the installer runs when the composition is
// installed — add / edit / remove / reorder. No Save button (Quarters
// convention): structural changes persist immediately, text edits debounce.
// Persists to the same field the installer reads via PUT /api/promoted-fittings.
export function SetupInstructionsEditor({
  fittingId,
  initialSteps
}: {
  fittingId: string;
  initialSteps: SetupStep[];
}) {
  const [steps, setSteps] = useState<SetupStep[]>(initialSteps);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Save coordination: `latest` always holds the newest steps to persist;
  // `dirty` flags pending work; `flushing` guards the single in-flight loop. This
  // serializes PUTs (one at a time) and always sends the LATEST state, so a
  // debounced text save can never land after — and overwrite — a newer
  // structural edit (the stale-write race a fire-and-forget fetch would have).
  const latest = useRef<SetupStep[]>(initialSteps);
  const dirty = useRef(false);
  const flushing = useRef(false);

  async function flush() {
    if (flushing.current) return;
    flushing.current = true;
    let errored = false;
    while (dirty.current) {
      dirty.current = false;
      // Drop half-typed empty-command steps from the payload (the API rejects
      // them); they stay in the editor for the user to finish.
      const payload = latest.current
        .map((s) => ({ ...s, command: s.command.trim(), label: s.label?.trim() || undefined }))
        .filter((s) => s.command.length > 0);
      try {
        const res = await fetch("/api/promoted-fittings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: fittingId, setup: payload })
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) throw new Error(data.error ?? "save failed");
      } catch {
        errored = true;
      }
    }
    flushing.current = false;
    setStatus(errored ? "error" : "saved");
  }

  function commit(next: SetupStep[], debounce: boolean) {
    setSteps(next);
    setStatus("saving");
    latest.current = next;
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (debounce) {
      saveTimer.current = setTimeout(() => void flush(), 600);
    } else {
      void flush();
    }
  }

  function updateStep(i: number, patch: Partial<SetupStep>) {
    commit(
      steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
      true
    );
  }
  function addStep() {
    commit([...steps, { command: "", idempotent: true }], false);
  }
  function removeStep(i: number) {
    commit(steps.filter((_, idx) => idx !== i), false);
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next, false);
  }

  return (
    <section
      data-testid="setup-instructions"
      style={{
        marginTop: 34,
        borderTop: "1px solid var(--rule-2)",
        paddingTop: 24
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div className="font-mono" style={{ fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--brass)", marginBottom: 4 }}>
            Installation sequence
          </div>
          <h2 className="font-display" style={{ fontSize: 22, lineHeight: 1.15, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>
            Setup instructions
          </h2>
          <p style={{ maxWidth: 620, fontSize: 13, color: "var(--mute)", margin: "7px 0 0", lineHeight: 1.6 }}>
            One-time steps run, in order, when this Fitting is installed. They are saved automatically.
          </p>
        </div>
        <span
          data-testid="setup-save-status"
          className="font-mono"
          role="status"
          aria-live="polite"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            border: status === "idle" ? "1px solid transparent" : "1px solid var(--rule)",
            background: status === "idle" ? "transparent" : "var(--surface)",
            padding: status === "idle" ? "4px 0" : "4px 7px",
            color:
              status === "error" ? "var(--alarm)" : status === "saved" ? "var(--sage)" : "var(--mute)"
          }}
        >
          {status === "saving" ? "saving…" : status === "saved" ? "saved" : status === "error" ? "save failed" : ""}
        </span>
      </div>

      <ol style={{ listStyle: "none", margin: "18px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {steps.length === 0 ? (
          <li
            data-testid="setup-empty"
            style={{
              fontSize: 13,
              lineHeight: 1.65,
              color: "var(--mute)",
              border: "1px dashed var(--rule-2)",
              borderLeft: "3px solid var(--brass)",
              background: "var(--surface)",
              padding: "16px 18px"
            }}
          >
            <b style={{ color: "var(--ink)" }}>Ready without setup.</b>{" "}
            This Fitting works as soon as it&apos;s installed. Add a step if it has a one-time dependency.
          </li>
        ) : (
          steps.map((step, i) => (
            <li
              key={i}
              data-testid={`setup-step-${i}`}
              style={{
                border: "1px solid var(--rule)",
                borderTop: "2px solid var(--brass)",
                background: "var(--surface)",
                padding: "14px 15px"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 9, marginBottom: 10 }}>
                <span
                  className="font-mono"
                  style={{
                    display: "grid",
                    placeItems: "center",
                    fontSize: 10,
                    color: "var(--paper)",
                    background: "var(--ink)",
                    width: 28,
                    height: 28,
                    fontWeight: 600,
                    letterSpacing: "0.08em"
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <input
                  type="text"
                  data-testid={`setup-step-label-${i}`}
                  value={step.label ?? ""}
                  placeholder="Step name (optional) — e.g. Install the browser"
                  onChange={(e) => updateStep(i, { label: e.target.value })}
                  className="min-w-[180px] rounded-[3px] transition hover:bg-[var(--paper-2)] focus:bg-[var(--paper)]"
                  style={{
                    flex: 1,
                    border: "none",
                    borderBottom: "1px solid var(--rule)",
                    fontFamily: "inherit",
                    fontSize: 13.5,
                    fontWeight: 600,
                    background: "transparent",
                    color: "var(--ink)",
                    padding: "5px 7px"
                  }}
                />
                <div style={{ display: "flex", gap: 5, marginLeft: "auto" }}>
                  <StepButton
                    testid={`setup-step-up-${i}`}
                    label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </StepButton>
                  <StepButton
                    testid={`setup-step-down-${i}`}
                    label="Move down"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </StepButton>
                  <StepButton testid={`setup-step-remove-${i}`} label="Remove step" onClick={() => removeStep(i)}>
                    ✕
                  </StepButton>
                </div>
              </div>
              <input
                type="text"
                data-testid={`setup-step-command-${i}`}
                value={step.command}
                placeholder="Command to run — e.g. npm i -g playwright"
                onChange={(e) => updateStep(i, { command: e.target.value })}
                className="rounded-[4px] transition hover:border-[var(--rule-2)] focus:border-[var(--brass)]"
                style={{
                  width: "100%",
                  border: "1px solid var(--rule)",
                  background: "var(--surface-strong)",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 12.5,
                  color: "var(--ink)",
                  padding: "9px 10px"
                }}
              />
              <label
                className="font-mono"
                style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--mute)", marginTop: 9, cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  className="accent-[var(--sage)]"
                  data-testid={`setup-step-idempotent-${i}`}
                  checked={step.idempotent}
                  onChange={(e) => updateStep(i, { idempotent: e.target.checked })}
                />
                safe to re-run (idempotent)
              </label>
            </li>
          ))
        )}
      </ol>

      <button
        type="button"
        data-testid="setup-step-add"
        onClick={addStep}
        className="font-mono rounded-[4px] transition hover:border-[var(--brass)] hover:bg-[var(--paper-2)] active:translate-y-px active:scale-[0.99]"
        style={{
          marginTop: 14,
          border: "1px solid var(--rule)",
          background: "var(--surface)",
          color: "var(--ink)",
          fontSize: 12,
          fontWeight: 600,
          padding: "9px 13px",
          cursor: "pointer"
        }}
      >
        + Add step
      </button>
    </section>
  );
}

function StepButton({
  children,
  onClick,
  disabled,
  label,
  testid
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  testid: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-[3px] transition hover:border-[var(--brass)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)] active:translate-y-px disabled:hover:border-[var(--rule)] disabled:hover:bg-[var(--surface)]"
      style={{
        border: "1px solid var(--rule)",
        background: "var(--surface)",
        color: disabled ? "var(--rule-2)" : "var(--mute)",
        fontSize: 12,
        width: 30,
        height: 30,
        cursor: disabled ? "default" : "pointer",
        lineHeight: 1
      }}
    >
      {children}
    </button>
  );
}
