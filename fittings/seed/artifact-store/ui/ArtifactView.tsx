"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";
import type { ArtifactMeta } from "@/lib/artifact-store";

type ListResponse = { artifacts: ArtifactMeta[] };

export default function ArtifactView({ params }: FittingViewProps) {
  const id = params.id ?? "";
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/fittings/artifact-store/list");
        const data = (await res.json()) as ListResponse | { error: string };
        if (cancelled) return;
        if (!res.ok) throw new Error("error" in data ? data.error : res.statusText);
        const found =
          (data as ListResponse).artifacts.find((a) => a.id === id) ?? null;
        if (!found) {
          setError(`artifact ${id} not found`);
          return;
        }
        setMeta(found);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) {
    return <SimpleMessage title="No artifact id in URL" />;
  }
  if (error) {
    return <SimpleMessage title="Cannot open artifact" body={error} />;
  }
  if (!meta) {
    return <SimpleMessage title="Loading…" />;
  }

  const downloadUrl = `/api/fittings/artifact-store/${meta.id}`;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {meta.title || meta.filename}
          </div>
          <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
            {meta.namespace}/{meta.filename} · {meta.mime}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
          {meta.mime === "text/markdown" && meta.namespace === "documents" ? (
            <Link href={`/fitting/documents/${meta.id}`} style={linkStyle}>
              open in Documents
            </Link>
          ) : null}
          <a href={downloadUrl} download={meta.filename} style={linkStyle}>
            download
          </a>
          <Link href="/fitting/artifact-store" style={linkStyle}>
            back to list
          </Link>
        </div>
      </header>

      <ArtifactBody meta={meta} downloadUrl={downloadUrl} />
    </div>
  );
}

function ArtifactBody({
  meta,
  downloadUrl
}: {
  meta: ArtifactMeta;
  downloadUrl: string;
}) {
  const mime = meta.mime || "application/octet-stream";

  if (mime.startsWith("image/")) {
    return (
      <img
        src={downloadUrl}
        alt={meta.title || meta.filename}
        style={{ maxWidth: "100%", border: "1px solid var(--rule)" }}
      />
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <video
        controls
        src={downloadUrl}
        style={{ maxWidth: "100%", border: "1px solid var(--rule)" }}
      />
    );
  }
  if (mime.startsWith("audio/")) {
    return <audio controls src={downloadUrl} style={{ width: "100%" }} />;
  }
  if (
    mime === "text/markdown" ||
    mime === "text/plain" ||
    mime === "application/json"
  ) {
    return <TextPreview downloadUrl={downloadUrl} />;
  }
  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        background: "white",
        padding: 16,
        fontSize: 13,
        color: "var(--mute)"
      }}
    >
      No preview available for {mime}. Use the download button above.
    </div>
  );
}

function TextPreview({ downloadUrl }: { downloadUrl: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(downloadUrl);
      const body = await res.text();
      if (!cancelled) setText(body);
    })();
    return () => {
      cancelled = true;
    };
  }, [downloadUrl]);
  if (text === null) return <div style={{ color: "var(--mute)" }}>Loading…</div>;
  return (
    <pre
      style={{
        margin: 0,
        padding: 14,
        border: "1px solid var(--rule)",
        background: "white",
        fontSize: 12.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}
    >
      {text}
    </pre>
  );
}

function SimpleMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      {body ? (
        <div style={{ color: "var(--mute)", fontSize: 13, marginTop: 4 }}>
          {body}
        </div>
      ) : null}
    </div>
  );
}

const linkStyle = {
  fontSize: 13,
  color: "var(--ink)",
  textDecoration: "underline"
} as const;
