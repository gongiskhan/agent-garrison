// Declared entry for the sidebar-surface view.
//
// In UI contract v2 the host app does NOT load fitting views from disk (see
// docs/METADATA.md) - the live component is registered statically in
// src/components/fitting-views/registry.tsx. This re-export keeps the declared
// `entry` path resolving to that single implementation so the two never drift.
export { default } from "../../../../src/components/fitting-views/SnapshotsView";
