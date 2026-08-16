import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { filePathMarkedExtension } from "./host-rewrite";
import { installSafeMarkdownRenderer, loadHostMap } from "./markdown-safety";
import {
  collectRelatedTasks,
  groupSessionTurns,
  isSessionEvent,
  latestBlocksByToolUse,
  mergeSessionEvents,
  presentSessionTurn,
  sessionActivityBeats,
  sessionEventText,
  sessionEventTerminalText,
  sessionThinkingSummary,
  sessionToolSummary,
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
          {block.input && (
            <div>
              <span className="cc-session-section-label">Input</span>
              <pre className="cc-session-pre">{block.input}</pre>
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
              className="cc-session-error"
              data-session-event-id={sourceEvent?.id ?? undefined}
              data-session-block-index={beat.blockIndex}
            >
              <span className="cc-session-section-label">Error</span>
              <div>{beat.text}</div>
            </div>
          );
        }
        const block = beat.block;
        if (beat.type === "thinking") {
          return <ThinkingBlock key={key} block={block} active={live && activeThinkingBlock === block} />;
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
export function SessionEventTimeline({ events, live = false, className = "", renderMarkdown }: SessionEventTimelineProps) {
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
  const terminalText = useMemo(() => {
    for (let eventIndex = assistantEvents.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const blocks = assistantEvents[eventIndex].blocks;
      for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = blocks[blockIndex];
        if (block.type === "turn_end" && typeof block.result === "string" && block.result.trim()) {
          return block.result;
        }
      }
    }
    return "";
  }, [assistantEvents]);
  const terminalDuplicatesText = useMemo(
    () => Boolean(terminalText) && assistantEvents.some((event) => sessionEventText(event).trim() === terminalText.trim()),
    [assistantEvents, terminalText]
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
      />
      {terminalText && !terminalDuplicatesText && (
        <div className="cc-session-terminal-text cc-session-markdown">
          <TextBlock text={terminalText} role="assistant" renderMarkdown={renderMarkdown} />
        </div>
      )}
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
  liveRef.current = live;

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
    let sawAvailable = false;
    const retryWhileLive = () => {
      if (!liveRef.current || retryTimer) return;
      retryTimer = setTimeout(() => setRetryToken((value) => value + 1), 900);
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
        setEvents(Array.isArray(payload.events) ? payload.events.filter(isSessionEvent) : []);
        if (payload.title) setTitle(String(payload.title));
        const nextStatus = payload.available === false ? "unavailable" : payload.live ? "streaming" : "ended";
        sawAvailable = payload.available !== false;
        setStatus(nextStatus);
        if (payload.available === false) retryWhileLive();
      } else if (payload.type === "events") {
        if (payload.title) setTitle(String(payload.title));
        const incoming = Array.isArray(payload.events) ? payload.events.filter(isSessionEvent) : [];
        if (incoming.length) setEvents((current) => mergeSessionEvents(current, incoming));
      } else if (payload.type === "end") {
        setStatus((current) => (current === "unavailable" ? current : "ended"));
        source.close();
        if (!sawAvailable) retryWhileLive();
      }
    };
    source.onerror = () => {
      setStatus((current) => (current === "unavailable" ? current : "ended"));
      source.close();
      if (!sawAvailable) retryWhileLive();
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
    () => events.filter((event) => !event.toolResultsOnly && event.blocks.some((block) =>
      ["text", "thinking", "tool_use", "error"].includes(block.type) ||
      (block.type === "turn_end" && typeof block.result === "string" && block.result.trim() !== "")
    )),
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
        {events.length === 0 && (
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
          const terminalText = [...turn.assistantEvents].reverse().map(sessionEventTerminalText).find((text) => text.trim()) ?? "";
          const terminalDuplicatesText = Boolean(terminalText) && turn.assistantEvents.some(
            (event) => sessionEventText(event).trim() === terminalText.trim()
          );
          const interimCount = turn.assistantEvents.reduce((count, event, eventIndex) => {
            const textCount = eventIndex !== presentation.finalTextEventIndex && sessionEventText(event).trim() ? 1 : 0;
            const activityCount = event.blocks.filter((block) =>
              block.type === "thinking" || block.type === "tool_use" || block.type === "error"
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
                      />
                      {terminalText && !terminalDuplicatesText && <TextBlock text={terminalText} role="assistant" />}
                    </>
                  )}
                  {turnLive && !presentation.primaryText && interimCount === 0 && (
                    <div className="cc-session-awaiting" role={announceLiveUpdates ? "status" : undefined}>Working…</div>
                  )}
                  {!turnLive && interimCount > 0 && (
                    <InterimDetails count={interimCount} openByDefault={!presentation.primaryText}>
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
