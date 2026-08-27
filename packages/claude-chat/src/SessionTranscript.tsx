import * as React from "react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { filePathMarkedExtension } from "./host-rewrite";
import { installSafeMarkdownRenderer, loadHostMap } from "./markdown-safety";
import { PayloadOpenerContext } from "./payload-context";
import { railBadges } from "./run-context";
import type { RouteAttribution } from "./transport";
import {
  collectRelatedTasks,
  conversationActivity,
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
  stripHandoffFence,
  type ConversationActivity,
  type FailureInfo,
  type PermissionAnswer,
  type PermissionDecision,
  type RelatedTask,
  type SessionBlock,
  type SessionEvent,
  type SessionImage,
  isFanoutTool,
} from "./journal";

// Rich activity-journal renderer. Claude/Agent SDK JSONL is today's producer,
// but the block model is deliberately runtime-neutral so future runtimes can
// feed the same text/thinking/tool/progress/related-task surface.

const md = new Marked({ breaks: true, gfm: true });
installSafeMarkdownRenderer(md);
// Absolute paths in prose (e.g. a screenshot the operative wrote) render inline.
md.use({ extensions: [filePathMarkedExtension()] });

/**
 * The transcript's own Markdown seam: raw HTML escaped, links host-rewritten and
 * `garrison://` resolved, absolute file paths linked. Exported so a sibling
 * conversation surface (the payload viewer) renders prose through THIS renderer
 * instead of standing up a second Marked instance whose security posture would
 * then have to be kept in step with this one by hand.
 */
export function renderTranscriptMarkdown(text: string): string {
  return md.parse(text ?? "") as string;
}

type StreamStatus = "connecting" | "streaming" | "ended" | "unavailable";

/** Long enough for the eye to catch the row it landed on, short enough that it is
 * gone before the reader starts reading it. */
const FOCUS_FLASH_MS = 1200;
const FOCUS_FLASH_CLASS = "cc-focus-flash";

/**
 * Land a jump: once the event carrying `focusEventId` has rendered inside
 * `containerRef`, scroll it into view and flash it. The returned ref reads true
 * while the landing is still pending, so a LIVE stream can suppress its
 * stick-to-bottom until the jump has happened - without that the two fight and
 * the hit is scrolled off screen the instant it appears.
 *
 * An id that never renders is not an error: nothing scrolls, nothing flashes, and
 * the stream keeps behaving normally. The match is done by walking the stamped
 * nodes rather than through a selector, so an id carrying quotes or a colon (a
 * conversation id does) needs no escaping dance.
 */
function useFocusedEvent(
  containerRef: React.RefObject<HTMLElement | null>,
  focusEventId: string | undefined,
  renderedEvents: unknown
): React.MutableRefObject<boolean> {
  const pendingRef = useRef(Boolean(focusEventId));
  const lastIdRef = useRef(focusEventId);
  // A NEW focus target re-arms the landing (the same component instance is
  // re-pointed when the user clicks a second search hit). Mirrors the file's
  // existing render-phase `liveRef.current = live` pattern.
  if (lastIdRef.current !== focusEventId) {
    lastIdRef.current = focusEventId;
    pendingRef.current = Boolean(focusEventId);
  }
  useEffect(() => {
    if (!focusEventId || !pendingRef.current) return;
    const root = containerRef.current;
    if (!root) return;
    let target: HTMLElement | null = null;
    for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-session-event-id]"))) {
      if (node.getAttribute("data-session-event-id") === focusEventId) {
        target = node;
        break;
      }
    }
    if (!target) return;
    const landed = target;
    pendingRef.current = false;
    landed.scrollIntoView({ block: "center" });
    landed.classList.add(FOCUS_FLASH_CLASS);
    const timer = setTimeout(() => landed.classList.remove(FOCUS_FLASH_CLASS), FOCUS_FLASH_MS);
    return () => clearTimeout(timer);
  }, [focusEventId, renderedEvents]);
  return pendingRef;
}

