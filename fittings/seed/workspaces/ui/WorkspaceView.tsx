// The manifest's declared entry for the workspaces:main view. The host-side
// implementation lives with the other registry components (UI contract v2
// keeps the loader static); this file keeps the apm.yml entry path honest.
export { default } from "@/components/fitting-views/workspaces/WorkspaceView";
export type { WorkspaceLayout, WorkspacePane } from "@/components/fitting-views/workspaces/WorkspaceView";
