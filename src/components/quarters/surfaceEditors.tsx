"use client";

import type { ComponentType } from "react";
import type { PrimitiveRecord, PrimitiveSurface } from "@/lib/primitive-state";
import { McpServerForm } from "./McpServerForm";

// Props every per-surface editor receives. `rec === null` means create; a record
// means edit. The editor owns its own fetch/save and calls onSaved (reload+close)
// or onClose (cancel).
export interface SurfaceEditorProps {
  rec: PrimitiveRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

// One registry entry per writable surface. PrimitiveListPanel is generic; this is
// the ONLY place that grows as each CRUD slice lands (mcp → skills → scripts →
// hooks). Encodes the writer-of-record invariant: `deleteBody` returns null when
// a record must NOT be directly deleted (e.g. an APM-owned file → Park instead),
// and `blockedDeleteHint` explains why.
export interface SurfaceCrud {
  noun: string; // "MCP server"
  createLabel: string; // "Add server"
  creatable: boolean;
  Editor: ComponentType<SurfaceEditorProps>;
  // POST body to delete this record, or null if it can't be directly deleted.
  deleteBody: (rec: PrimitiveRecord) => Record<string, unknown> | null;
  // When deleteBody is null, a short reason shown in place of the Delete button.
  blockedDeleteHint?: (rec: PrimitiveRecord) => string | null;
}

export const SURFACE_CRUD: Partial<Record<PrimitiveSurface, SurfaceCrud>> = {
  mcp: {
    noun: "MCP server",
    createLabel: "Add server",
    creatable: true,
    Editor: McpServerForm,
    // mcp.json has no APM ownership model — every server is loose, always removable.
    deleteBody: (rec) => ({ action: "mcp.remove", name: rec.name })
  }
};

export function crudFor(surface: PrimitiveSurface): SurfaceCrud | undefined {
  return SURFACE_CRUD[surface];
}
