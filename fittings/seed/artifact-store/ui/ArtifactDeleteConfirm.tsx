"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";

export default function ArtifactDeleteConfirm({ params }: FittingViewProps) {
  const id = params.id ?? "";
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!id) {
    return <div>No artifact id in URL.</div>;
  }

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/fittings/artifact-store/${id}`, {
        method: "DELETE"
      });
      const data = (await res.json()) as { deleted?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      router.push("/fitting/artifact-store");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 480, display: "grid", gap: 14 }}>
      <header>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
          Delete artifact?
        </div>
        <div
          className="font-mono"
          style={{ fontSize: 11, color: "var(--mute)" }}
        >
          {id}
        </div>
      </header>
      <p style={{ color: "var(--mute)", fontSize: 13, lineHeight: 1.6 }}>
        This removes the file and its sidecar from disk. The action is not
        reversible.
      </p>
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
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy}
          style={{
            padding: "6px 12px",
            border: "1px solid var(--alarm)",
            background: "var(--alarm)",
            color: "white",
            fontSize: 12,
            cursor: busy ? "default" : "pointer"
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
        <Link
          href={`/fitting/artifact-store/${id}`}
          style={{
            padding: "6px 12px",
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
    </div>
  );
}
