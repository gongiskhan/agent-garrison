"use client";

// The Muster Orchestrator panel (S5c, D11/D12): the layered orchestrator prompt.
// Two classes of section render differently:
//   - AUTHORED doctrine (routing philosophy, escalation, when-to-ask-vs-proceed,
//     identity hand-off) - an editable, autosaving textarea each. A debounced
//     write persists ONE section to the composition's authored overrides.
//   - GENERATED + LOCKED blocks (capabilities, duties-and-levels, readiness) -
//     greyed, non-editable, badged "regenerated from composition". They re-derive
//     from the resolved model on every load; constraint 12 means the panel never
//     offers an edit control over them and the write route refuses their ids.
// The live ASSEMBLED preview (locked + authored concatenated) sits below. When the
// composition changes the whole preview is re-fetched, so locked blocks re-derive.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { OrchestratorPreview, PromptSection } from "@/lib/orchestrator-sections";
import styles from "./Orchestrator.module.css";

type SaveState = "idle" | "saving" | "saved" | "error";
type Status = "loading" | "ready" | "error";

const SAVE_DEBOUNCE_MS = 600;

function LockGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2.5" y="5.5" width="7" height="5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export function OrchestratorPanel({ compositionId }: { compositionId: string }) {
  const [preview, setPreview] = useState<OrchestratorPreview | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Draft text per authored section - the textareas' source of truth, seeded from
  // the fetched preview and kept local so a save round-trip never jumps the caret.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Latest composition id, so an in-flight debounced save always targets the
  // composition the user is actually looking at.
  const compRef = useRef(compositionId);
  compRef.current = compositionId;

  const load = useCallback(async (id: string) => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetch(`/api/orchestrator/preview?composition=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const p = data as OrchestratorPreview;
      setPreview(p);
      // Seed drafts from the authored sections (overwrite: a fresh composition
      // brings its own authored text).
      const seeded: Record<string, string> = {};
      for (const section of p.sections) {
        if (!section.locked) seeded[section.id] = section.content;
      }
      setDrafts(seeded);
      setStatus("ready");
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  // (Re)load when the composition changes → locked blocks re-derive for it.
  useEffect(() => {
    void load(compositionId);
  }, [compositionId, load]);

  // Clear any pending debounce timers on unmount.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of Object.values(pending)) clearTimeout(t);
    };
  }, []);

  const save = useCallback(async (sectionId: string, content: string) => {
    const composition = compRef.current;
    setSaveState((s) => ({ ...s, [sectionId]: "saving" }));
    try {
      const res = await fetch("/api/orchestrator/authored", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ composition, sectionId, content })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Only fold the response back in if the user is still on this composition,
      // and keep the local drafts (the textareas) authoritative to avoid a caret
      // jump - the response's assembled prompt + locked blocks are what refresh.
      if (compRef.current === composition) {
        setPreview(data as OrchestratorPreview);
        setSaveState((s) => ({ ...s, [sectionId]: "saved" }));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSaveState((s) => ({ ...s, [sectionId]: "error" }));
    }
  }, []);

  const onEdit = useCallback(
    (sectionId: string, content: string) => {
      setDrafts((d) => ({ ...d, [sectionId]: content }));
      setSaveState((s) => ({ ...s, [sectionId]: "idle" }));
      clearTimeout(timers.current[sectionId]);
      timers.current[sectionId] = setTimeout(() => void save(sectionId, content), SAVE_DEBOUNCE_MS);
    },
    [save]
  );

  const { authored, locked } = useMemo(() => {
    const a: PromptSection[] = [];
    const l: PromptSection[] = [];
    for (const section of preview?.sections ?? []) (section.locked ? l : a).push(section);
    return { authored: a, locked: l };
  }, [preview]);

  const summary =
    status === "ready" ? `${authored.length} authored · ${locked.length} locked` : undefined;

  return (
    <section className={styles.section} data-testid="orchestrator-panel">
      <div className={styles.panelHead}>
        <span className={styles.panelLead}>
          The operative&apos;s system prompt, layered: your editable doctrine plus blocks
          regenerated from the composition, assembled below exactly as the operative receives it.
        </span>
        {summary ? <span className={styles.panelSummary}>{summary}</span> : null}
      </div>
      <>
        {status === "loading" && !preview ? (
          <div className={styles.panelSkel} data-testid="orchestrator-loading" />
        ) : status === "error" && !preview ? (
          <div className={styles.panelState} data-testid="orchestrator-error">
            Could not load the orchestrator prompt. {errorMsg}
          </div>
        ) : preview ? (
          <>
            <p className={styles.subLabel}>Doctrine · editable</p>
            <p className={styles.groupLead}>
              How the operative routes, escalates, decides when to ask, and hands off to its
              identity. This is yours to tune; it is folded into the prompt verbatim.
            </p>
            <div className={styles.authoredList}>
              {authored.map((section) => {
                const st = saveState[section.id] ?? "idle";
                return (
                  <div className={styles.authoredField} key={section.id}>
                    <div className={styles.authoredHead}>
                      <span className={styles.authoredTitle}>{section.title}</span>
                      {st !== "idle" ? (
                        <span
                          className={clsx(styles.authoredStatus, styles[st])}
                          data-testid={`orchestrator-authored-status-${section.id}`}
                        >
                          {st === "saving" ? "saving…" : st === "saved" ? "saved" : "not saved"}
                        </span>
                      ) : null}
                    </div>
                    <textarea
                      className={styles.authoredArea}
                      value={drafts[section.id] ?? ""}
                      onChange={(e) => onEdit(section.id, e.target.value)}
                      spellCheck={false}
                      aria-label={`${section.title} (editable)`}
                      data-testid={`orchestrator-authored-${section.id}`}
                    />
                  </div>
                );
              })}
            </div>

            <p className={styles.subLabel}>Generated · locked</p>
            <p className={styles.groupLead}>
              Regenerated from the composition on every load. These are not editable - change the
              duties, targets, or Fittings and they re-derive.
            </p>
            <div className={styles.lockedList}>
              {locked.map((section) => (
                <div
                  className={styles.lockedBlock}
                  key={section.id}
                  data-testid={`orchestrator-locked-${section.id}`}
                >
                  <div className={styles.lockedHead}>
                    <span className={styles.lockedTitle}>{section.title}</span>
                    <span
                      className={styles.lockedBadge}
                      data-testid={`orchestrator-locked-badge-${section.id}`}
                    >
                      <LockGlyph />
                      regenerated from composition
                    </span>
                  </div>
                  <pre className={styles.lockedBody}>{section.content}</pre>
                </div>
              ))}
            </div>

            <p className={styles.subLabel}>Assembled preview</p>
            <div className={styles.assembledWrap}>
              <div className={styles.assembledHead}>
                <span className={styles.assembledLabel}>assembled-system-prompt.md</span>
                <span className={styles.assembledMeta}>
                  {preview.assembled.length.toLocaleString()} chars
                </span>
              </div>
              <pre className={styles.assembledBody} data-testid="orchestrator-assembled">
                {preview.assembled}
              </pre>
            </div>
          </>
        ) : null}
      </>
    </section>
  );
}
