"use client";

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { QuartersDrawer } from "./QuartersDrawer";
import type { SurfaceEditorProps } from "./surfaceEditors";
import type { FilePrimitiveSurface } from "@/lib/primitive-files";

const FIELD: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "7px 10px",
  border: "1px solid var(--rule)",
  background: "white",
  fontFamily: "var(--font-mono), monospace"
};
const LABEL: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, margin: "0 0 5px" };

type ContentMode = "edit" | "preview";

// Generic create/edit form for a file primitive (skill SKILL.md, command .md,
// rule .md). Name is editable on create, fixed on edit (rename is a move — out of
// scope). Content is a markdown textarea with an edit/preview toggle. Explicit
// Save (not autosave) because it lives in a modal with a name field.
export function FilePrimitiveForm({
  surface,
  noun,
  template,
  rec,
  onClose,
  onSaved
}: SurfaceEditorProps & { surface: FilePrimitiveSurface; noun: string; template: (name: string) => string }) {
  const isEdit = !!rec;
  const [name, setName] = useState(rec ? rec.name : "");
  const [content, setContent] = useState(isEdit ? "" : template(""));
  const [mode, setMode] = useState<ContentMode>("edit");
  const [loading, setLoading] = useState(isEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track whether the user has typed in the body yet, so retitling on create can
  // refresh the still-pristine template without clobbering real edits.
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!rec) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/quarters/primitive?id=${encodeURIComponent(rec.id)}`);
        const data = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(data?.error ?? res.statusText);
        setContent(typeof data.content === "string" ? data.content : "");
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [rec]);

  const html = useMemo(() => {
    if (mode !== "preview") return "";
    try {
      return marked.parse(content, { async: false }) as string;
    } catch {
      return "<p>(could not render markdown)</p>";
    }
  }, [content, mode]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = isEdit
      ? { action: "file.update", surface, name: rec!.name, content }
      : { action: "file.create", surface, name: name.trim(), content };
    try {
      const res = await fetch("/api/quarters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error ?? data?.code ?? res.statusText);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <QuartersDrawer
      title={isEdit ? `Edit ${noun} — ${rec!.name}` : `New ${noun}`}
      subtitle={`Written to ~/.claude/${surface === "skill" ? "skills" : surface === "command" ? "commands" : "rules"}/ — loose, hand-authored.`}
      onClose={onClose}
      testId="file-form"
      footer={
        <>
          <button type="button" className="btn small ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn small" data-testid="file-save" onClick={() => void save()} disabled={busy || loading}>
            {busy ? "Saving…" : isEdit ? "Save changes" : `Create ${noun}`}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="ld" style={{ fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          {!isEdit ? (
            <div style={{ marginBottom: 14 }}>
              <label style={LABEL}>Name</label>
              <input
                className="text"
                data-testid="file-name"
                style={FIELD}
                value={name}
                placeholder={surface === "skill" ? "my-skill" : "my-command"}
                onChange={(e) => {
                  const next = e.target.value;
                  setName(next);
                  if (!touched) setContent(template(next));
                }}
              />
            </div>
          ) : null}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
            <label style={{ ...LABEL, margin: 0 }}>{surface === "skill" ? "SKILL.md" : "Content"}</label>
            <div style={{ display: "flex", gap: 4 }} role="tablist" aria-label="Editor mode">
              {(["edit", "preview"] as ContentMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  data-testid={`file-mode-${m}`}
                  className="btn small ghost"
                  style={{ textTransform: "capitalize", fontWeight: mode === m ? 600 : 400, background: mode === m ? "var(--paper)" : "transparent" }}
                  onClick={() => setMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {mode === "edit" ? (
            <textarea
              className="text"
              data-testid="file-content"
              style={{ ...FIELD, minHeight: 300, lineHeight: 1.5 }}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setTouched(true);
              }}
            />
          ) : (
            <div
              className="markdown-body"
              data-testid="file-content-preview"
              style={{ minHeight: 300, border: "1px solid var(--rule)", background: "white", padding: "14px 18px", overflow: "auto", fontSize: 13.5, lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {error ? (
            <div className="banner alarm" data-testid="file-form-error" style={{ marginTop: 12 }}>
              <span className="glyph">!</span>
              <div><p style={{ margin: 0 }}>{error}</p></div>
            </div>
          ) : null}
        </>
      )}
    </QuartersDrawer>
  );
}
