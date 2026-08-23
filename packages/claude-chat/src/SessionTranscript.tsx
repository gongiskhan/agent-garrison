import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { filePathMarkedExtension } from "./host-rewrite";
import { installSafeMarkdownRenderer, loadHostMap } from "./markdown-safety";
import {
  collectRelatedTasks,
  groupSessionTurns,
  hasVisibleSessionActivity,
  isSessionEvent,
  latestBlocksByToolUse,
  mergeSessionEvents,
  presentSessionTurn,
  sessionActivityBeats,
  sessionEventText,
  sessionThinkingSummary,
  sessionToolSummary,
  type FailureInfo,
  type PermissionAnswer,
  type PermissionDecision,
  type RelatedTask,
  type SessionBlock,
  type SessionEvent,
  type SessionImage,
} from "./journal";

// Rich activity-journal renderer. Claude/Agent SDK JSONL is today's producer,
// but the block model is deliberately runtime-neutral so future runtimes can
// feed the same text/thinking/tool/progress/related-task surface.

const md = new Marked({ breaks: true, gfm: true });
installSafeMarkdownRenderer(md);
// Absolute paths in prose (e.g. a screenshot the operative wrote) render inline.
md.use({ extensions: [filePathMarkedExtension()] });

type StreamStatus = "connecting" | "streaming" | "ended" | "unavailable";

export interface SessionStreamProps {
  url: string;
  live?: boolean;
  /** Optional compact label when this stream is opened as a related task. */
  title?: string;
  /** The surrounding ClaudeChat owns the page's stable live region. Standalone
   * transcript hosts leave this enabled so their working state is announced. */
  announceLiveUpdates?: boolean;
}

export interface SessionEventTimelineProps {
  events: SessionEvent[];
  live?: boolean;
  className?: string;
  /** Host chat renderer for full parity (highlighted/copyable code cards). The
   * safe standalone transcript renderer remains the default. */
  renderMarkdown?: (text: string) => string;
  /** Chat-owned answer seam. Standalone transcript viewers omit it and retain a
   * complete, read-only record of pending permission prompts. */
  onPermissionDecision?: (answer: PermissionAnswer) => Promise<void>;
  /** The exact parent turn generation that may still accept a permission
   * decision. A pending block from any other/terminal generation stays visible
   * as history but never renders actionable controls. */
  permissionGenerationId?: string;
}

function displayJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Not provided";
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function permissionText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function permissionSuggestionDestinations(suggestions: unknown[]): string[] {
  const destinations = new Set<string>();
  for (const suggestion of suggestions) {
    if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) continue;
    const destination = permissionText((suggestion as Record<string, unknown>).destination);
    if (destination) destinations.add(destination);
  }
  return [...destinations];
}

function TextBlock({
  text,
  role,
  renderMarkdown = (value) => md.parse(value) as string,
}: {
  text: string;
  role: string;
  renderMarkdown?: (text: string) => string;
}) {
  // Long user prompts (e.g. a seeded kickoff) collapse to their first line.
  if (role === "user" && text.length > 280) {
    const head = text.slice(0, 140).split("\n")[0];
    return (
      <details className="cc-session-longtext">
        <summary>{head}…</summary>
        <div className="cc-session-md cc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      </details>
    );
  }
  return <div className="cc-session-md cc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text || "") }} />;
}

