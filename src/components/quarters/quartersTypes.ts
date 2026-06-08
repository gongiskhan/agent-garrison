import type { PrimitiveSurface } from "@/lib/primitive-state";

// Canonical, ordered list of the Quarters categories — the single source of
// truth shared by the sidebar, the index, and the [type] route validator. Each
// mirrors a Claude Code artifact type by name.
//
// writer (corrected from the brief by probe — see D8):
//   apm       — package files compiled by Garrison-initiated `apm install`
//   garrison  — written directly by Garrison (settings.json scalars, hooks,
//               markdown documents)
//   split     — packaged (apm) vs standalone (garrison)
//   readonly  — tailed/surfaced, never written

export type QuartersWriter = "apm" | "garrison" | "split" | "readonly";
export type QuartersKind = "settings" | "document" | "primitives" | "readonly";

export interface QuartersCategory {
  slug: string;
  label: string;
  blurb: string;
  writer: QuartersWriter;
  kind: QuartersKind;
  icon: string; // lucide icon name, resolved in the component
  surfaces?: PrimitiveSurface[]; // for kind === "primitives"
}

export const QUARTERS_CATEGORIES: QuartersCategory[] = [
  {
    slug: "settings",
    label: "Settings",
    blurb: "Model, permissions, env, statusline — written directly to settings.json.",
    writer: "garrison",
    kind: "settings",
    icon: "SlidersHorizontal"
  },
  {
    slug: "context",
    label: "Context",
    blurb: "CLAUDE.md (user + project) — the durable guidance the Memory faculty produces.",
    writer: "garrison",
    kind: "document",
    icon: "NotebookText"
  },
  {
    slug: "skills",
    label: "Skills",
    blurb: "Agent skills compiled into ~/.claude/skills by APM.",
    writer: "apm",
    kind: "primitives",
    icon: "Sparkles",
    surfaces: ["skill"]
  },
  {
    slug: "hooks",
    label: "Hooks",
    blurb: "settings.json hook groups — owned by Garrison fittings or hand-authored.",
    writer: "garrison",
    kind: "primitives",
    icon: "Webhook",
    surfaces: ["hook"]
  },
  {
    slug: "mcps",
    label: "MCPs",
    blurb: "MCP servers declared in mcp.json.",
    writer: "garrison",
    kind: "primitives",
    icon: "Plug",
    surfaces: ["mcp"]
  },
  {
    slug: "plugins",
    label: "Plugins",
    blurb: "Plugin collections installed by APM.",
    writer: "apm",
    kind: "primitives",
    icon: "Boxes",
    surfaces: ["plugin"]
  },
  {
    slug: "scripts",
    label: "Scripts",
    blurb: "Commands and rules — file primitives APM deploys into ~/.claude.",
    writer: "split",
    kind: "primitives",
    icon: "ScrollText",
    surfaces: ["command", "rule"]
  },
  {
    slug: "plans",
    label: "Plans",
    blurb: "Markdown plan files under ~/.claude/plans.",
    writer: "garrison",
    kind: "document",
    icon: "ClipboardList"
  },
  {
    slug: "logs",
    label: "Logs",
    blurb: "Claude Code logs — tailed read-only via the Observability faculty.",
    writer: "readonly",
    kind: "readonly",
    icon: "FileText"
  },
  {
    slug: "sessions",
    label: "Sessions",
    blurb: "Session records — surfaced read-only by the Session Viewer.",
    writer: "readonly",
    kind: "readonly",
    icon: "History"
  }
];

export const QUARTERS_SLUGS = QUARTERS_CATEGORIES.map((c) => c.slug);

export function categoryBySlug(slug: string): QuartersCategory | undefined {
  return QUARTERS_CATEGORIES.find((c) => c.slug === slug);
}

export const WRITER_LABEL: Record<QuartersWriter, string> = {
  apm: "APM-compiled",
  garrison: "Garrison-direct",
  split: "APM / Garrison",
  readonly: "read-only"
};
