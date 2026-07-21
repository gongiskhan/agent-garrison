"use client";

// Generic-tier Quarters panels (GARRISON-RUNTIMES-V1 P5/D5): rendered purely
// from a runtime Fitting's Quarters descriptor — Monaco raw editors over the
// DECLARED native files (json/toml validated server-side, sha-guarded,
// autosaved per the no-Save-buttons rule), context files with ownership
// awareness (Garrison-projected files render a provenance banner and stay
// read-only), and a bounded log tail over the declared roots. The claude-code
// deep surface never routes here.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeFileView, RuntimeLogEntry } from "@/lib/quarters-runtimes";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

function monacoLanguage(format?: string, path?: string) {
  if (format === "json") return "json";
  if (format === "toml") return "ini"; // closest built-in highlighting for TOML
  if (path?.endsWith(".md")) return "markdown";
  return "plaintext";
}

export function RuntimeFileEditor({
  rid,
  declaredPath,
  readOnlyWhenProjected = true
}: {
  rid: string;
  declaredPath: string;
  readOnlyWhenProjected?: boolean;
}) {
  const [view, setView] = useState<RuntimeFileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const shaRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/file?path=${encodeURIComponent(declaredPath)}`);
    const j = await r.json();
    if (!r.ok) {
      setError(j.error ?? "failed to load");
      return;
    }
    shaRef.current = j.sha;
    setView(j);
    setError(null);
  }, [rid, declaredPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (content: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setState("saving");
      timerRef.current = setTimeout(async () => {
        // Serialize PUTs (review minor): a save fired while one is in flight
        // queues the LATEST content and replays it after — the sha chain stays
        // linear, so the guard never rejects our own racing write.
        if (savingRef.current) {
          pendingRef.current = content;
          return;
        }
        savingRef.current = true;
        const r = await fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/file`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: declaredPath, content, baselineSha: shaRef.current })
        });
        const j = await r.json();
        savingRef.current = false;
        if (!r.ok) {
          // invalid format or stale sha — surfaced, edit kept in the editor
          setError(j.error ?? "save rejected");
          setState("idle");
          return;
        }
        shaRef.current = j.sha;
        setError(null);
        setState("saved");
        if (pendingRef.current !== null) {
          const queued = pendingRef.current;
          pendingRef.current = null;
          save(queued);
        }
      }, 800);
    },
    [rid, declaredPath]
  );

  if (!view) return <div className="quarters-note">{error ?? "loading…"}</div>;

  const projectedReadOnly = view.projected && readOnlyWhenProjected;
  return (
    <div className="runtime-file-editor">
      <div className="runtime-file-head">
        <span className="runtime-file-path">{view.path}</span>
        {view.format ? <span className="runtime-file-format">{view.format}</span> : null}
        <span className="runtime-file-state">{state === "saving" ? "saving…" : state === "saved" ? "saved" : ""}</span>
      </div>
      {!view.exists ? (
        <div className="banner warn">
          This file does not exist yet — the {rid} engine creates it on first run. Saving here will create it.
        </div>
      ) : null}
      {view.projected ? (
        <div className="banner warn">
          Garrison-managed projection — written by the Orchestrator projection for this runtime. Edit the source
          (the Muster Orchestrator tab), not this file; direct edits are refused server-side.
        </div>
      ) : null}
      {error ? <div className="banner bad">{error}</div> : null}
      <MonacoEditor
        height="480px"
        language={monacoLanguage(view.format, view.path)}
        value={view.content}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: "on",
          tabSize: 2,
          readOnly: projectedReadOnly
        }}
        onChange={(value) => {
          if (projectedReadOnly) return;
          save(value ?? "");
        }}
      />
    </div>
  );
}

export function RuntimeLogsTail({ rid }: { rid: string }) {
  const [entries, setEntries] = useState<RuntimeLogEntry[] | null>(null);
  const [tail, setTail] = useState<{ rel: string; content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/quarters/runtime/${encodeURIComponent(rid)}/logs`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "failed to list logs");
        setEntries(j);
      })
      .catch((err) => setError(String(err.message ?? err)));
  }, [rid]);

  const open = async (entry: RuntimeLogEntry) => {
    const r = await fetch(
      `/api/quarters/runtime/${encodeURIComponent(rid)}/logs?root=${encodeURIComponent(entry.root)}&path=${encodeURIComponent(entry.rel)}`
    );
    const j = await r.json();
    if (!r.ok) {
      setError(j.error ?? "failed to tail");
      return;
    }
    setTail(j);
    setError(null);
  };

  if (error) return <div className="banner bad">{error}</div>;
  if (!entries) return <div className="quarters-note">loading…</div>;
  if (!entries.length) {
    return <div className="quarters-note">No log files under the declared roots yet — they appear after the engine runs.</div>;
  }
  return (
    <div className="runtime-logs">
      <ul className="runtime-log-list">
        {entries.map((e) => (
          <li key={`${e.root}:${e.rel}`}>
            <button type="button" onClick={() => void open(e)}>
              {e.rel}
            </button>
            <span className="runtime-log-meta">
              {e.bytes} B · {e.mtime}
            </span>
          </li>
        ))}
      </ul>
      {tail ? (
        <pre className="runtime-log-tail">
          {tail.truncated ? "… (tail)\n" : ""}
          {tail.content}
        </pre>
      ) : null}
    </div>
  );
}