/** Opens while an activity is live, then collapses on its completed transition. */
function ActivityDetails({
  active,
  className,
  id,
  summary,
  children,
}: {
  active: boolean;
  className: string;
  id?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(active);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active !== wasActive.current) {
      setOpen(active);
      wasActive.current = active;
    }
  }, [active]);
  return (
    <details
      id={id}
      className={`${className}${active ? " is-live" : " is-complete"}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/** A detail this short reads as the row's own subtitle; longer needs its own line. */
const NOTICE_INLINE_CHARS = 90;

function elapsedLabel(elapsedMs: number | null | undefined): string | null {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)}ms`;
  const seconds = Math.round(elapsedMs / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function toolAnchorId(toolUseId: string | null | undefined): string | undefined {
  if (!toolUseId) return undefined;
  return `cc-tool-${toolUseId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function ToolBlock({
  block,
  result,
  progress,
  live,
  onImage,
}: {
  block: SessionBlock;
  result: SessionBlock | undefined;
  progress: SessionBlock | undefined;
  live: boolean;
  onImage: (image: SessionImage, label: string) => void;
}) {
  const hint = sessionToolSummary(block);
  const progressDone = /^(?:complete|completed|done|success|succeeded|failed|error|cancelled|canceled)$/i.test(String(progress?.status ?? ""));
  const active = live && !result && !progressDone;
  const output = result ? (result.text ?? "") : (progress?.text ?? "");
  const elapsed = elapsedLabel(progress?.elapsedMs);
  const status = result?.isError ? "failed" : result ? "done" : active ? "running" : progress?.status || "pending";
  const isCommand = /(?:^|[.:/])(bash|shell|exec|exec_command)$/i.test(block.name ?? "");
  return (
    <div className="cc-session-toolwrap">
      <ActivityDetails
        active={active}
        className={`cc-session-tool${isCommand ? " cc-session-command" : ""}`}
        id={toolAnchorId(block.toolUseId)}
        summary={
          <>
            <span className="cc-session-tool-ico" aria-hidden="true" />
            <b className="cc-session-tool-name" title={block.name || "Tool"}>{block.name || "Tool"}</b>
            {hint && <span className="cc-session-tool-hint">{hint}</span>}
            <span className={`cc-session-state ${result?.isError ? "error" : active ? "live" : ""}`}>
              {active && <span className="cc-session-live-dot" aria-hidden="true" />}
              {status}{elapsed ? ` · ${elapsed}` : ""}
            </span>
          </>
        }
      >
        <div className="cc-session-toolbody">
          {Boolean(block.input) && (
            <div>
              <span className="cc-session-section-label">Input</span>
              <pre className="cc-session-pre">{displayJsonValue(block.input)}</pre>
            </div>
          )}
          {output && (
            <div>
              <span className="cc-session-section-label">{active ? "Live output" : "Result"}</span>
              <pre
                className={`cc-session-pre cc-session-result${active ? " is-live" : ""}`}
              >
                {output}
              </pre>
            </div>
          )}
          {active && !output && <div className="cc-session-awaiting">Waiting for output…</div>}
          {(result?.images ?? []).map((image, index) => {
            const label = `${block.name ?? "tool"} result image ${index + 1}`;
            return (
              <button
                key={`${image.mediaType}:${index}`}
                type="button"
                className="cc-session-imgbtn"
                onClick={() => onImage(image, label)}
              >
                <img
                  className="cc-session-img"
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={label}
                  loading="lazy"
                />
                <span>Open {label}</span>
              </button>
            );
          })}
        </div>
      </ActivityDetails>
    </div>
  );
}

function ThinkingBlock({ block, active }: { block: SessionBlock; active: boolean }) {
  const summary = sessionThinkingSummary(block.text);
  return (
    <ActivityDetails
      active={active}
      className="cc-session-thinking"
      summary={
        <>
          <span>{active ? "Thinking" : "Thought"}</span>
          <span className="cc-session-thinking-hint">{summary}</span>
          {active && <span className="cc-session-live-dot" aria-hidden="true" />}
        </>
      }
    >
      <pre className="cc-session-pre">{block.text}</pre>
    </ActivityDetails>
  );
}

function permissionDecisionLabel(decision: PermissionDecision | undefined): string {
  if (decision === "allow_once") return "Allowed once";
  if (decision === "allow_always") return "Always allowed";
  if (decision === "deny") return "Denied";
  return "Resolved";
}

function PermissionBlock({
  block,
  onPermissionDecision,
  activeGenerationId,
}: {
  block: SessionBlock;
  onPermissionDecision?: (answer: PermissionAnswer) => Promise<void>;
  activeGenerationId?: string;
}) {
  const headingId = React.useId();
  const feedbackId = React.useId();
  const completenessId = React.useId();
  const requestId = permissionText(block.requestId);
  const generationId = permissionText(block.generationId);
  const status = block.status === "pending" || block.status === "resolved" || block.status === "cancelled"
    ? block.status
    : null;
  const displayName = permissionText(block.displayName) || permissionText(block.name) || "tool";
  const title = permissionText(block.title) || `Allow ${displayName}?`;
  const description = permissionText(block.description);
  const blockedPath = permissionText(block.blockedPath);
  const reason = permissionText(block.reason);
  const suggestions = Array.isArray(block.suggestions) ? block.suggestions : [];
  const suggestionDestinations = permissionSuggestionDestinations(suggestions);
  const hasSuggestions = suggestions.length > 0;
  const inputComplete = block.inputComplete === true;
  const suggestionsComplete = block.suggestionsComplete === true;
  const canAlwaysAllow = inputComplete && suggestionsComplete && hasSuggestions;
  const belongsToActiveGeneration = Boolean(
    activeGenerationId && generationId && activeGenerationId === generationId
  );
  const canSubmit = status === "pending" && belongsToActiveGeneration && Boolean(
    requestId && generationId && onPermissionDecision
  );
  const [submitting, setSubmitting] = useState<PermissionDecision | null>(null);
  const [submitted, setSubmitted] = useState<PermissionDecision | null>(null);
  const [failed, setFailed] = useState<{ decision: PermissionDecision; message: string } | null>(null);
  const attemptRef = useRef(0);
  const decisionLockedRef = useRef(false);

  useEffect(() => {
    attemptRef.current += 1;
    setSubmitting(null);
    setSubmitted(null);
    setFailed(null);
    decisionLockedRef.current = false;
  }, [requestId, generationId, status, block.decision, activeGenerationId]);

  const decide = async (decision: PermissionDecision) => {
    if (!canSubmit || decisionLockedRef.current || submitting || submitted || !onPermissionDecision) return;
    if (decision === "allow_once" && !inputComplete) return;
    if (decision === "allow_always" && !canAlwaysAllow) return;
    const attempt = ++attemptRef.current;
    decisionLockedRef.current = true;
    setSubmitting(decision);
    setFailed(null);
    try {
      await onPermissionDecision({ requestId, generationId, decision });
      if (attempt !== attemptRef.current) return;
      setSubmitted(decision);
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      decisionLockedRef.current = false;
      const detail = error instanceof Error && error.message.trim()
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 180)
        : "Unknown error";
      setFailed({ decision, message: `Could not send the decision: ${detail}` });
    } finally {
      if (attempt === attemptRef.current) setSubmitting(null);
    }
  };

  const scope = block.decision === "allow_always"
    ? "Future matching requests, using the saved changes below"
    : status === "pending" && hasSuggestions && suggestionsComplete
      ? "Allow once: this request · Always allow: future matching requests"
      : status === "pending" && !suggestionsComplete
        ? "Allow once: this request · Persistent scope unavailable"
      : "This request only";
  const completenessMessage = !inputComplete
    ? status === "pending"
      ? "Approval unavailable because the full request details cannot be shown. You can still deny this request."
      : "Full request details were not retained, so this historical decision cannot be independently reviewed."
    : !suggestionsComplete
      ? status === "pending"
        ? "Always allow is unavailable because the full persistent permission changes cannot be shown. You can allow once or deny."
        : "Full persistent permission changes were not retained for this historical request."
      : "";
  const statusLabel = status === "pending"
    ? onPermissionDecision && !belongsToActiveGeneration
      ? "No longer active"
      : !inputComplete
      ? "Approval unavailable"
      : submitted
      ? "Awaiting confirmation"
      : "Awaiting your decision"
    : status === "cancelled"
      ? "Cancelled"
      : status === "resolved"
        ? permissionDecisionLabel(block.decision)
        : "Unavailable";
  const buttonLabel = (decision: PermissionDecision, label: string) =>
    failed?.decision === decision ? `Retry ${label}` : label;

  return (
    <section
      className={`cc-session-permission is-${status ?? "invalid"}`}
      data-permission-request-id={requestId || undefined}
      data-permission-generation-id={generationId || undefined}
      aria-labelledby={headingId}
    >
      <div className="cc-session-permission-head">
        <span className="cc-session-permission-kicker">Permission request</span>
        <span className={`cc-session-permission-status is-${status ?? "invalid"}`}>{statusLabel}</span>
      </div>
      <h3 id={headingId}>{title}</h3>
      {description && <p className="cc-session-permission-description">{description}</p>}
      <dl className="cc-session-permission-facts">
        <div><dt>Tool</dt><dd>{displayName}</dd></div>
        <div><dt>Scope</dt><dd>{scope}</dd></div>
        <div><dt>Blocked path</dt><dd>{blockedPath || "Not reported by the runtime"}</dd></div>
        {reason && <div><dt>Reason</dt><dd>{reason}</dd></div>}
      </dl>
      <div className="cc-session-permission-input">
        <span className="cc-session-section-label">
          {inputComplete ? "Exact proposed tool input" : "Available partial tool input"}
        </span>
        <pre className="cc-session-pre">{displayJsonValue(block.input)}</pre>
      </div>
      {hasSuggestions && (
        <div className="cc-session-permission-suggestions">
          <span className="cc-session-section-label">
            {suggestionsComplete ? "Exact changes saved by Always allow" : "Available partial persistent changes"}
          </span>
          <p>These permission changes would apply to future matching requests.</p>
          <dl className="cc-session-permission-save-facts">
            <div>
              <dt>Permission destination</dt>
              <dd>{suggestionDestinations.length ? suggestionDestinations.join(", ") : "Not reported by the runtime"}</dd>
            </div>
          </dl>
          {suggestions.map((suggestion, index) => (
            <pre className="cc-session-pre" key={index}>{displayJsonValue(suggestion)}</pre>
          ))}
        </div>
      )}
      {completenessMessage && (
        <p id={completenessId} className="cc-session-permission-warning">{completenessMessage}</p>
      )}
      {status === "pending" && !onPermissionDecision && (
        <p className="cc-session-permission-readonly">Return to chat to answer this permission request.</p>
      )}
      {status === "pending" && onPermissionDecision && (!requestId || !generationId) && (
        <p className="cc-session-permission-readonly">This request is missing its secure answer coordinates and cannot be answered here.</p>
      )}
      {status === "pending" && onPermissionDecision && requestId && generationId && !belongsToActiveGeneration && (
        <p className="cc-session-permission-readonly">This permission request is no longer active and cannot be answered.</p>
      )}
      {!status && (
        <p className="cc-session-permission-readonly">This request has an invalid status and cannot be answered here.</p>
      )}
      {status === "pending" && canSubmit && (
        <div
          className="cc-session-permission-actions"
          role="group"
          aria-label={`Answer permission request for ${displayName}`}
          aria-describedby={[
            completenessMessage ? completenessId : "",
            failed || submitted ? feedbackId : "",
          ].filter(Boolean).join(" ") || undefined}
        >
          <button
            type="button"
            className="cc-session-permission-deny"
            disabled={Boolean(submitting || submitted)}
            onClick={() => void decide("deny")}
          >
            {submitting === "deny" ? "Denying…" : buttonLabel("deny", "Deny")}
          </button>
          <button
            type="button"
            disabled={Boolean(submitting || submitted || !inputComplete)}
            title={!inputComplete ? "Unavailable because the full request details cannot be shown" : undefined}
            onClick={() => void decide("allow_once")}
          >
            {submitting === "allow_once" ? "Allowing…" : buttonLabel("allow_once", "Allow once")}
          </button>
          {canAlwaysAllow && (
            <button
              type="button"
              className="cc-session-permission-always"
              disabled={Boolean(submitting || submitted)}
              onClick={() => void decide("allow_always")}
            >
              {submitting === "allow_always" ? "Allowing…" : buttonLabel("allow_always", "Always allow")}
            </button>
          )}
        </div>
      )}
      {failed && <p id={feedbackId} className="cc-session-permission-error">{failed.message}</p>}
      {submitted && <p id={feedbackId} className="cc-session-permission-submitted">Answer sent. Waiting for durable confirmation…</p>}
    </section>
  );
}

function finiteEpochTime(value: unknown): { dateTime: string; label: string } | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return {
      dateTime: date.toISOString(),
      label: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date),
    };
  } catch {
    return null;
  }
}

function compactNoticeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function errorLabel(block: SessionBlock): string {
  if (block.source === "runtime") return "Runtime error";
  if (block.source === "transport") return "Connection error";
  if (block.source === "gateway") return "Gateway error";
  if (block.source === "web") return "Web error";
  if (block.source === "session") return "Session error";
  if (block.source === "result") return "Execution error";
  if (block.source === "assistant") return "Request error";
  return "Error";
}

function routeSummary(block: SessionBlock): string {
  const attribution = block.attribution ?? {};
  const signature = attribution.spawnSignature && typeof attribution.spawnSignature === "object"
    ? attribution.spawnSignature
    : {};
  const field = (key: string): string => compactNoticeText(attribution[key] ?? signature[key]);
  const target = field("route") || field("target");
  const runtime = field("runtime");
  const provider = field("provider");
  const model = field("model");
  const destination = [runtime, provider, model].filter(Boolean).join(" / ");
  const selected = [target, destination].filter(Boolean).join(" · ");
  const requested = compactNoticeText(block.requestedModel);
  const disposition = compactNoticeText(attribution.sessionDisposition);
  const lifecycle = disposition === "new"
    ? "Started a new session."
    : disposition === "resumed"
      ? "Resumed the session."
      : disposition === "warm"
        ? "Continued the current session."
        : "";
  // What the turn is actually spending: the effort dial (and whether the runtime
  // confirmed it), the duty being run, and the account paying for it. The rail
  // carries the full record one click away, but a reader should not have to open
  // it to learn that a reply ran at low effort on a particular plan.
  const effort = field("effort");
  // A dial the runtime never confirmed is not the same claim as one it applied,
  // and saying so costs four words.
  const effortClause = !effort
    ? ""
    : attribution.effortApplied === false
      ? ` at ${effort} effort (refused)`
      : attribution.effortApplied === true
        ? ` at ${effort} effort`
        : ` at ${effort} effort (unverified)`;
  const duty = field("duty");
  const level = typeof attribution.level === "number" && Number.isFinite(attribution.level) && attribution.level > 0
    ? `L${Math.trunc(attribution.level)}`
    : "";
  const dutyNote = [duty, level].filter(Boolean).join(" ");
  const account = field("account");
  const rest = [dutyNote && `duty ${dutyNote}`, account && `account ${account}`].filter(Boolean).join(", ");
  const tail = `${effortClause}${rest ? `, ${rest}` : ""}`;

  if (requested && model && requested !== model) {
    return [lifecycle, `Requested ${requested}; using ${model}${target ? ` via ${target}` : ""}${tail}.`].filter(Boolean).join(" ");
  }
  const route = selected
    ? `Using ${selected}${tail}.`
    : compactNoticeText(block.text) || "Route resolved.";
  return [lifecycle, route].filter(Boolean).join(" ");
}

function retrySummary(block: SessionBlock): string {
  if (block.kind === "model_fallback") {
    const from = compactNoticeText(block.fromModel);
    const to = compactNoticeText(block.toModel);
    if (from && to) return `Model changed from ${from} to ${to}.`;
  }
  const parts: string[] = [];
  if (typeof block.attempt === "number" && Number.isFinite(block.attempt)) {
    const attempt = Math.max(0, Math.trunc(block.attempt));
    const maximum = typeof block.maxAttempts === "number" && Number.isFinite(block.maxAttempts)
      ? Math.max(0, Math.trunc(block.maxAttempts))
      : null;
    parts.push(maximum !== null ? `attempt ${attempt} of ${maximum}` : `attempt ${attempt}`);
  }
  if (typeof block.delayMs === "number" && Number.isFinite(block.delayMs) && block.delayMs >= 0) {
    const seconds = Math.max(0, Math.round(block.delayMs / 100) / 10);
    parts.push(`in ${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  }
  const text = compactNoticeText(block.text);
  return [text, parts.join(" · ")].filter(Boolean).join(" ");
}

function terminalSummary(block: SessionBlock): string {
  const reportedErrors = Array.isArray(block.errors)
    ? block.errors.map(compactNoticeText).filter(Boolean).join("; ")
    : "";
  const candidates = [block.reason, block.terminalReason, block.stopReason, reportedErrors, block.subtype];
  return candidates.map(compactNoticeText).find(Boolean) ?? "";
}

function SessionNotice({
  block,
  renderMarkdown,
  renderTerminalResult = false,
  terminalResultDuplicated = false,
}: {
  block: SessionBlock;
  renderMarkdown?: (text: string) => string;
  renderTerminalResult?: boolean;
  terminalResultDuplicated?: boolean;
}) {
  let tone = "info";
  let label = "Notice";
  let detail = compactNoticeText(block.text);
  let reset: { dateTime: string; label: string } | null = null;
  let timePrefix = "Resets";

  if (block.type === "error") {
    tone = "danger";
    label = errorLabel(block);
    reset = finiteEpochTime(block.retryAt);
    timePrefix = "Retry after";
  } else if (block.type === "retry" || block.type === "status") {
    const fallback = block.kind === "model_fallback" || block.subtype === "model_refusal_fallback";
    tone = fallback ? "route" : "warning";
    label = fallback ? "Route changed" : "Retrying request";
    detail = retrySummary(block) || (fallback ? "The request moved to a fallback model." : "The request will retry automatically.");
  } else if (block.type === "rate_limit") {
    const rejected = block.status === "rejected" || block.overageStatus === "rejected";
    const overageNeedsAttention = Boolean(block.overageStatus && block.overageStatus !== "allowed");
    tone = rejected ? "danger" : "warning";
    label = rejected ? "Rate limit reached" : "Rate limit warning";
    detail = compactNoticeText(block.text) || (block.rateLimitType ? `${block.rateLimitType.replace(/_/g, " ")} usage window.` : "Usage is nearing its limit.");
    reset = finiteEpochTime(block.status === "rejected"
      ? block.resetsAt
      : overageNeedsAttention ? block.overageResetsAt : block.resetsAt);
  } else if (block.type === "route") {
    tone = "route";
    label = "Route selected";
    detail = routeSummary(block);
  } else if (block.type === "turn_end") {
    const status = String(block.status ?? "completed");
    tone = status === "error" ? "danger" : status === "cancelled" ? "warning" : "complete";
    label = status === "error" ? "Response failed" : status === "cancelled" ? "Response stopped" : "Response complete";
    detail = terminalSummary(block);
  }

  const meta =
    block.type === "error" && (block.code || block.requestId)
      ? [compactNoticeText(block.code), block.requestId ? `request ${compactNoticeText(block.requestId)}` : ""]
          .filter(Boolean)
          .join(" · ")
      : block.type === "retry" && typeof block.httpStatus === "number"
        ? `HTTP ${block.httpStatus}`
        : null;
  const terminalText =
    block.type === "turn_end" &&
    renderTerminalResult &&
    !terminalResultDuplicated &&
    typeof block.result === "string" &&
    block.result.trim()
      ? block.result
      : null;
  // Nothing to reveal means nothing to collapse: a bare label would open onto an
  // empty panel, which is worse than a plain row.
  const hasBody = Boolean(reset || terminalText || (detail && detail.length > NOTICE_INLINE_CHARS));

  const head = (
    <>
      <span className="cc-session-notice-label">{label}</span>
      {detail && <span className="cc-session-notice-lede">{detail}</span>}
      {meta && <span className="cc-session-notice-meta">{meta}</span>}
    </>
  );

  const body = (
    <div className="cc-session-notice-body">
      {detail && detail.length > NOTICE_INLINE_CHARS && <div className="cc-session-notice-detail">{detail}</div>}
      {reset && (
        <div className="cc-session-notice-reset">
          {timePrefix} <time dateTime={reset.dateTime}>{reset.label}</time>
        </div>
      )}
      {terminalText && (
        <div className="cc-session-terminal-text cc-session-markdown">
          <TextBlock text={terminalText} role="assistant" renderMarkdown={renderMarkdown} />
        </div>
      )}
    </div>
  );

  const className = `cc-session-notice cc-session-notice-${tone}${block.type === "error" ? " cc-session-error" : ""}`;
  if (!hasBody) {
    return (
      <div className={`${className} is-flat`}>
        <div className="cc-session-notice-head">{head}</div>
      </div>
    );
  }
  // Errors open on arrival - a failure the reader has to click to see is a failure
  // they will miss. Everything else is a one-line trace they can drill into.
  return (
    <details className={className} open={tone === "danger"}>
      <summary className="cc-session-notice-head">{head}</summary>
      {body}
    </details>
  );
}

/** Typed transport/admission failures use the same non-assertive visual language
 * as durable canonical error blocks. The surrounding chat owns announcements. */
export function FailureNotice({ failure }: { failure: FailureInfo }) {
  return <SessionNotice block={{ type: "error", ...failure }} />;
}

function ActivityTimeline({
  events,
  includeText,
  omittedTextEventIndex,
  live,
  activeThinkingBlock,
  resultsByToolUse,
  progressByToolUse,
  onImage,
  renderMarkdown,
  onPermissionDecision,
  permissionGenerationId,
  renderTerminalResult = false,
}: {
  events: SessionEvent[];
  includeText: boolean;
  omittedTextEventIndex: number | null;
  live: boolean;
  activeThinkingBlock: SessionBlock | null;
  resultsByToolUse: Map<string, SessionBlock>;
  progressByToolUse: Map<string, SessionBlock>;
  onImage: (image: SessionImage, label: string) => void;
  renderMarkdown?: (text: string) => string;
  onPermissionDecision?: (answer: PermissionAnswer) => Promise<void>;
  permissionGenerationId?: string;
  renderTerminalResult?: boolean;
}) {
  const beats = sessionActivityBeats(events);
  return (
    <div className={`cc-session-activity${live ? " is-live" : ""}`}>
      {beats.map((beat) => {
        const sourceEvent = events[beat.eventIndex];
        // A streamed revision replaces `sourceEvent` in-place. Key from its
        // stable identity (not the revision or changing Markdown text) so React
        // preserves the outer node while an incomplete fence becomes complete.
        const eventKey = sourceEvent?.id ?? `event-${beat.eventIndex}`;
        const key = `${eventKey}:${beat.blockIndex}:${beat.type}`;
        if (beat.type === "text") {
          if (!includeText || beat.eventIndex === omittedTextEventIndex || !beat.text.trim()) return null;
          return (
            <div
              key={key}
              className="cc-session-interim-text cc-session-markdown"
              data-session-event-id={sourceEvent?.id ?? undefined}
              data-session-block-index={beat.blockIndex}
            >
              <TextBlock text={beat.text} role="assistant" renderMarkdown={renderMarkdown} />
            </div>
          );
        }
        if (beat.type === "error") {
          return (
            <div
              key={key}
              data-session-event-id={sourceEvent?.id ?? undefined}
              data-session-block-index={beat.blockIndex}
            >
              <SessionNotice block={beat.block} />
            </div>
          );
        }
        const block = beat.block;
        if (["retry", "rate_limit", "route", "turn_end", "status"].includes(beat.type)) {
          const terminalResultDuplicated = block.type === "turn_end" && typeof block.result === "string" && events.some(
            (event) => sessionEventText(event).trim() === block.result!.trim()
          );
          return (
            <div
              key={key}
              data-session-event-id={sourceEvent?.id ?? undefined}
              data-session-block-index={beat.blockIndex}
            >
              <SessionNotice
                block={block}
                renderMarkdown={renderMarkdown}
                renderTerminalResult={renderTerminalResult}
                terminalResultDuplicated={terminalResultDuplicated}
              />
            </div>
          );
        }
        if (beat.type === "thinking") {
          return <ThinkingBlock key={key} block={block} active={live && activeThinkingBlock === block} />;
        }
        if (beat.type === "permission_request") {
          return (
            <PermissionBlock
              key={key}
              block={block}
              onPermissionDecision={onPermissionDecision}
              activeGenerationId={live ? permissionGenerationId : undefined}
            />
          );
        }
        return (
          <ToolBlock
            key={key}
            block={block}
            result={block.toolUseId ? resultsByToolUse.get(block.toolUseId) : undefined}
            progress={block.toolUseId ? progressByToolUse.get(block.toolUseId) : undefined}
            live={live}
            onImage={onImage}
          />
        );
      })}
    </div>
  );
}

/** Inline, channel-neutral activity renderer for one chat turn. It shares the
 * transcript's Markdown/thinking/tool primitives, but deliberately renders the
 * canonical timeline directly in the assistant bubble: tool results are looked
 * up across later user-shaped events and attach to their original tool card. */
export function SessionEventTimeline({
  events,
  live = false,
  className = "",
  renderMarkdown,
  onPermissionDecision,
  permissionGenerationId,
}: SessionEventTimelineProps) {
  const [modalImage, setModalImage] = useState<{ image: SessionImage; label: string } | null>(null);
  const [, setHostMapReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadHostMap().then(() => { if (alive) setHostMapReady(true); });
    return () => { alive = false; };
  }, []);
  const assistantEvents = useMemo(
    () => events.filter((event) => event.role === "assistant" && !event.toolResultsOnly),
    [events]
  );
  const resultsByToolUse = useMemo(() => latestBlocksByToolUse(events, "tool_result"), [events]);
  const progressByToolUse = useMemo(() => latestBlocksByToolUse(events, "tool_progress"), [events]);
  const activeThinkingBlock = useMemo(() => {
    if (!live) return null;
    let latest: SessionBlock | null = null;
    for (const event of events) {
      for (const block of event.blocks ?? []) {
        if (block.type === "related_task") continue;
        latest = block;
      }
    }
    return latest?.type === "thinking" ? latest : null;
  }, [events, live]);

  return (
    <div
      className={`cc-session-inline${className ? ` ${className}` : ""}`}
    >
      <ActivityTimeline
        events={assistantEvents}
        includeText
        omittedTextEventIndex={null}
        live={live}
        activeThinkingBlock={activeThinkingBlock}
        resultsByToolUse={resultsByToolUse}
        progressByToolUse={progressByToolUse}
        onImage={(image, label) => setModalImage({ image, label })}
        renderMarkdown={renderMarkdown}
        onPermissionDecision={onPermissionDecision}
        permissionGenerationId={permissionGenerationId}
        renderTerminalResult
      />
      {modalImage && <ImageModal image={modalImage.image} label={modalImage.label} onClose={() => setModalImage(null)} />}
    </div>
  );
}

function InterimDetails({ count, openByDefault, children }: { count: number; openByDefault: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(openByDefault);
  return (
    <details className="cc-session-interim" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>Interim activity</span>
        <span className="cc-session-interim-count">{count} {count === 1 ? "item" : "items"}</span>
      </summary>
      {children}
    </details>
  );
}

function RelatedTasks({ tasks, onOpen }: { tasks: RelatedTask[]; onOpen: (task: RelatedTask) => void }) {
  const running = tasks.filter((task) => task.status === "running").length;
  if (!tasks.length) return null;
  return (
    <ActivityDetails
      active={running > 0}
      className="cc-related"
      summary={
        <>
        <span>Parallel and related tasks</span>
        <span className="cc-related-count">{running ? `${running} live · ` : ""}{tasks.length}</span>
        </>
      }
    >
      <div className="cc-related-list">
        {tasks.map((task) => (
          <div key={task.key} className="cc-related-task">
            <span className={`cc-related-status ${task.status}`} aria-label={task.status} />
            <span className="cc-related-main">
              <b>{task.label}</b>
              <span>{[task.detail, task.taskId ? task.taskId.slice(0, 12) : null].filter(Boolean).join(" · ")}</span>
              {task.text && <span className="cc-related-progress">{task.text}</span>}
            </span>
            {task.streamUrl ? (
              <button type="button" onClick={() => onOpen(task)}>Open</button>
            ) : task.toolUseId ? (
              <button
                type="button"
                onClick={() => document.getElementById(toolAnchorId(task.toolUseId) ?? "")?.scrollIntoView({ behavior: "smooth", block: "center" })}
              >
                Locate
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ActivityDetails>
  );
}

function useModalLifecycle(
  dialogRef: React.RefObject<HTMLDialogElement>,
  initialFocusRef: React.RefObject<HTMLElement>
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    initialFocusRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, []);
}

function trapDialogTab(event: React.KeyboardEvent<HTMLDialogElement>, dialog: HTMLDialogElement | null) {
  if (event.key !== "Tab") return;
  const focusable = dialog?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable?.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function ImageModal({ image, label, onClose }: { image: SessionImage; label: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalLifecycle(dialogRef, closeRef);
  return (
    <dialog
      ref={dialogRef}
      className="cc-session-modal"
      aria-label={label}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => trapDialogTab(event, dialogRef.current)}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="cc-session-modal-card">
        <div className="cc-session-modal-head">
          <b>{label}</b>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={`Close ${label}`}>Close</button>
        </div>
        <img src={`data:${image.mediaType};base64,${image.data}`} alt={label} />
      </div>
    </dialog>
  );
}

function RelatedTaskModal({ task, onClose }: { task: RelatedTask; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalLifecycle(dialogRef, closeRef);
  return (
    <dialog
      ref={dialogRef}
      className="cc-related-view"
      aria-label={task.label}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => trapDialogTab(event, dialogRef.current)}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="cc-related-view-head">
        <b>{task.label}</b>
        <button ref={closeRef} type="button" onClick={onClose}>Close</button>
      </div>
      <SessionStream
        url={task.streamUrl!}
        live={task.status === "running"}
        title={task.detail ?? "Related task"}
        announceLiveUpdates={false}
      />
    </dialog>
  );
}

export function SessionStream({
  url,
  live = false,
  title: titleProp,
  announceLiveUpdates = true,
}: SessionStreamProps) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [title, setTitle] = useState<string | null>(titleProp ?? null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [retryToken, setRetryToken] = useState(0);
  const [, setHostMapReady] = useState(false);
  const [modalImage, setModalImage] = useState<{ image: SessionImage; label: string } | null>(null);
  const [relatedView, setRelatedView] = useState<RelatedTask | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const liveRef = useRef(live);
  const previousLiveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    const becameLive = live && !previousLiveRef.current;
    previousLiveRef.current = live;
    if (becameLive) setRetryToken((value) => value + 1);
  }, [live]);

  useEffect(() => {
    let alive = true;
    void loadHostMap().then(() => { if (alive) setHostMapReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setEvents([]);
    setTitle(titleProp ?? null);
    setStatus("connecting");
    setRelatedView(null);
    stickRef.current = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retryWhileLive = () => {
      if (!liveRef.current || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (liveRef.current) setRetryToken((value) => value + 1);
      }, 900);
    };
    const source = new EventSource(url);
    source.onmessage = (message) => {
      let payload: any;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload.type === "init") {
        setEvents(Array.isArray(payload.events) ? mergeSessionEvents([], payload.events.filter(isSessionEvent)) : []);
        if (payload.title) setTitle(String(payload.title));
        const nextStatus = payload.available === false ? "unavailable" : payload.live ? "streaming" : "ended";
        setStatus(nextStatus);
        if (payload.available === false) retryWhileLive();
      } else if (payload.type === "events") {
        if (payload.title) setTitle(String(payload.title));
        const incoming = Array.isArray(payload.events) ? payload.events.filter(isSessionEvent) : [];
        if (incoming.length) setEvents((current) => mergeSessionEvents(current, incoming));
      } else if (payload.type === "snapshot") {
        // Recovery can discover an event whose canonical position precedes rows
        // the browser already has. An append/upsert delta cannot express that
        // insertion (and cannot remove a recovered row that disappeared), so the
        // thread stream may send one authoritative, already-reconciled ordering.
        // Refuse malformed snapshots rather than accidentally clearing history.
        if (!Array.isArray(payload.events)) return;
        if (payload.title) setTitle(String(payload.title));
        setEvents(mergeSessionEvents([], payload.events.filter(isSessionEvent)));
      } else if (payload.type === "end") {
        setStatus((current) => (current === "unavailable" ? current : "ended"));
        source.close();
        retryWhileLive();
      }
    };
    source.onerror = () => {
      setStatus((current) => (current === "unavailable" ? current : "ended"));
      source.close();
      retryWhileLive();
    };
    return () => {
      source.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [url, titleProp, retryToken]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const resultsByToolUse = useMemo(() => latestBlocksByToolUse(events, "tool_result"), [events]);
  const progressByToolUse = useMemo(() => latestBlocksByToolUse(events, "tool_progress"), [events]);
  const streamLive = live && status === "streaming";
  const relatedTasks = useMemo(() => collectRelatedTasks(events, streamLive), [events, streamLive]);
  useEffect(() => {
    setRelatedView((selected) => {
      if (!selected) return selected;
      return relatedTasks.find((task) => task.key === selected.key) ?? selected;
    });
  }, [relatedTasks]);
  const visibleEvents = useMemo(
    () => events.filter((event) => event.role === "assistant"
      ? hasVisibleSessionActivity([event])
      : !event.toolResultsOnly && Boolean(sessionEventText(event).trim())),
    [events]
  );
  const turns = useMemo(() => groupSessionTurns(visibleEvents), [visibleEvents]);
  const activeThinkingBlock = useMemo(() => {
    if (!streamLive) return null;
    let last: SessionBlock | null = null;
    for (const event of events) {
      for (const block of event.blocks) {
        // Snapshot metadata belongs in the fan-out panel; it is not a new
        // chronological beat that should collapse a currently active thought.
        if (block.type === "related_task") continue;
        last = block;
      }
    }
    return last?.type === "thinking" ? last : null;
  }, [events, streamLive]);

  return (
    <div className="cc-session">
      <div className="cc-session-head">
        <span className="cc-session-head-title">{title ?? "Activity"}</span>
        {status === "connecting" && <span>connecting…</span>}
        {streamLive && <span className="cc-session-live"><span className="cc-session-live-dot" aria-hidden="true" />live</span>}
        {(status === "ended" || (!live && status === "streaming")) && <span>complete</span>}
        {status === "unavailable" && <span>transcript unavailable</span>}
      </div>
      <RelatedTasks tasks={relatedTasks} onOpen={(task) => setRelatedView(task)} />
      <div className="cc-session-scroll" ref={scrollRef} onScroll={onScroll}>
        {visibleEvents.length === 0 && (
          <div className="cc-session-empty">
            {status === "connecting"
              ? "Opening the activity journal…"
              : status === "unavailable"
                ? "No rich activity journal is available for this turn."
                : live
                  ? "Waiting for the first activity…"
                  : "No journal activity."}
          </div>
        )}
        {turns.map((turn, turnIndex) => {
          const turnLive = streamLive && turnIndex === turns.length - 1;
          const presentation = presentSessionTurn(turn, turnLive);
          const userText = turn.userEvents.map(sessionEventText).filter((text) => text.trim()).join("\n\n");
          const hasSettlementNotice = turn.assistantEvents.some((event) => event.blocks.some((block) =>
            block.type === "error" || block.type === "retry" || block.type === "route" || block.type === "turn_end" ||
            (block.type === "rate_limit" && (
              String(block.status ?? "").toLowerCase() !== "allowed" ||
              Boolean(block.overageStatus && String(block.overageStatus).toLowerCase() !== "allowed")
            )) ||
            (block.type === "status" && (block.subtype === "api_retry" || block.subtype === "model_refusal_fallback"))
          ));
          const interimCount = turn.assistantEvents.reduce((count, event, eventIndex) => {
            const textCount = eventIndex !== presentation.finalTextEventIndex && sessionEventText(event).trim() ? 1 : 0;
            const activityCount = event.blocks.filter((block) =>
              block.type === "thinking" || block.type === "tool_use" || block.type === "error" || block.type === "permission_request" ||
              block.type === "retry" || block.type === "route" || block.type === "turn_end" ||
              (block.type === "rate_limit" && (
                String(block.status ?? "").toLowerCase() !== "allowed" ||
                Boolean(block.overageStatus && String(block.overageStatus).toLowerCase() !== "allowed")
              )) ||
              (block.type === "status" && (block.subtype === "api_retry" || block.subtype === "model_refusal_fallback"))
            ).length;
            return count + textCount + activityCount;
          }, 0);
          return (
            <React.Fragment key={turn.key}>
              {userText && (
                <div className="cc-session-turn user">
                  <span className="cc-session-role">You</span>
                  <TextBlock text={userText} role="user" />
                </div>
              )}
              {(turn.assistantEvents.length > 0 || turnLive) && (
                <div className="cc-session-turn assistant">
                  <span className="cc-session-role">Assistant</span>
                  {!turnLive && presentation.primaryText && <TextBlock text={presentation.primaryText} role="assistant" />}
                  {turnLive && (
                    <>
                      <ActivityTimeline
                        events={turn.assistantEvents}
                        includeText
                        omittedTextEventIndex={null}
                        live
                        activeThinkingBlock={activeThinkingBlock}
                        resultsByToolUse={resultsByToolUse}
                        progressByToolUse={progressByToolUse}
                        onImage={(image, label) => setModalImage({ image, label })}
                        renderTerminalResult
                      />
                    </>
                  )}
                  {turnLive && !presentation.primaryText && interimCount === 0 && (
                    <div className="cc-session-awaiting" role={announceLiveUpdates ? "status" : undefined}>Working…</div>
                  )}
                  {!turnLive && interimCount > 0 && (
                    <InterimDetails count={interimCount} openByDefault={!presentation.primaryText || hasSettlementNotice}>
                      <ActivityTimeline
                        events={turn.assistantEvents}
                        includeText
                        omittedTextEventIndex={presentation.finalTextEventIndex}
                        live={false}
                        activeThinkingBlock={null}
                        resultsByToolUse={resultsByToolUse}
                        progressByToolUse={progressByToolUse}
                        onImage={(image, label) => setModalImage({ image, label })}
                      />
                    </InterimDetails>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      {modalImage && <ImageModal image={modalImage.image} label={modalImage.label} onClose={() => setModalImage(null)} />}
      {relatedView?.streamUrl && relatedView.streamUrl !== url && (
        <RelatedTaskModal task={relatedView} onClose={() => setRelatedView(null)} />
      )}
    </div>
  );
}
