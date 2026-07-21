"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { SelectedFitting } from "@/lib/types";

export interface FittingViewProps {
  config: SelectedFitting["config"];
  params: Record<string, string>;
}

type FittingViewComponent = ComponentType<FittingViewProps>;

function ViewLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="grid min-h-40 content-center gap-3 border-l-2 border-[var(--brass)] bg-[var(--surface)] px-5 py-6"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--brass)]">
        Preparing Fitting view
      </span>
      <span className="skeleton-line h-3 w-3/5 rounded-sm" aria-hidden />
      <span className="skeleton-line h-3 w-2/5 rounded-sm" aria-hidden />
      <span className="visually-hidden">Loading view…</span>
    </div>
  );
}

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
      loading: ViewLoading
    }
  ),
  "documents:read": dynamic(
    () => import("../../../fittings/seed/documents/ui/DocumentRead"),
    {
      ssr: false,
      loading: ViewLoading
    }
  ),
  "documents:edit": dynamic(
    () => import("../../../fittings/seed/documents/ui/DocumentEdit"),
    {
      ssr: false,
      loading: ViewLoading
    }
  ),
  "snapshots-default:snapshots": dynamic(
    () => import("@/components/fitting-views/SnapshotsView"),
    {
      ssr: false,
      loading: ViewLoading
    }
  )
};

export function lookupFittingView(
  fittingId: string,
  viewId: string
): FittingViewComponent | null {
  return REGISTRY[`${fittingId}:${viewId}`] ?? null;
}
