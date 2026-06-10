import type { CapabilityProvision, GarrisonMetadata, UiPlacement } from "./types";

// Layer 1 of the Workspaces/view-state wave: stable instance identity.
//
// Every produced view is addressable as (fittingId, viewId, instanceId) — not
// just by view/capability type. Embedded views come from `ui.views[]`; an
// own-port fitting's UI surfaces as one synthetic view (id "main"). A fitting
// that has never persisted anything has no instance records on disk; callers
// fall back to DEFAULT_INSTANCE_ID so existing single-instance views keep
// working unchanged.
//
// This module is imported by client components (via capabilities.ts), so it
// must stay pure — the on-disk side (paths + instance enumeration) lives in
// view-state.ts, which is server-only.

export const DEFAULT_INSTANCE_ID = "default";

// Path-safe slug — instance/view ids become filenames under view-state/, so
// reject separators and dot-prefixed names outright (no traversal).
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidInstanceId(id: string): boolean {
  return SLUG_RE.test(id) && !id.includes("..");
}

export interface ViewInstanceRef {
  fittingId: string;
  viewId: string;
  instanceId: string;
}

// Canonical textual form: <fittingId>:<viewId>#<instanceId>. The #instanceId
// part is omitted when it is the default, so refs to single-instance views
// read exactly like the registry keys that already exist ("artifact-store:list").
export function formatInstanceRef(ref: ViewInstanceRef): string {
  const base = `${ref.fittingId}:${ref.viewId}`;
  return ref.instanceId === DEFAULT_INSTANCE_ID ? base : `${base}#${ref.instanceId}`;
}

export function parseInstanceRef(raw: string): ViewInstanceRef | null {
  const hash = raw.indexOf("#");
  const instanceId = hash === -1 ? DEFAULT_INSTANCE_ID : raw.slice(hash + 1);
  const head = hash === -1 ? raw : raw.slice(0, hash);
  const colon = head.indexOf(":");
  if (colon <= 0 || colon === head.length - 1) {
    return null;
  }
  const fittingId = head.slice(0, colon);
  const viewId = head.slice(colon + 1);
  if (!isValidInstanceId(fittingId) || !isValidInstanceId(viewId) || !isValidInstanceId(instanceId)) {
    return null;
  }
  return { fittingId, viewId, instanceId };
}

export type ViewSurface = "embedded" | "own-port";

export interface ViewDescriptor {
  fittingId: string;
  viewId: string;
  surface: ViewSurface;
  placement?: UiPlacement;
  route?: string;
}

// The view id an own-port fitting's whole-UI surface gets. Mirrors the v1→v2
// normalisation in metadata.ts, which also names its single view "main".
export const OWN_PORT_VIEW_ID = "main";

export function deriveViewDescriptors(
  fittingId: string,
  metadata: Pick<GarrisonMetadata, "ui" | "own_port">
): ViewDescriptor[] {
  const descriptors: ViewDescriptor[] = [];
  for (const view of metadata.ui?.views ?? []) {
    descriptors.push({
      fittingId,
      viewId: view.id,
      surface: "embedded",
      placement: view.placement,
      route: view.route
    });
  }
  if (metadata.own_port === true && !descriptors.some((d) => d.viewId === OWN_PORT_VIEW_ID)) {
    descriptors.push({ fittingId, viewId: OWN_PORT_VIEW_ID, surface: "own-port" });
  }
  return descriptors;
}

// Synthetic `view` provisions for the capability graph. Provision names are
// the full <fittingId>:<viewId> key so a named consumption can target one
// fitting's view while `cardinality: any` discovers them all.
export function deriveViewProvisions(
  fittingId: string,
  metadata: Pick<GarrisonMetadata, "ui" | "own_port">
): CapabilityProvision[] {
  return deriveViewDescriptors(fittingId, metadata).map((descriptor) => ({
    kind: "view",
    name: `${descriptor.fittingId}:${descriptor.viewId}`
  }));
}
