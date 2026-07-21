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
        role="status"
        style={{
          border: "1px dashed var(--rule-2)",
          borderLeft: "3px solid var(--brass)",
          background: "var(--surface)",
          padding: "16px 18px",
          fontSize: 13,
          lineHeight: 1.65,
          color: "var(--mute)"
        }}
      >
        <div
          className="font-mono"
          style={{
            color: "var(--brass)",
            fontSize: 10,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            marginBottom: 5
          }}
        >
          Loader pending
        </div>
        <b style={{ color: "var(--ink)" }}>{entry.name}</b> declares view{" "}
        <code>{view.id}</code> at <code>{view.entry}</code>, but no host loader
        has been registered for it yet.
      </div>
    );
  }
  return <Component config={selection.config} params={params ?? {}} />;
}
