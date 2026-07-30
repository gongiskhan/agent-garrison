// Decisions feed reader for the Muster Decisions panel (S5c, D12).
//
// The Dispatcher and the gateway append routing decisions to a composition's
// `.garrison/decisions.jsonl` (one JSON object per line). The records are
// heterogeneous - a Dispatcher `dispatch` record carries {duty, level}, a
// gateway `route`/placement record carries {taskType, tier, role, targetId}. This
// module reads the TAIL and normalizes each into ONE small, safe view the panel
// renders: {at, kind, duty, level, target, reason}.
//
// SECURITY (read-only, no leak): normalization is a strict WHITELIST of scalar
// fields - never the raw line, never a file path, never an arbitrary field. The
// persisted records already carry a prompt/message DIGEST, never the user's text
// (the dispatcher's free-text reason is dropped at write time, codex S3d), so a
// digest is safe to surface but adds nothing here and is left out. A stored
// free-text `reason` is trusted ONLY for a `dispatch` record (code-composed at
// write time); every other kind gets a reason composed here from safe scalars.

import path from "node:path";
import { createHash } from "node:crypto";
import { readFileTolerant } from "./atomic-write";

export const DECISIONS_REL = ".garrison/decisions.jsonl";

export const DEFAULT_DECISIONS_LIMIT = 20;
export const MAX_DECISIONS_LIMIT = 100;

export interface DecisionView {
  /**
   * Stable handle for this decision (RUN-SPEC-V1). Written by the gateway for new
   * records; DERIVED here by the identical formula for the ~3800 older ones, which
   * carry none — so a verdict can name any row in the feed, not just recent ones.
   * Never null: a row with no id is a row the user cannot judge.
   */
  id: string;
  at: string | null;
  kind: string;
  duty: string | null;
  level: number | null;
  target: string | null;
  reason: string | null;
  // The RUN dimensions, surfaced as fields rather than smuggled inside `reason`.
  // These are the axes the user is being asked "was this right?" about, so each
  // needs to be readable on its own and pre-fillable into the correction menus.
  // Each is a scalar whitelist entry like every other field here - the module's
  // security posture is unchanged, the selection is just less lossy.
  runtime: string | null;
  model: string | null;
  effort: string | null;
  tier: string | null;
  taskType: string | null;
  /** duty-cell | turn-override | classifier - WHO chose this route. */
  via: string | null;
  /** True when no classifier call was needed (the choice was already explicit). */
  classifierSkipped: boolean | null;
  // The message digest (never the raw message) — the safe correlation handle
  // (codex S5b/S5c finding). The feed carries this, not user content.
  messageDigest: string | null;
  // The session this decision was made for, so the feed can link back to the
  // conversation that caused it. An OPAQUE handle only — it is a thread key or
  // session uuid, never a path and never user text. Null on records written
  // before it was recorded, which is why the panel treats it as optional.
  sessionId: string | null;
  // A host-supplied display label for that session. Whitelisted like every other
  // field and length-capped, since unlike the id it is human-authored.
  sessionTitle: string | null;
}

// Session titles are user/host authored, so they get the same defensive
// treatment as `reason`: no paths, no secret-shaped tokens, bounded length.
function sanitizeTitle(title: string | null): string | null {
  if (title == null) return null;
  const out = title
    .replace(/(\/home\/[^\s"']+|\/Users\/[^\s"']+|~\/[^\s"']+)/g, "[path]")
    .replace(/\b(password|secret|token|api[_-]?key|credential)s?\b[:=\s]*\S*/gi, "[redacted]")
    .trim();
  if (out.length === 0) return null;
  return out.length > 80 ? `${out.slice(0, 80)}…` : out;
}

