"use client";

import type { ComponentType } from "react";
import type { PrimitiveRecord, PrimitiveSurface } from "@/lib/primitive-state";
import { McpServerForm } from "./McpServerForm";
import { FilePrimitiveForm } from "./FilePrimitiveForm";

// ---- file-primitive editors (skill / command / rule) ----

const skillTemplate = (name: string): string =>
  `---\nname: ${name || "my-skill"}\ndescription: One line on when this skill should trigger.\n---\n\n# ${name || "my-skill"}\n\nSkill instructions go here.\n`;

const commandTemplate = (name: string): string =>
  `# /${name || "my-command"}\n\nThe prompt this slash command runs. Use $ARGUMENTS for the invocation text.\n`;

const ruleTemplate = (name: string): string =>
  `# ${name || "my-rule"}\n\nA rule / instruction that applies when relevant.\n`;

function SkillEditor(props: SurfaceEditorProps) {
  return <FilePrimitiveForm surface="skill" noun="skill" template={skillTemplate} {...props} />;
}

function CommandEditor(props: SurfaceEditorProps) {
  return <FilePrimitiveForm surface="command" noun="command" template={commandTemplate} {...props} />;
}

function RuleEditor(props: SurfaceEditorProps) {
  return <FilePrimitiveForm surface="rule" noun="rule" template={ruleTemplate} {...props} />;
}

// A loose file primitive deletes directly; an APM-owned one routes to Park (the
// writer-of-record invariant — the dispatch enforces this server-side too).
function fileDeleteBody(surface: "skill" | "command" | "rule") {
  return (rec: PrimitiveRecord): Record<string, unknown> | null =>
    rec.state === "owned" ? null : { action: "file.delete", surface, name: rec.name };
}
function fileBlockedHint(rec: PrimitiveRecord): string | null {
  return rec.state === "owned" ? "Park to remove" : null;
}

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
  },
  skill: {
    noun: "skill",
    createLabel: "New skill",
    creatable: true,
    Editor: SkillEditor,
    deleteBody: fileDeleteBody("skill"),
    blockedDeleteHint: fileBlockedHint
  },
  command: {
    noun: "command",
    createLabel: "New command",
    creatable: true,
    Editor: CommandEditor,
    deleteBody: fileDeleteBody("command"),
    blockedDeleteHint: fileBlockedHint
  },
  rule: {
    noun: "rule",
    createLabel: "New rule",
    creatable: true,
    Editor: RuleEditor,
    deleteBody: fileDeleteBody("rule"),
    blockedDeleteHint: fileBlockedHint
  }
};

export function crudFor(surface: PrimitiveSurface): SurfaceCrud | undefined {
  return SURFACE_CRUD[surface];
}
