"use client";

import { useEffect, useState } from "react";
import { QuartersDrawer } from "./QuartersDrawer";
import type { SurfaceEditorProps } from "./surfaceEditors";

interface WorkflowDetail {
  name: string;
  sourceLabel: string;
  relPath: string;
  script: string;
  routerTarget?: {
    input?: {
      name?: string;
      scriptPath?: string;
    };
  };
}

export function WorkflowDetailDrawer({ rec, onClose }: SurfaceEditorProps) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rec) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/quarters/primitive?id=${encodeURIComponent(rec.id)}`);
        const data = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(data?.error ?? res.statusText);
        setDetail(data as WorkflowDetail);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [rec]);

  const title = rec ? `Workflow - ${rec.name}` : "Workflow";
  const target = detail?.routerTarget?.input;

  return (
    <QuartersDrawer
      title={title}
      subtitle="Read-only workflow script. Remove deletes the saved script file from its source folder."
      onClose={onClose}
      testId="workflow-detail"
      footer={
        <button type="button" className="btn small ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {error ? (
        <div className="banner alarm" data-testid="workflow-detail-error">
          <span className="glyph">!</span>
          <div><p style={{ margin: 0 }}>{error}</p></div>
        </div>
      ) : !detail ? (
        <p className="ld" style={{ fontSize: 13 }}>Loading...</p>
      ) : (
        <>
          <dl
            data-testid="workflow-target"
            style={{
              display: "grid",
              gridTemplateColumns: "90px 1fr",
              gap: "6px 12px",
              margin: "0 0 14px",
              fontSize: 12.5
            }}
          >
            <dt style={{ color: "var(--mute)" }}>Source</dt>
            <dd style={{ margin: 0 }}>{detail.sourceLabel}</dd>
            <dt style={{ color: "var(--mute)" }}>Path</dt>
            <dd style={{ margin: 0 }}><code>{detail.relPath}</code></dd>
            <dt style={{ color: "var(--mute)" }}>Target</dt>
            <dd style={{ margin: 0 }}><code>{target?.name ?? detail.name}</code></dd>
          </dl>
          <pre
            data-testid="workflow-script"
            style={{
              margin: 0,
              minHeight: 320,
              maxHeight: "52vh",
              overflow: "auto",
              border: "1px solid var(--rule)",
              background: "white",
              padding: "14px 16px",
              fontSize: 12.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap"
            }}
          >
            {detail.script}
          </pre>
        </>
      )}
    </QuartersDrawer>
  );
}
