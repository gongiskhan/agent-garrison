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
// disk — see AGENTS.md §9.
const REGISTRY: Record<string, FittingViewComponent> = {
  "terminal-armory-default:main": dynamic(
    () => import("@/components/trenches/TerminalView"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading terminal…</div>
      )
    }
  ),
  "screen-share-default:main": dynamic(
    () => import("@/components/trenches/ScreenShareView"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading screen share…</div>
      )
    }
  ),
  "worktree-management-sequoias:main": dynamic(
    () => import("@/components/workbench/WorktreeView"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading worktrees…</div>
      )
    }
  ),
  "session-view-sequoias:main": dynamic(
    () => import("@/components/workbench/SessionView"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading sessions…</div>
      )
    }
  ),
  "tier-classifier:main": dynamic(
    () => import("@/components/extensions/TierClassifierInspector"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  ),
  "artifact-store:list": dynamic(
    () => import("../../../fittings/seed/artifact-store/ui/ArtifactList"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  ),
  "artifact-store:view": dynamic(
    () => import("../../../fittings/seed/artifact-store/ui/ArtifactView"),
    {
      ssr: false,
      loading: () => (
        <div style={{ fontSize: 13, color: "var(--mute)" }}>Loading view…</div>
      )
    }
  ),
  "artifact-store:delete": dynamic(
    () => import("../../../fittings/seed/artifact-store/ui/ArtifactDeleteConfirm"),
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
  )
};

export function lookupFittingView(
  fittingId: string,
  viewId: string
): FittingViewComponent | null {
  return REGISTRY[`${fittingId}:${viewId}`] ?? null;
}