export interface SessionStreamProps {
  url: string;
  live?: boolean;
  /** Optional compact label when this stream is opened as a related task. */
  title?: string;
  /** The surrounding ClaudeChat owns the page's stable live region. Standalone
   * transcript hosts leave this enabled so their working state is announced. */
  announceLiveUpdates?: boolean;
  /**
   * Land on one event instead of on live: after the stream renders, the element
   * stamped with this `data-session-event-id` is scrolled into view and flashed,
   * and the stick-to-bottom is suppressed for that landing (a jump that is
   * immediately scrolled away from is not a jump). Absent → exactly the previous
   * behaviour. An id no event carries is inert.
   */
  focusEventId?: string;
  /**
   * The HOST's word on whether this conversation is still being driven (a card
   * on Running, a thread with an active input). The stream derives its own
   * activity from the events; an explicit `false` here overrides that
   * derivation's spinners - a crashed launcher must not leave an eternal
   * "working" strip when the card beside it says stopped. Absent → trust the
   * derivation. Meaningless outside conversation streams.
   */
  conversationLive?: boolean;
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
  /** Scroll the event stamped with this `data-session-event-id` into view and
   * flash it once it has rendered. The inline timeline owns no scroller of its
   * own, so the jump walks up to whichever ancestor does. */
  focusEventId?: string;
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
  forceOpen = false,
  className,
  id,
  summary,
  children,
}: {
  active: boolean;
  /** Open regardless of live state and keep it open when live ends — a failed
   *  row's error IS its content; a collapsed failure reads as success. */
  forceOpen?: boolean;
  className: string;
  id?: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(active || forceOpen);
  const wasActive = useRef(active);
  const wasForced = useRef(forceOpen);
  useEffect(() => {
    if (active !== wasActive.current) {
      setOpen(active || forceOpen);
      wasActive.current = active;
    }
  }, [active, forceOpen]);
  useEffect(() => {
    if (forceOpen && !wasForced.current) {
      setOpen(true);
      wasForced.current = true;
    }
  }, [forceOpen]);
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

/**
 * ChatGPT-style reveal for LIVE prose. The pipeline delivers text in bursts
 * (the tee throttles, the SSE polls), so without this a fast model's paragraph
 * lands whole. The shown slice catches up at a bounded rate (~two-thirds of a
 * second per burst, floor ~120 chars/s) so the text TYPES in and can be read
 * as it arrives. A mount mid-stream shows everything already present (no
 * replay); a shrink (a stripped protocol tail) and a giant catch-up snap.
 */
function StreamingText({ text, renderMarkdown }: { text: string; renderMarkdown?: (value: string) => string }) {
  const [shownLength, setShownLength] = useState(text.length);
  const shownRef = useRef(text.length);
  if (shownRef.current > text.length) shownRef.current = text.length;
  useEffect(() => {
    const backlog = text.length - shownRef.current;
    if (backlog <= 0) {
      if (shownLength !== text.length) setShownLength(text.length);
      return;
    }
    if (backlog > 6000) {
      shownRef.current = text.length;
      setShownLength(text.length);
      return;
    }
    let raf = 0;
    const step = () => {
      const remaining = text.length - shownRef.current;
      if (remaining <= 0) return;
      shownRef.current = Math.min(text.length, shownRef.current + Math.max(2, Math.ceil(remaining / 40)));
      setShownLength(shownRef.current);
      if (shownRef.current < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <TextBlock
      text={text.slice(0, Math.min(shownLength, text.length))}
      role="assistant"
      renderMarkdown={renderMarkdown}
    />
  );
}

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

/** The tool's FAMILY — drives the row glyph and its color. Scanning a stream
 *  of thirty rows by shape beats reading thirty identical labels. */
function toolFamily(name: string | undefined): "command" | "file" | "search" | "web" | "agent" | "tool" {
  const leaf = String(name ?? "").split(/[.:/]/).pop()?.toLowerCase() ?? "";
  if (/^(bash|shell|exec|exec_command|terminal)$/.test(leaf)) return "command";
  if (/^(read|write|edit|multiedit|notebookedit)$/.test(leaf)) return "file";
  if (/^(grep|glob|search|toolsearch|ls|find)$/.test(leaf)) return "search";
  if (/^(webfetch|websearch|fetch)$/.test(leaf)) return "web";
  if (isFanoutTool(name)) return "agent";
  return "tool";
}

const TOOL_FAMILY_ICONS: Record<ReturnType<typeof toolFamily>, React.ReactNode> = {
  command: (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M2 3l3 3-3 3M6.5 9H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M3 1.5h4L9.5 4v6.5h-6.5z M7 1.5V4h2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 7.5L10.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  web: (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 6h9M6 1.5c1.6 1.4 1.6 7.6 0 9c-1.6-1.4-1.6-7.6 0-9z" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M6 1.8v3M6 4.8L2.5 8M6 4.8L9.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="1.8" r="1.2" fill="currentColor" />
      <circle cx="2.5" cy="9" r="1.2" fill="currentColor" />
      <circle cx="9.5" cy="9" r="1.2" fill="currentColor" />
    </svg>
  ),
  tool: (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 1v1.6M6 9.4V11M1 6h1.6M9.4 6H11M2.5 2.5l1.1 1.1M8.4 8.4l1.1 1.1M9.5 2.5L8.4 3.6M3.6 8.4L2.5 9.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  ),
};

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
  const family = toolFamily(block.name);
  const failed = Boolean(result?.isError);
  return (
    <div className="cc-session-toolwrap">
      <ActivityDetails
        active={active}
        forceOpen={failed}
        className={`cc-session-tool fam-${family}${isCommand ? " cc-session-command" : ""}${failed ? " is-failed" : ""}`}
        id={toolAnchorId(block.toolUseId)}
        summary={
          <>
            <span className={`cc-session-tool-ico fam-${family}`} aria-hidden="true">{TOOL_FAMILY_ICONS[family]}</span>
            <b className="cc-session-tool-name" title={block.name || "Tool"}>{block.name || "Tool"}</b>
            {hint && <span className="cc-session-tool-hint">{hint}</span>}
            <span className={`cc-session-state ${failed ? "error" : result ? "done" : active ? "live" : ""}`}>
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
  // they will miss. So does a terminal result that survived the duplication check:
  // nothing else in the turn carries that prose, so it IS the answer (the shape a
  // delegated runtime produces when it reports once, at the end), and collapsing
  // it leaves the reader looking at a turn that appears to have said nothing.
  // Everything else is a one-line trace they can drill into.
  return (
    <details className={className} open={tone === "danger" || Boolean(terminalText)}>
      <summary className="cc-session-notice-head">{head}</summary>
      {body}
    </details>
  );
}

/** A stretch boundary: one full-width rule across the timeline carrying the same
 * badge vocabulary as the Turn Rail. The badges come from `railBadges` and
 * nowhere else, so the honesty rule holds here too - a dimension the stretch's
 * attribution could not report gets NO badge, never a placeholder. */
function StretchRule({ block }: { block: SessionBlock }) {
  const ended = block.phase === "ended";
  // railBadges is defensive about every field it reads; the two attribution
  // shapes are the same bag described by two modules (journal owns the durable
  // one, transport the live one), so this is a spelling change, not a claim.
  const badges = railBadges((block.attribution ?? {}) as RouteAttribution);
  const stretchId = compactNoticeText(block.stretchId);
  const duty = compactNoticeText(block.duty);
  const chosenBy = compactNoticeText(block.chosenBy);
  const outcome = compactNoticeText(block.outcome);
  const tokens =
    typeof block.usedTokens === "number" && Number.isFinite(block.usedTokens) && block.usedTokens >= 0
      ? Math.round(block.usedTokens)
      : null;
  const duration = elapsedLabel(block.durationMs);
  return (
    <div className={`cc-stretch cc-stretch-${ended ? "ended" : "started"}`}>
      <div className="cc-stretch-head">
        <span className="cc-stretch-kicker">{ended ? "Stretch ended" : "Stretch started"}</span>
        {stretchId && (
          <span className="cc-stretch-id" title={`stretch ${stretchId}`}>{stretchId}</span>
        )}
        {duty && <span className="cc-stretch-chip" title={`duty ${duty}`}>duty {duty}</span>}
        {chosenBy && (
          <span className="cc-stretch-chip" title={`the rung was chosen by ${chosenBy}`}>via {chosenBy}</span>
        )}
        {ended && outcome && (
          <span className="cc-stretch-chip cc-stretch-outcome" title={`outcome ${outcome}`}>{outcome}</span>
        )}
        {ended && compactNoticeText(block.next) && (
          <span className="cc-stretch-chip cc-stretch-next" title="where the handoff pointed next">
            next: {compactNoticeText(block.next)}
          </span>
        )}
        {ended && tokens !== null && (
          <span className="cc-stretch-chip" title="tokens this stretch used">{tokens.toLocaleString("en-US")} tok</span>
        )}
        {ended && duration && <span className="cc-stretch-chip" title="how long the stretch ran">{duration}</span>}
      </div>
      {badges.length > 0 && (
        <div className="cc-stretch-badges">
          {badges.map((badge) => (
            <span
              key={badge.key}
              className={`cc-stretch-badge${badge.tone ? ` cc-stretch-badge-${badge.tone}` : ""}`}
              title={badge.title}
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Human labels for the ledger vocabulary. An unknown kind still renders (the
 * store keeps unknown kinds verbatim) - it just reads as a plain ledger row. */
const LEDGER_LABELS: Record<string, string> = {
  handoff: "Handoff",
  "delegation-dispatched": "Delegation sent",
  "delegation-returned": "Delegation returned",
  "delegation-failed": "Delegation failed",
  "card-state-changed": "Card state changed",
  escalation: "Escalation",
  "policy-rewrite": "Policy rewrite",
  "approval-requested": "Approval requested",
};

/** Kinds that report something going wrong, and earn the warning tone. */
const LEDGER_WARN_KINDS = new Set(["delegation-failed", "escalation", "approval-requested"]);

/** One conversation-ledger row, using the same expand-in-place disclosure the
 * tool rows use. `payloadRef` becomes a control only where a host has supplied a
 * payload opener (ConversationView knows the serving base; dev-env and the
 * related-task overlay do not) - everywhere else it stays the inert reference
 * label it was, because a click that 404s is worse than a label. */
function LedgerRow({ block }: { block: SessionBlock }) {
  const openPayload = useContext(PayloadOpenerContext);
  const kind = compactNoticeText(block.kind);
  const label = LEDGER_LABELS[kind] ?? "Ledger";
  const title = compactNoticeText(block.title);
  const detail = typeof block.detail === "string" ? block.detail : "";
  const payloadRef = compactNoticeText(block.payloadRef);
  const seq =
    typeof block.seq === "number" && Number.isInteger(block.seq) && block.seq >= 0 ? block.seq : null;
  const tone = LEDGER_WARN_KINDS.has(kind) ? " cc-ledger-warn" : "";
  return (
    <ActivityDetails
      active={false}
      className={`cc-ledger${tone}`}
      summary={
        <>
          <span className="cc-ledger-label">{label}</span>
          {title && <span className="cc-ledger-title">{title}</span>}
          {seq !== null && <span className="cc-ledger-seq">#{seq}</span>}
        </>
      }
    >
      <div className="cc-ledger-body">
        {detail.trim() ? <pre className="cc-session-pre">{detail}</pre> : null}
        {payloadRef ? (
          openPayload ? (
            <button
              type="button"
              className="cc-ledger-ref cc-ledger-ref-open"
              title={`Open payload ${payloadRef}`}
              onClick={() => openPayload({ ref: payloadRef, name: payloadRef })}
            >
              payload {payloadRef}
            </button>
          ) : (
            <span className="cc-ledger-ref" title={`payload ${payloadRef}`}>payload {payloadRef}</span>
          )
        ) : null}
        {!detail.trim() && !payloadRef ? (
          <div className="cc-ledger-empty">No further detail was recorded.</div>
        ) : null}
      </div>
    </ActivityDetails>
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
  conversationTurn = false,
  omittedText = null,
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
  /** This turn is one stretch of a conversation. A per-stretch "Response
   * complete" is noise there - the stretch boundary carries the settlement, and
   * the CONVERSATION's own end gets the banner - so a completed turn_end
   * renders only its (unduplicated) result prose, never the notice row.
   * Errors and cancellations keep their notice: a failure must never be the
   * thing this hides. */
  conversationTurn?: boolean;
  /** The prose already shown as this turn's primary text. The tee can carry
   * the same reply under TWO event ids (the streamed revision and the final
   * message), and the index-based omission only catches one of them - any text
   * beat matching this string is skipped. */
  omittedText?: string | null;
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
          if (!includeText || beat.eventIndex === omittedTextEventIndex) return null;
          const text = conversationTurn ? stripHandoffFence(beat.text) : beat.text;
          if (!text.trim()) return null;
          if (omittedText && text.trim() === omittedText.trim()) return null;
          return (
            <div
              key={key}
              className="cc-session-interim-text cc-session-markdown"
              data-session-event-id={sourceEvent?.id ?? undefined}
              data-session-block-index={beat.blockIndex}
            >
              {live
                ? <StreamingText text={text} renderMarkdown={renderMarkdown} />
                : <TextBlock text={text} role="assistant" renderMarkdown={renderMarkdown} />}
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
          if (
            conversationTurn &&
            block.type === "turn_end" &&
            String(block.status ?? "completed") === "completed"
          ) {
            const raw =
              !terminalResultDuplicated && typeof block.result === "string" && block.result.trim()
                ? stripHandoffFence(block.result)
                : null;
            const resultText = raw && raw.trim() ? raw : null;
            if (!resultText) return null;
            return (
              <div
                key={key}
                className="cc-session-interim-text cc-session-markdown"
                data-session-event-id={sourceEvent?.id ?? undefined}
                data-session-block-index={beat.blockIndex}
              >
                <TextBlock text={resultText} role="assistant" renderMarkdown={renderMarkdown} />
              </div>
            );
          }
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
        if (beat.type === "stretch" || beat.type === "ledger") {
          return (
            <div
              key={key}
              data-session-event-id={sourceEvent?.id ?? undefined}
              data-session-block-index={beat.blockIndex}
            >
              {beat.type === "stretch" ? <StretchRule block={block} /> : <LedgerRow block={block} />}
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
  focusEventId,
}: SessionEventTimelineProps) {
  const [modalImage, setModalImage] = useState<{ image: SessionImage; label: string } | null>(null);
  const [, setHostMapReady] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
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
  const conversationTurn = useMemo(
    () => events.some((event) => (event.blocks ?? []).some((block) => block.type === "stretch")),
    [events]
  );
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
  useFocusedEvent(rootRef, focusEventId, events);

  return (
    <div
      ref={rootRef}
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
        conversationTurn={conversationTurn}
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

/** Open a <dialog> modally, lock the page behind it, focus the first control and
 * put focus back where it came from on close. Exported so a sibling modal (the
 * payload viewer) inherits the same behaviour instead of re-deriving it - a modal
 * that forgets one of these four is the one that traps a keyboard user. */
export function useModalLifecycle(
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

/** Keep Tab inside an open dialog. Exported alongside {@link useModalLifecycle}. */
export function trapDialogTab(event: React.KeyboardEvent<HTMLDialogElement>, dialog: HTMLDialogElement | null) {
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

/** A queued message or a pending handoff older than this is not "about to
 * run" - the spinner would be a claim nothing supports. */
const STALE_PENDING_MS = 15 * 60_000;

/** Ticks once a second while mounted; the elapsed base for the working strip. */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The conversation's live pulse: what is running (or being decided) right now,
 * with the model and a running clock. Renders at the tail of the stream, where
 * the next content will appear - the reader's eye is already there. */
function ConversationWorkingStrip({ activity, announce }: { activity: ConversationActivity; announce: boolean }) {
  const now = useNowTick(true);
  const elapsed = activity.since ? elapsedLabel(Math.max(0, now - activity.since)) : null;
  const label = activity.mode === "working"
    ? `Working${activity.duty ? ` — ${activity.duty}` : ""}`
    : activity.mode === "handoff"
      ? "Handing off — choosing what runs next"
      : "Starting — message queued";
  return (
    <div className="cc-conv-working" role={announce ? "status" : undefined}>
      <span className="cc-working-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="cc-conv-working-label">{label}</span>
      {activity.mode === "working" && activity.model && (
        <span className="cc-conv-working-model">{activity.model}</span>
      )}
      {elapsed && <span className="cc-conv-working-time">{elapsed}</span>}
    </div>
  );
}

/** The conversation's terminal state, said out loud. A needs-input park was a
 * one-line collapsed ledger row before this - the single most consequential
 * state a conversation reaches, rendered quieter than a tool call. */
function ConversationStateBanner({ activity }: { activity: ConversationActivity }) {
  if (activity.mode === "needs-input") {
    return (
      <div className="cc-conv-state cc-conv-state-attn" role="status">
        <div className="cc-conv-state-title">Needs your input</div>
        {activity.blockerWhat && <p className="cc-conv-state-line">{activity.blockerWhat}</p>}
        {activity.blockerNeeds && (
          <p className="cc-conv-state-line"><b>Needed:</b> {activity.blockerNeeds}</p>
        )}
        {!activity.blockerWhat && !activity.blockerNeeds && activity.summary && (
          <p className="cc-conv-state-line">{activity.summary}</p>
        )}
        <p className="cc-conv-state-hint">Reply below to resume this conversation.</p>
      </div>
    );
  }
  if (activity.mode === "awaiting-approval") {
    return (
      <div className="cc-conv-state cc-conv-state-attn" role="status">
        <div className="cc-conv-state-title">Waiting for your go-ahead</div>
        <p className="cc-conv-state-line">
          The work is paused before its next step - the ask above carries the plan.
        </p>
        <p className="cc-conv-state-hint">Reply below to approve or redirect.</p>
      </div>
    );
  }
  if (activity.mode === "done") {
    return (
      <div className="cc-conv-state cc-conv-state-done">
        <div className="cc-conv-state-title">Conversation complete</div>
        {activity.summary && <p className="cc-conv-state-line">{activity.summary}</p>}
      </div>
    );
  }
  return null;
}

/** Header chip vocabulary for a settled conversation state. */
const CONVERSATION_STATE_CHIPS: Partial<Record<ConversationActivity["mode"], { label: string; tone: "attn" | "done" | "dim" }>> = {
  "needs-input": { label: "needs input", tone: "attn" },
  "awaiting-approval": { label: "waiting for approval", tone: "attn" },
  done: { label: "done", tone: "done" },
  idle: { label: "idle", tone: "dim" },
};

export function SessionStream({
  url,
  live = false,
  title: titleProp,
  announceLiveUpdates = true,
  focusEventId,
  conversationLive,
}: SessionStreamProps) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [title, setTitle] = useState<string | null>(titleProp ?? null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [retryToken, setRetryToken] = useState(0);
  const [, setHostMapReady] = useState(false);
  const [modalImage, setModalImage] = useState<{ image: SessionImage; label: string } | null>(null);
  const [relatedView, setRelatedView] = useState<RelatedTask | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Whether the view is FOLLOWING the stream (pinned to the tail). Intent-based:
   * an upward wheel/drag unpins instantly; returning to the bottom (or the pill)
   * re-pins. The ref is the authority; the state mirrors it for rendering. */
  const pinnedRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  /** The ONE scrolling ancestor this component animates. Resolved lazily - the
   * host owns the scroll container (ClaudeChat's .cc-scroll, a sheet, a pane),
   * and scrolling anything else is how the whole modal used to lurch. */
  const scrollerRef = useRef<HTMLElement | null>(null);
  const lastWrittenTopRef = useRef(-1);
  const followActiveRef = useRef(false);
  const hadContentRef = useRef(false);
  const liveRef = useRef(live);
  const previousLiveRef = useRef(live);
  liveRef.current = live;
  const focusPendingRef = useFocusedEvent(scrollRef, focusEventId, events);

  // The conversation's own read of what is happening, derived purely from the
  // events. `none` for a plain runtime session - every conversation affordance
  // below is gated on it.
  const activity = useMemo<ConversationActivity>(() => conversationActivity(events), [events]);
  const conversationMode = activity.mode !== "none";
  // A pending state old enough that nothing is plausibly about to run: a
  // message queued hours ago whose launcher never picked it up must not spin
  // forever. Computed when the events change, which is exactly when the answer
  // could change. `working` is exempt - a long-running stretch is still live.
  const pendingStale =
    (activity.mode === "handoff" || activity.mode === "starting") &&
    activity.since !== null &&
    Date.now() - activity.since > STALE_PENDING_MS;
  // The host can veto the derivation's spinners (a card that says stopped),
  // never assert them.
  const derivedBusy =
    conversationMode &&
    conversationLive !== false &&
    !pendingStale &&
    (activity.mode === "working" || activity.mode === "handoff" || activity.mode === "starting");

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
    // A pending jump owns the scroll position for this mount: sticking to the
    // bottom would scroll straight past the hit the reader asked to land on.
    pinnedRef.current = !focusPendingRef.current;
    setStuck(pinnedRef.current);
    hadContentRef.current = false;
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

  // ── Smooth stream-follow ────────────────────────────────────────────────────
  // This component does not own the scroll container: the host does (ClaudeChat's
  // .cc-scroll, a sheet, a pane). Two rules make the stream readable:
  //
  //   1. ONE element scrolls. The nearest scrollable ancestor is resolved once
  //      and only its scrollTop is ever written - scrollIntoView walked EVERY
  //      ancestor, which is how the whole modal used to lurch.
  //   2. Following is smooth and UNPINNING is intent-based. While pinned, a
  //      per-frame loop eases scrollTop toward the bottom (steady streaming
  //      reads like a teleprompter; a sudden block eases in over ~250ms instead
  //      of teleporting). The instant the reader wheels or drags UPWARD the
  //      follow stops dead - nothing may move a transcript someone is reading -
  //      and it resumes only when they return to the bottom or press the pill.
  const setPinned = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setStuck(value);
  }, []);
  const resolveScroller = useCallback((): HTMLElement | null => {
    const cached = scrollerRef.current;
    if (cached && cached.isConnected && cached.scrollHeight > cached.clientHeight + 1) return cached;
    let node: HTMLElement | null = scrollRef.current;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
          scrollerRef.current = node;
          return node;
        }
      }
      node = node.parentElement;
    }
    return null;
  }, []);
  const snapToBottom = useCallback(() => {
    const el = resolveScroller();
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    lastWrittenTopRef.current = target;
    el.scrollTop = target;
  }, [resolveScroller]);

  // Reader-intent listeners. The first cut bound these to the RESOLVED
  // scroller once content appeared - but a fresh conversation has not
  // overflowed its container yet, resolveScroller returned null, the
  // listeners bound to NOTHING, and the follow loop then overwrote every
  // wheel-up the reader tried, forever ("scrolling up is not allowed").
  // Bind wheel/touch to OUR OWN content root instead (it always exists, and
  // pointer events bubble through it regardless of which ancestor scrolls),
  // and catch scroll in the CAPTURE phase on window (scroll does not bubble;
  // capture sees every scroller, filtered to the one holding this transcript).
  useEffect(() => {
    const content = scrollRef.current;
    if (!content) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) setPinned(false);
    };
    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? 0;
      if (y > touchY + 4) setPinned(false);
      touchY = y;
    };
    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.contains(content)) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) {
        if (!pinnedRef.current) setPinned(true);
      } else if (lastWrittenTopRef.current >= 0 && el.scrollTop < lastWrittenTopRef.current - 4) {
        // Moved UP from where the follow last wrote - a scrollbar drag, which
        // fires neither wheel nor touch.
        setPinned(false);
      }
    };
    content.addEventListener("wheel", onWheel, { passive: true });
    content.addEventListener("touchstart", onTouchStart, { passive: true });
    content.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      content.removeEventListener("wheel", onWheel);
      content.removeEventListener("touchstart", onTouchStart);
      content.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [setPinned]);

  // First contentful paint lands AT the bottom instantly - animating a whole
  // history on open would be two seconds of scrolling nobody asked for.
  useEffect(() => {
    if (hadContentRef.current || events.length === 0) return;
    hadContentRef.current = true;
    if (pinnedRef.current && !focusPendingRef.current) snapToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const resultsByToolUse = useMemo(() => latestBlocksByToolUse(events, "tool_result"), [events]);
  const progressByToolUse = useMemo(() => latestBlocksByToolUse(events, "tool_progress"), [events]);
  // A conversation drives itself: the launcher runs stretches whether or not
  // the HOST considers a turn in flight, so the derivation joins the host's
  // `live` in deciding whether the tail renders as active work.
  const streamLive = (live || derivedBusy) && status === "streaming";
  // The follow loop: while the stream is live and the reader is pinned, ease
  // scrollTop toward the bottom every frame. Exponential approach - a few px of
  // token growth tracks exactly; a 300px tool result eases in over ~250ms.
  const followActive = streamLive || derivedBusy;
  followActiveRef.current = followActive;
  useEffect(() => {
    if (!followActive) return;
    let raf = 0;
    const step = () => {
      raf = requestAnimationFrame(step);
      if (!pinnedRef.current || focusPendingRef.current) return;
      const el = resolveScroller();
      if (!el) return;
      const target = el.scrollHeight - el.clientHeight;
      const current = el.scrollTop;
      // The reader moved UP since the last write: never fight them. This is
      // the frame-level backstop for any input path no listener caught.
      if (lastWrittenTopRef.current >= 0 && current < lastWrittenTopRef.current - 4 && target >= lastWrittenTopRef.current) {
        setPinned(false);
        return;
      }
      if (target - current <= 0.5) return;
      const next = Math.min(target, current + Math.max(1, (target - current) * 0.22));
      lastWrittenTopRef.current = next;
      el.scrollTop = next;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followActive]);
  // A SETTLED transcript keeps the old instant behaviour: late layout growth
  // (markdown, images) lands with the bottom still in view, no animation.
  useEffect(() => {
    const content = scrollRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followActiveRef.current && pinnedRef.current && !focusPendingRef.current) snapToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** The pill, and the only programmatic way back: pin and ease down. */
  const jumpToLatest = useCallback(() => {
    setPinned(true);
    const el = resolveScroller();
    if (!el) return;
    const animate = () => {
      if (!pinnedRef.current) return;
      const target = el.scrollHeight - el.clientHeight;
      const next = Math.min(target, el.scrollTop + Math.max(2, (target - el.scrollTop) * 0.25));
      lastWrittenTopRef.current = next;
      el.scrollTop = next;
      if (target - next > 0.5) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [resolveScroller, setPinned]);
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
  // A turn the viewer WATCHED run must not snap shut the moment it settles. The
  // live branch renders an open ActivityTimeline; when the turn completes that
  // branch unmounts and a fresh InterimDetails takes its place, so without this
  // the activity being read collapses itself out from under the reader at the
  // exact moment the answer arrives. Remember which turn was live in THIS
  // mounted transcript and keep that one open once it settles; turns that were
  // already complete when the transcript opened stay collapsed, so replaying a
  // long history is still tidy.
  const watchedLiveTurns = useRef<Set<string>>(new Set());
  const liveTurnKey = streamLive && turns.length ? turns[turns.length - 1].key : null;
  useEffect(() => {
    // Runs on the commit of the LIVE render, i.e. strictly before the render
    // that flips the turn complete and mounts InterimDetails — so the key is
    // already recorded by the time that mount reads its initial open state.
    if (liveTurnKey) watchedLiveTurns.current.add(liveTurnKey);
  }, [liveTurnKey]);
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

  const stateChip = conversationMode && !streamLive ? CONVERSATION_STATE_CHIPS[activity.mode] : undefined;
  return (
    <div className="cc-session">
      <div className="cc-session-head">
        <span className="cc-session-head-title">{title ?? "Activity"}</span>
        {status === "connecting" && <span>connecting…</span>}
        {streamLive && <span className="cc-session-live"><span className="cc-session-live-dot" aria-hidden="true" />live</span>}
        {stateChip && <span className={`cc-session-statechip is-${stateChip.tone}`}>{stateChip.label}</span>}
        {!conversationMode && (status === "ended" || (!streamLive && status === "streaming")) && <span>complete</span>}
        {status === "unavailable" && <span>transcript unavailable</span>}
      </div>
      <RelatedTasks tasks={relatedTasks} onOpen={(task) => setRelatedView(task)} />
      <div className="cc-session-scroll" ref={scrollRef}>
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
          const turnIsStretch = turn.assistantEvents.some((event) =>
            event.blocks.some((block) => block.type === "stretch")
          );
          const primaryText = turnIsStretch && presentation.primaryText
            ? stripHandoffFence(presentation.primaryText)
            : presentation.primaryText;
          const userText = turn.userEvents.map(sessionEventText).filter((text) => text.trim()).join("\n\n");
          const hasSettlementNotice = turn.assistantEvents.some((event) => event.blocks.some((block) =>
            // A stretch boundary is a settlement, not interim chatter: it carries
            // the rung, the chooser, the outcome and the cost — the routing
            // visibility the Conversations instrumentation exists for. Once the
            // transcript tee gives every stretch prose, leaving it off this list
            // folds every boundary into a closed disclosure by default.
            block.type === "stretch" ||
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
              // Counted for the same reason they are on hasVisibleSessionActivity's
              // whitelist: a settled turn whose only blocks are conversation events
              // would otherwise render as an empty assistant bubble.
              block.type === "stretch" || block.type === "ledger" ||
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
                  {!turnLive && Boolean(primaryText?.trim()) && <TextBlock text={primaryText!} role="assistant" />}
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
                        conversationTurn={turnIsStretch}
                      />
                    </>
                  )}
                  {turnLive && !conversationMode && !presentation.primaryText && interimCount === 0 && (
                    <div className="cc-session-awaiting" role={announceLiveUpdates ? "status" : undefined}>Working…</div>
                  )}
                  {!turnLive && interimCount > 0 && (
                    <InterimDetails
                      count={interimCount}
                      openByDefault={
                        !primaryText?.trim() || hasSettlementNotice ||
                        // The turn just finished under the reader's eyes: leave
                        // open what they were already watching.
                        watchedLiveTurns.current.has(turn.key)
                      }
                    >
                      <ActivityTimeline
                        events={turn.assistantEvents}
                        includeText
                        omittedTextEventIndex={presentation.finalTextEventIndex}
                        live={false}
                        activeThinkingBlock={null}
                        resultsByToolUse={resultsByToolUse}
                        progressByToolUse={progressByToolUse}
                        onImage={(image, label) => setModalImage({ image, label })}
                        conversationTurn={turnIsStretch}
                        omittedText={primaryText}
                      />
                    </InterimDetails>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
        {derivedBusy && status !== "connecting" && (
          <ConversationWorkingStrip activity={activity} announce={announceLiveUpdates} />
        )}
        {conversationMode && !derivedBusy && <ConversationStateBanner activity={activity} />}
        {!stuck && (
          <div className="cc-session-jumpwrap">
            <button type="button" className="cc-session-jump" onClick={jumpToLatest}>
              Jump to bottom
            </button>
          </div>
        )}
      </div>
      {modalImage && <ImageModal image={modalImage.image} label={modalImage.label} onClose={() => setModalImage(null)} />}
      {relatedView?.streamUrl && relatedView.streamUrl !== url && (
        <RelatedTaskModal task={relatedView} onClose={() => setRelatedView(null)} />
      )}
    </div>
  );
}
