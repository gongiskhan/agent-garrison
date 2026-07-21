// runtime-bridge.mjs — the uniform runtime-to-runtime delegation contract
// (BRIEF v4 §2 "Runtime-to-runtime delegation"). Every runtime fitting ships a
// runtime-bridge exposing ONE tool: delegate(task_spec) -> {summary, artifacts}.
// The channel is MCP (the native structured tool channel the primary speaks),
// NOT a bespoke shell script; this module is the bridge CORE the per-runtime MCP
// server + CLI wrap. It runs the work in the secondary's OWN loop via its
// RuntimeAdapter (a pooled TUI session for Claude-as-secondary — never `-p`),
// writes full output to the Artifact Store, and returns a self-contained result.
//
// Guards (bypassPermissions hardening):
//   - task spec arrives via stdin/temp file, NEVER interpolated into argv.
//   - `model` validated against a per-provider allowlist pattern.
//   - missing model / missing API-key env = loud structured failure that
//     distinguishes "vault locked" from "secret absent".
//   - return schema-validated (retry once, then fail loudly / non-zero).
//   - every delegation appended to decisions.jsonl.

export class DelegationError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DelegationError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// Validate a task spec. modelAllowlist is a RegExp (per-provider pattern) or null.
export function validateTaskSpec(spec, opts = {}) {
  const errors = [];
  if (!spec || typeof spec !== "object") return ["task spec is not an object"];
  if (!spec.task || typeof spec.task !== "string") errors.push("missing required `task` (string)");
  if (spec.paths && !Array.isArray(spec.paths)) errors.push("`paths` must be an array");
  if (opts.requireModel && !spec.model) errors.push("missing required `model`");
  if (spec.model && opts.modelAllowlist && !opts.modelAllowlist.test(spec.model)) {
    errors.push(`model "${spec.model}" not allowed by the provider allowlist`);
  }
  return errors;
}

// Parse a task spec from a raw string (stdin / temp-file contents). Throws a
// loud DelegationError on invalid JSON (never silently swallow).
export function parseTaskSpec(raw) {
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    throw new DelegationError("invalid-json", `task spec is not valid JSON: ${err?.message}`);
  }
  return spec;
}

// Validate the bridge's RETURN value (short structured summary + artifact paths).
// D19 (assumption 2): an EMPTY delegation is a FAILURE, not a success. The old
// `summarize("")` fabricated the placeholder "(no output)" — a non-empty string
// that slipped past a bare `.length` check and made a no-op delegation read as a
// valid result. Both the empty/whitespace summary AND that historical placeholder
// are now rejected here (defense in depth against a hand-built result), and
// `delegate()` throws an explicit "empty-output" error before it ever gets here.
export const EMPTY_OUTPUT_PLACEHOLDER = "(no output)";
export function validateDelegationResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result is not an object"];
  if (typeof result.summary !== "string" || !result.summary.trim()) errors.push("empty delegation output (no `summary`) — a delegation that produced nothing is a failure, not a valid result");
  else if (result.summary.trim() === EMPTY_OUTPUT_PLACEHOLDER) errors.push(`delegation summary is the empty-output placeholder "${EMPTY_OUTPUT_PLACEHOLDER}" — the secondary returned nothing`);
  if (!Array.isArray(result.artifacts)) errors.push("`artifacts` must be an array of paths");
  return errors;
}

