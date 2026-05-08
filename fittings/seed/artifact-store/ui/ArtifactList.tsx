"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";
import type { ArtifactMeta } from "@/lib/artifact-store";
import { formatBytes } from "@/lib/format";

type ListResponse = { artifacts: ArtifactMeta[] };

export default function ArtifactList(_props: FittingViewProps) {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterNamespace, setFilterNamespace] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/fittings/artifact-store/list");
        const data = (await res.json()) as ListResponse | { error: string };
        if (cancelled) return;
        if (!res.ok) throw new Error("error" in data ? data.error : res.statusText);
        setArtifacts((data as ListResponse).artifacts);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const namespaces = useMemo(() => {
    if (!artifacts) return [];
    return Array.from(new Set(artifacts.map((a) => a.namespace))).sort();
  }, [artifacts]);

  const visible = useMemo(() => {
    if (!artifacts) return [];
    if (filterNamespace === "all") return artifacts;
    return artifacts.filter((a) => a.namespace === filterNamespace);
  }, [artifacts, filterNamespace]);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <header>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
          Artifacts
        </div>
        <p style={{ color: "var(--mute)", fontSize: 13, lineHeight: 1.6 }}>
          Files the Operative or its Fittings have produced. Click an entry to
          open it; producer Fittings (Documents, Automations, Voice) can write
          new files at any time.
        </p>
      </header>

      {error ? (
        <div
          style={{
            border: "1px solid var(--alarm)",
            background: "white",
            padding: 12,
            fontSize: 13,
            color: "var(--alarm)"
          }}
        >
          Failed to load artifacts: {error}
        </div>
      ) : null}

      {!artifacts ? (
        <div style={{ color: "var(--mute)", fontSize: 13 }}>Loading…</div>
      ) : artifacts.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--rule)",
            background: "white",
            padding: 24,
            textAlign: "center",
            color: "var(--mute)",
            fontSize: 13
          }}
        >
          No artifacts yet. They will appear here when a Fitting writes one.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--mute)" }}>Namespace</span>
            <NamespaceFilter
              namespaces={["all", ...namespaces]}
              value={filterNamespace}
              onChange={setFilterNamespace}
            />
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--mute)" }}>
              {visible.length} of {artifacts.length}
            </span>
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              border: "1px solid var(--rule)",
              background: "white"
            }}
          >
            {visible.map((artifact) => (
              <ArtifactRow key={artifact.id} artifact={artifact} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function NamespaceFilter({
  namespaces,
  value,
  onChange
}: {
  namespaces: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {namespaces.map((ns) => (
        <button
          key={ns}
          type="button"
          onClick={() => onChange(ns)}
          style={{
            padding: "3px 9px",
            border: "1px solid var(--rule)",
            background: ns === value ? "var(--ink)" : "white",
            color: ns === value ? "white" : "var(--ink)",
            fontSize: 12,
            cursor: "pointer"
          }}
        >
          {ns}
        </button>
      ))}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: ArtifactMeta }) {
  return (
    <li
      style={{
        borderBottom: "1px solid var(--rule)",
        padding: "10px 14px",
        display: "grid",
        gridTemplateColumns: "1fr auto auto",
        gap: 12,
        alignItems: "center"
      }}
    >
      <Link
        href={`/fitting/artifact-store/${artifact.id}`}
        style={{ color: "var(--ink)", textDecoration: "none" }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {artifact.title || artifact.filename}
        </div>
        <div className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
          {artifact.namespace}/{artifact.filename} · {artifact.mime}
        </div>
      </Link>
      <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
        {formatTimestamp(artifact.updated ?? artifact.created)}
      </span>
      <Link
        href={`/fitting/artifact-store/${artifact.id}/delete`}
        style={{ fontSize: 11, color: "var(--alarm)", textDecoration: "none" }}
        aria-label="delete artifact"
      >
        delete
      </Link>
    </li>
  );
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// formatBytes is imported for parity with other components but the list view
// doesn't show file size in v1; the MIME type carries enough signal.
void formatBytes;
