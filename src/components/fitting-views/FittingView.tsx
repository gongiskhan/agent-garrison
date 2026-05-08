"use client";

import type { LibraryEntry, SelectedFitting, UiView } from "@/lib/types";
import { lookupFittingView } from "./registry";

export function FittingView({
  entry,
  selection,
  view,
  params
}: {
  entry: LibraryEntry;
  selection: SelectedFitting;
  view: UiView;
  params?: Record<string, string>;
}) {
  const Component = lookupFittingView(entry.id, view.id);
  if (!Component) {
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
        {entry.name} declares view <code>{view.id}</code> at{" "}
        <code>{view.entry}</code>, but no host loader has been registered for
        it yet.
      </div>
    );
  }
  return <Component config={selection.config} params={params ?? {}} />;
}
