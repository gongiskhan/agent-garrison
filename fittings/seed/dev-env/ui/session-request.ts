// Pure request-body builder for the Dev Env "New session" dialog.
//
// GARRISON-UNIFY-V1 S7 (D22): the ORCHESTRATED path is the DEFAULT — a new
// session goes through the orchestrator (the server calls
// /api/orchestrator/place and launches Claude with the composed mode prompt +
// model). The one explicit escape hatch is the clearly-labeled PLAIN option
// ("plain claude, for debugging Garrison itself"), which sends plain:true and
// is logged server-side. `resume` keeps the legacy `claude --continue` path.
// Kept React-free so it can be unit-tested without a DOM.

export interface SessionKindOption {
  value: string;
  label: string;
}

export const MODE_OPTIONS: SessionKindOption[] = [
  { value: "operative", label: "Operative — Orchestrator identity (default)" },
  { value: "plain", label: "Plain claude, for debugging Garrison itself (unorchestrated, logged)" }
];

export const DEFAULT_MODE = "operative";

export function buildSessionRequest({
  path,
  resume = false,
  mode = null
}: {
  path: string;
  resume?: boolean;
  mode?: string | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { path: path.trim() };
  if (resume) {
    body.continue = true;
    return body; // resume is the legacy --continue path; never orchestrated
  }
  if (mode === "plain" || mode === "off") {
    // D22 escape hatch — explicit, labeled, logged server-side. "off" is the
    // legacy spelling, mapped to the same thing.
    body.plain = true;
    return body;
  }
  // Orchestrated is the default. Identity and routing come from Orchestrator;
  // there is no persona/mode selector to send over the wire.
  return body;
}
