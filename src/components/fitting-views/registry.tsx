"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { SelectedFitting } from "@/lib/types";

export interface FittingViewProps {
  config: SelectedFitting["config"];
  params: Record<string, string>;
}

type FittingViewComponent = ComponentType<FittingViewProps>;

// UI contract v2 keeps the loader static. A Fitting's `ui.views[]` declares
// which views exist; the host app decides how to render them. New Fittings
// that ship a UI add their entry here. v3 may revisit dynamic loading from
// disk — see docs/SPEC.md §9.
//
// Fittings that serve their own React UI on their own port (Monitor pattern,
// see docs/decisions/2026-05-17-dissolve-workbench.md) do not embed a view
// here. They register at runtime via ~/.garrison/ui-fittings/<id>.json and
// are surfaced by the sidebar Views section.
const REGISTRY: Record<string, FittingViewComponent> = {
  "tier-classifier:main": dynamic(
    () => import("@/components/extensions/TierClassifierInspector"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  ),
  "documents:read": dynamic(
    () => import("../../../fittings/seed/documents/ui/DocumentRead"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  ),
  "documents:edit": dynamic(
    () => import("../../../fittings/seed/documents/ui/DocumentEdit"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  ),
  "snapshots-default:snapshots": dynamic(
    () => import("@/components/fitting-views/SnapshotsView"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  )
};

export function lookupFittingView(
  fittingId: string,
  viewId: string
): FittingViewComponent | null {
  return REGISTRY[`${fittingId}:${viewId}`] ?? null;
}
