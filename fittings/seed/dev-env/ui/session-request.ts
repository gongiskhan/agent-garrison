// Pure request-body builder for the Dev Env "New session" dialog (s3c).
//
// Kept React-free so it can be unit-tested without a DOM. The dialog's mode
// dropdown maps to this: a real mode (gary/joe/james) starts the session THROUGH
// the orchestrator (the server then calls /api/orchestrator/place and launches
// Claude with the composed mode prompt + model); "off" starts a bare session.
// `resume` keeps the legacy `claude --continue` path and never goes orchestrated.

export interface ModeOption {
  value: string;
  label: string;
}

// Default to Joe — the dev face — for new Dev Env sessions (the modes brief's
// channel default for dev-env).
export const MODE_OPTIONS: ModeOption[] = [
  { value: "joe", label: "Joe — dev (default)" },
  { value: "gary", label: "Gary — assistant" },
  { value: "james", label: "James — product / architect" },
  { value: "off", label: "Bare session (no orchestrator)" }
];

export const DEFAULT_MODE = "joe";

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
  if (mode && mode !== "off") {
    body.orchestrated = true;
    body.mode = mode;
  }
  return body;
}
