"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";
import type { ArtifactMeta } from "@/lib/document-store";

interface DocumentResponse {
  meta: ArtifactMeta;
  content: string;
}

export default function DocumentEdit({ params }: FittingViewProps) {
  const id = params.id ?? "";
  const router = useRouter();
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [content, setContent] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/fittings/documents/${id}`);
        const data = (await res.json()) as DocumentResponse | { error: string };
        if (cancelled) return;
        if (!res.ok) throw new Error("error" in data ? data.error : res.statusText);
        const doc = data as DocumentResponse;
        setMeta(doc.meta);
        setContent(doc.content);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/fittings/documents/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content })
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      router.push(`/fitting/documents/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!id) return <Notice title="No document id in URL" />;
  if (error && !loaded) return <Notice title="Cannot open document" body={error} />;
  if (!loaded || !meta) return <Notice title="Loading…" />;

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 760 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            Editing · {meta.title || meta.filename}
          </div>
          <div className="font-mono" style={{ fontSize: 11, color: "var(--ink-mute)" }}>
            {meta.namespace}/{meta.filename}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            style={{
              padding: "5px 14px",
              border: "1px solid var(--ink)",
              background: "var(--ink)",
              color: "white",
              fontSize: 12,
              cursor: busy ? "default" : "pointer"
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <Link
            href={`/fitting/documents/${id}`}
            style={{
              padding: "5px 14px",
              border: "1px solid var(--rule)",
              background: "white",
              color: "var(--ink)",
              fontSize: 12,
              textDecoration: "none"
            }}
          >
            Cancel
          </Link>
        </div>
      </header>
      {error ? (
        <div
          style={{
            border: "1px solid var(--alarm)",
            background: "white",
            padding: 10,
            fontSize: 12,
            color: "var(--alarm)"
          }}
        >
          {error}
        </div>
      ) : null}
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        spellCheck
        style={{
          minHeight: 480,
          padding: "16px 20px",
          border: "1px solid var(--rule)",
          background: "white",
          fontFamily: "var(--font-mono), Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.6,
          resize: "vertical"
        }}
      />
    </div>
  );
}

function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      {body ? (
        <div style={{ color: "var(--mute)", fontSize: 13, marginTop: 6 }}>
          {body}
        </div>
      ) : null}
    </div>
  );
}
