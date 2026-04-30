"use client";

import dynamic from "next/dynamic";
import type { LibraryEntry, SelectedComponent } from "@/lib/types";

const TierClassifierInspector = dynamic(
  () => import("@/components/extensions/TierClassifierInspector"),
  {
    ssr: false,
    loading: () => <div className="text-sm text-ink/60">Loading extension...</div>
  }
);

export function ExtensionPane({
  entry,
  selection
}: {
  entry: LibraryEntry;
  selection: SelectedComponent;
}) {
  if (entry.id === "tier-classifier") {
    return <TierClassifierInspector config={selection.config} />;
  }
  return (
    <div className="border border-[#d9d1c2] bg-white p-4 text-sm text-[#666b63]">
      {entry.name} declares a UI extension at {entry.metadata.ui?.extension}, but no host loader has been
      registered for it yet.
    </div>
  );
}
