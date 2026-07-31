"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { LibraryEntry, SelectedFitting } from "@/lib/types";

export interface FittingViewProps {
  entry: LibraryEntry;
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
// which views exist; the host app decides how to render them. A BESPOKE view
// adds its `<fittingId>:<viewId>` entry here; a fitting without one uses a
// SHARED view by naming a `garrison:<kind>` entry path in its manifest (see
// SHARED_VIEWS below). v3 may revisit dynamic loading from disk — see
// docs/SPEC.md §9.
//
// Fittings that serve their own React UI on their own port (Monitor pattern,
// see docs/decisions/2026-05-17-dissolve-workbench.md) do not embed a view
// here. They register at runtime via ~/.garrison/ui-fittings/<id>.json and
// are surfaced by the sidebar Fittings section.
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
  ),
  // Both Roadmaps views render the same component: `roadmap` is the picker at
  // the root, `project` is the same screen deep-linked to one project.
  "roadmaps:roadmap": dynamic(() => import("@/components/fitting-views/RoadmapView"), {
    ssr: false,
    loading: ViewLoading
  }),
  "roadmaps:project": dynamic(() => import("@/components/fitting-views/RoadmapView"), {
    ssr: false,
    loading: ViewLoading
  })
};

// Shared shape-aware views (2026-07-29 fittings/views refit: every Fitting
// declares a view). A manifest opts in by pointing the view's `entry` at a
// `garrison:<kind>` path instead of a bundled module:
//   garrison:skill      SKILL.md frontmatter + body editor over .apm/skills
//   garrison:prompt     prompt markdown editor over .apm/prompts + payload
//   garrison:runtime    engine identity + config + live Test probe
//   garrison:connector  auth + action catalog + triggers + config
//   garrison:manage     the baseline: how-it-works + capabilities + config
const SHARED_VIEWS: Record<string, FittingViewComponent> = {
  "garrison:skill": dynamic(() => import("./shared/SkillView"), {
    ssr: false,
    loading: ViewLoading
  }),
  "garrison:prompt": dynamic(() => import("./shared/PromptView"), {
    ssr: false,
    loading: ViewLoading
  }),
  "garrison:runtime": dynamic(() => import("./shared/RuntimeView"), {
    ssr: false,
    loading: ViewLoading
  }),
  "garrison:connector": dynamic(() => import("./shared/ConnectorView"), {
    ssr: false,
    loading: ViewLoading
  }),
  "garrison:manage": dynamic(() => import("./shared/ManageView"), {
    ssr: false,
    loading: ViewLoading
  })
};

export function lookupFittingView(
  fittingId: string,
  viewId: string,
  viewEntry?: string
): FittingViewComponent | null {
  return (
    REGISTRY[`${fittingId}:${viewId}`] ??
    (viewEntry ? (SHARED_VIEWS[viewEntry] ?? null) : null)
  );
}