// Defensively redact path/secret/raw-message-shaped content from a reason before
// it reaches the feed (codex finding): even though the dispatcher now writes a
// code-composed reason, an old or hand-edited decisions.jsonl line could carry
// raw user text. Strip absolute/home paths + secret-looking tokens and cap
// length so a stray raw message can't be displayed verbatim.
function sanitizeReason(reason: string | null): string | null {
  if (reason == null) return null;
  let out = reason
    .replace(/(\/home\/[^\s"']+|\/Users\/[^\s"']+|~\/[^\s"']+)/g, "[path]")
    .replace(/\b(password|secret|token|api[_-]?key|credential)s?\b[:=\s]*\S*/gi, "[redacted]");
  if (out.length > 200) out = out.slice(0, 200) + "…";
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The id for a record written before ids existed (~3800 of them on a live box).
 *
 * Byte-identical to the gateway's `decisionId`
 * (fittings/seed/orchestrator/lib/routing-telemetry.mjs) so a record keeps the same
 * handle whichever side computes it - duplicated only because that module lives
 * inside a fitting the app cannot import. Pinned equal by
 * tests/decisions-verdict.test.ts.
 *
 * `seq` is the record's position in the file, and it is what stops a verdict from
 * landing on two rows: a misroute appends a SECOND full copy of a decision carrying
 * the same timestamp, digest and target (462 of 3789 live rows are these follow-ups).
 */
function deriveDecisionId(r: Record<string, unknown>, seq?: number): string {
  const parts = [
    str(r.at) ?? "",
    str(r.promptDigest) ?? str(r.messageDigest) ?? "",
    str(r.targetId) ?? str(r.target) ?? "",
    seq == null ? "" : String(seq)
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Classify a record even when it carries no explicit `kind`: a placement record
// is the one with channel+mode, a routed classification has taskType/role.
function classifyKind(r: Record<string, unknown>): string {
  const kind = str(r.kind);
  if (kind) return kind;
  if (str(r.channel) && str(r.mode)) return "placement";
  if (str(r.taskType) || str(r.role)) return "route";
  return "decision";
}

// Compose a safe, human one-liner from whitelisted scalars for the non-dispatch
// records (which have no code-composed reason of their own). Never touches the
// raw message/prompt.
function composeReason(r: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const taskType = str(r.taskType);
  const tier = str(r.tier);
  const role = str(r.role);
  const runtime = str(r.runtime);
  const model = str(r.model);
  const channel = str(r.channel);
  const mode = str(r.mode);
  if (taskType) parts.push(tier ? `${taskType} · ${tier}` : taskType);
  if (role) parts.push(`→ ${role}`);
  if (runtime || model) parts.push([runtime, model].filter(Boolean).join("/"));
  if (channel) parts.push(mode ? `${channel}:${mode}` : channel);
  if (r.honored === false) parts.push("misrouted");
  return parts.length ? parts.join(" ") : null;
}

// Normalize one parsed record into the panel's view, or null if it is not an
// object. Pure + exported so the shaping is unit-tested without any fs.
export function normalizeDecision(raw: unknown, seq?: number): DecisionView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = classifyKind(r);
  // Trust a stored `reason` only for a dispatch record (code-composed, no user
  // text). Anything else is composed here from safe scalar fields.
  const rawReason = kind === "dispatch" ? str(r.reason) ?? composeReason(r) : composeReason(r);
  return {
    id: str(r.id) ?? deriveDecisionId(r, seq),
    at: str(r.at),
    kind,
    duty: str(r.duty),
    level: num(r.level),
    runtime: str(r.runtime),
    model: str(r.model),
    effort: str(r.effort),
    tier: str(r.tier),
    taskType: str(r.taskType),
    via: str(r.via),
    classifierSkipped: typeof r.classifierSkipped === "boolean" ? r.classifierSkipped : null,
    // The gateway/placement records name the engine as `targetId`; the dispatcher
    // leaves it implicit (target lives on the duty cell), so fall back cleanly.
    target: str(r.target) ?? str(r.targetId),
    reason: sanitizeReason(rawReason),
    messageDigest: str(r.messageDigest) ?? str(r.promptDigest),
    // Writers name this differently by lane (the channel calls it a thread), so
    // accept both spellings rather than forcing one at every write site.
    sessionId: str(r.sessionId) ?? str(r.session_id) ?? str(r.thread) ?? str(r.threadId),
    sessionTitle: sanitizeTitle(str(r.sessionTitle) ?? str(r.threadTitle))
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_DECISIONS_LIMIT;
  return Math.max(1, Math.min(MAX_DECISIONS_LIMIT, Math.trunc(limit as number)));
}

// Read the last `limit` decisions from a composition's decisions log, NEWEST
// FIRST. A missing log (no session has routed yet) yields []. Unparseable lines
// are skipped, never surfaced - a corrupt tail never breaks the panel.
export async function readDecisionsTail(
  compositionDir: string,
  limit: number = DEFAULT_DECISIONS_LIMIT
): Promise<DecisionView[]> {
  const capped = clampLimit(limit);
  const file = path.join(compositionDir, DECISIONS_REL);
  const { exists, text } = await readFileTolerant(file);
  if (!exists || text.trim().length === 0) return [];

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const views: DecisionView[] = [];
  // Walk from the end so we stop once we have `capped` well-formed records even
  // if the log is very long.
  for (let i = lines.length - 1; i >= 0 && views.length < capped; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // `i` is the record's line index in the file - the disambiguator a derived id
    // needs so a misroute's duplicate copy is a DIFFERENT decision. Stable as long
    // as the log is append-only, which it is.
    const view = normalizeDecision(parsed, i);
    if (view) views.push(view);
  }
  return views;
}
