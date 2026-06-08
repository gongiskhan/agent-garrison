"use client";

import { useCallback, useEffect, useState } from "react";
import { MarkdownEditor } from "./MarkdownEditor";
import type { ClaudeMdScope, ClaudeMdView } from "@/lib/claude-md";

// Context = CLAUDE.md (user + project). Renamed from "Memory" — the word
// "Memory" is reserved for the faculty/compiler that PRODUCES this document.
// Autosave, no save button (editor is the sole writer; the compiler proposes).
export function ContextPanel() {
  const [scope, setScope] = useState<ClaudeMdScope>("user");
  const [view, setView] = useState<ClaudeMdView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: ClaudeMdScope) => {
    setView(null);
    setError(null);
    try {
      const res = await fetch(`/api/claude-md?scope=${s}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? res.statusText);
      setView(data as ClaudeMdView);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(scope);
  }, [scope, load]);

  const save = useCallback(
    async (content: string) => {
      const res = await fetch("/api/claude-md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, content })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? res.statusText);
      }
    },
    [scope]
  );

  return (
    <main>
      <div className="crumbs"><b>Quarters</b> · Context</div>
      <div className="page">
        <div className="head">
          <h1>Context</h1>
          <p className="ld">
            <code>CLAUDE.md</code> — the durable guidance the Memory faculty produces. Edits autosave.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className={`btn small ${scope === "user" ? "" : "ghost"}`}
              data-testid="scope-user"
              onClick={() => setScope("user")}
            >
              User
            </button>
            <button
              className={`btn small ${scope === "project" ? "" : "ghost"}`}
              data-testid="scope-project"
              onClick={() => setScope("project")}
            >
              Project
            </button>
          </div>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="context-error">
            <span className="glyph">!</span>
            <div><h5>Context error</h5><p>{error}</p></div>
          </div>
        ) : null}

        {view ? (
          <MarkdownEditor value={view.content} onSave={save} testId="context-editor" />
        ) : (
          <p className="ld">Loading…</p>
        )}
      </div>
    </main>
  );
}