// The bridge core. Dependencies are injected so it is unit-testable without a
// live runtime / artifact store / disk:
//   adapter        — a RuntimeAdapter (spawn/sendTurn/awaitResponse/teardown)
//   spawnConfig    — env/cwd/model for adapter.spawn
//   writeArtifact  — async (namespace, name, content) -> artifactPath
//   logDecision    — async (record) -> void   (append to decisions.jsonl)
//   secrets        — materialized vault (key->value) or null (locked); used only
//                    to surface a loud locked-vs-absent error when a key is needed
//   now            — () -> ISO string (passed in for determinism)
export async function delegate(spec, deps, opts = {}) {
  const { adapter, spawnConfig, writeArtifact, logDecision, now } = deps;
  const errors = validateTaskSpec(spec, opts);
  if (errors.length) throw new DelegationError("invalid-task-spec", errors.join("; "), { errors });

  // A required key that is absent must fail loudly + distinguish locked vs absent.
  if (opts.requiredKey) {
    const locked = deps.secrets == null;
    const val = locked ? undefined : deps.secrets[opts.requiredKey];
    if (!val) {
      throw new DelegationError(
        "missing-key",
        locked
          ? `delegation needs ${opts.requiredKey} but the vault is LOCKED`
          : `delegation needs ${opts.requiredKey} but the secret is ABSENT`,
        { vaultLocked: locked, key: opts.requiredKey }
      );
    }
  }

  const runOnce = async () => {
    let session;
    try {
      session = await adapter.spawn(spawnConfig);
      await adapter.awaitReady(session);
      const prompt = renderTaskPrompt(spec);
      await adapter.sendTurn(session, prompt);
      const resp = await adapter.awaitResponse(session);
      return resp;
    } finally {
      if (session) await adapter.teardown(session);
    }
  };

  // retry once, then fail loudly
  let resp;
  try {
    resp = await runOnce();
  } catch (err) {
    resp = await runOnce().catch((err2) => {
      throw new DelegationError("delegation-failed", `delegation failed after retry: ${err2?.message || err?.message}`);
    });
  }

  const fullOutput = resp?.text ?? "";
  // D19 (assumption 2): empty/whitespace output is a FAILURE — the secondary ran
  // but produced nothing. Fail loudly HERE (before writing an empty artifact or
  // logging a fake "success") so a no-op delegation can never read as a valid
  // result. Distinguishes "empty output" from a genuine result the same way the
  // other guards distinguish their failure modes.
  if (!String(fullOutput).trim()) {
    throw new DelegationError(
      "empty-output",
      `delegation to ${adapter.id} produced no output — the secondary returned nothing, which is a failure (not a valid result)`,
      { runtime: adapter.id, model: spec.model ?? null }
    );
  }
  const artifactPath = await writeArtifact("delegations", `${adapter.id}-${(now ? now() : "0").replace(/[:.]/g, "-")}.md`, fullOutput);
  const result = {
    summary: summarize(fullOutput),
    artifacts: [artifactPath, ...(resp?.artifacts ?? [])],
    // Preserve cumulative token usage when the adapter reports it (additive
    // telemetry, S1a). Unknown fields are otherwise dropped here because the
    // result is rebuilt from scratch; validateDelegationResult ignores extras.
    ...(typeof resp?.usedTokens === "number" ? { usedTokens: resp.usedTokens } : {})
  };
  const resErrors = validateDelegationResult(result);
  if (resErrors.length) throw new DelegationError("invalid-result", resErrors.join("; "), { resErrors });

  await logDecision({
    at: now ? now() : null,
    kind: "delegation",
    runtime: adapter.id,
    // Redact secret/path-shaped content from the task before it is persisted to
    // the decisions log (codex checkpoint finding): a task string can carry a
    // provider key or an absolute home path. Strip those, then cap length.
    task: redactForLog(spec.task),
    model: spec.model ?? null,
    artifacts: result.artifacts
  });
  return result;
}

// Redact secrets/paths from a free-text task before it lands in the durable
// decisions log. Not a digest (the task summary stays legible), just a scrub.
function redactForLog(task) {
  return String(task ?? "")
    .replace(/(\/home\/[^\s"']+|\/Users\/[^\s"']+|~\/[^\s"']+)/g, "[path]")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(sk|dg|pk)-[A-Za-z0-9._\-]{6,}/g, "[redacted]")
    .slice(0, 120);
}

function renderTaskPrompt(spec) {
  const parts = [`Task: ${spec.task}`];
  if (spec.paths?.length) parts.push(`Paths: ${spec.paths.join(", ")}`);
  if (spec.constraints) parts.push(`Constraints: ${typeof spec.constraints === "string" ? spec.constraints : JSON.stringify(spec.constraints)}`);
  if (spec.expectedSchema) parts.push(`Return shape: ${JSON.stringify(spec.expectedSchema)}`);
  parts.push("Produce a self-contained result; write full output to the workspace.");
  return parts.join("\n");
}

// D19: NEVER fabricate a placeholder for empty input — an empty summary must stay
// empty so validateDelegationResult can reject it. `delegate()` already fails loudly
// on empty output before calling this, so this only ever shapes real content.
function summarize(text, max = 600) {
  const trimmed = String(text).trim();
  if (!trimmed) return "";
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}
