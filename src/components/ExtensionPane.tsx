"use client";

import dynamic from "next/dynamic";
import type { LibraryEntry, SelectedFitting } from "@/lib/types";

const TierClassifierInspector = dynamic(
  () => import("@/components/extensions/TierClassifierInspector"),
  {
    ssr: false,
    loading: () => (
      <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading extension…</div>
    )
  }
);

export function ExtensionPane({
  entry,
  selection
}: {
  entry: LibraryEntry;
  selection: SelectedFitting;
}) {
  if (entry.id === "tier-classifier") {
    return <TierClassifierInspector config={selection.config} />;
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
      {entry.name} declares a UI extension at {entry.metadata.ui?.extension}, but no host loader has been
      registered for it yet.
    </div>
  );
}
