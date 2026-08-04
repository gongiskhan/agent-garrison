import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { filePathMarkedExtension } from "./host-rewrite";
import {
  collectRelatedTasks,
  latestBlocksByToolUse,
  mergeSessionEvents,
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
md.use({
  renderer: {
    // The transcript is injected via dangerouslySetInnerHTML; marked doesn't
    // sanitize, so escape any raw HTML in a text block.
    html({ text }: { text: string }) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
});
// Absolute paths in prose (e.g. a screenshot the operative wrote) render inline.
md.use({ extensions: [filePathMarkedExtension()] });

type StreamStatus = "connecting" | "streaming" | "ended" | "unavailable";

export interface SessionStreamProps {
  url: string;
  live?: boolean;
  /** Optional compact label when this stream is opened as a related task. */
  title?: string;
}

function TextBlock({ text, role }: { text: string; role: string }) {
  // Long user prompts (e.g. a seeded kickoff) collapse to their first line.
  if (role === "user" && text.length > 280) {
    const head = text.slice(0, 140).split("\n")[0];
    return (
      <details className="cc-session-longtext">
        <summary>{head}…</summary>
        <div className="cc-session-md cc-md" dangerouslySetInnerHTML={{ __html: md.parse(text) as string }} />
      </details>
    );
  }
  return <div className="cc-session-md cc-md" dangerouslySetInnerHTML={{ __html: md.parse(text || "") as string }} />;
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
  const output = result?.text || progress?.text || "";
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
            <b>{block.name || "Tool"}</b>
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
                aria-live={active ? "polite" : undefined}
              >
                {output}
              </pre>
            </div>
          )}
          {active && !output && <div className="cc-session-awaiting">Waiting for output…</div>}
        </div>
      </ActivityDetails>
      {(result?.images ?? []).map((image, index) => {
        const label = `${block.name ?? "tool"} screenshot ${index + 1}`;
        return (
          <button key={index} type="button" className="cc-session-imgbtn" onClick={() => onImage(image, label)} aria-label={`Open ${label}`}>
            <img
              className="cc-session-img"
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={label}
              loading="lazy"
            />
            <span>Open screenshot</span>
          </button>
        );
      })}
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

function ImageModal({ image, label, onClose }: { image: SessionImage; label: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="cc-session-modal" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="cc-session-modal-card">
        <div className="cc-session-modal-head">
          <b>{label}</b>
          <button type="button" onClick={onClose} aria-label="Close screenshot">Close</button>
        </div>
        <img src={`data:${image.mediaType};base64,${image.data}`} alt={label} />
      </div>
    </div>
  );
}

export function SessionStream({ url, live = false, title: titleProp }: SessionStreamProps) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [title, setTitle] = useState<string | null>(titleProp ?? null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [retryToken, setRetryToken] = useState(0);
  const [modalImage, setModalImage] = useState<{ image: SessionImage; label: string } | null>(null);
  const [relatedView, setRelatedView] = useState<RelatedTask | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const liveRef = useRef(live);
  liveRef.current = live;

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
        setEvents(Array.isArray(payload.events) ? payload.events : []);
        if (payload.title) setTitle(String(payload.title));
        const nextStatus = payload.available === false ? "unavailable" : payload.live ? "streaming" : "ended";
        sawAvailable = payload.available !== false;
        setStatus(nextStatus);
        if (payload.available === false) retryWhileLive();
      } else if (payload.type === "events") {
        if (payload.title) setTitle(String(payload.title));
        if (Array.isArray(payload.events) && payload.events.length) setEvents((current) => mergeSessionEvents(current, payload.events));
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
    () => events.filter((event) => !event.toolResultsOnly && event.blocks.some((block) => ["text", "thinking", "tool_use"].includes(block.type))),
    [events]
  );
  const activeThinkingKey = useMemo(() => {
    if (!streamLive) return null;
    let last: { key: string; type: string } | null = null;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      for (let blockIndex = 0; blockIndex < event.blocks.length; blockIndex += 1) {
        const block = event.blocks[blockIndex];
        // Snapshot metadata belongs in the fan-out panel; it is not a new
        // chronological beat that should collapse a currently active thought.
        if (block.type === "related_task") continue;
        last = { key: `${event.id ?? eventIndex}:${blockIndex}`, type: block.type };
      }
    }
    return last?.type === "thinking" ? last.key : null;
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
        {visibleEvents.map((event, index) => (
          <div key={event.id ?? `event-${index}`} className={`cc-session-turn ${event.role === "user" ? "user" : "assistant"}`}>
            <span className="cc-session-role">{event.role === "user" ? "You" : "Assistant"}</span>
            {event.blocks.map((block, blockIndex) => {
              const blockKey = `${event.id ?? index}:${blockIndex}`;
              if (block.type === "text") return <TextBlock key={blockIndex} text={block.text ?? ""} role={event.role} />;
              if (block.type === "thinking") return <ThinkingBlock key={blockIndex} block={block} active={activeThinkingKey === blockKey} />;
              if (block.type === "tool_use") {
                return (
                  <ToolBlock
                    key={blockIndex}
                    block={block}
                    result={block.toolUseId ? resultsByToolUse.get(block.toolUseId) : undefined}
                    progress={block.toolUseId ? progressByToolUse.get(block.toolUseId) : undefined}
                    live={streamLive}
                    onImage={(image, label) => setModalImage({ image, label })}
                  />
                );
              }
              return null;
            })}
          </div>
        ))}
      </div>
      {modalImage && <ImageModal image={modalImage.image} label={modalImage.label} onClose={() => setModalImage(null)} />}
      {relatedView?.streamUrl && relatedView.streamUrl !== url && (
        <div className="cc-related-view" role="dialog" aria-modal="true" aria-label={relatedView.label}>
          <div className="cc-related-view-head">
            <b>{relatedView.label}</b>
            <button type="button" onClick={() => setRelatedView(null)}>Close</button>
          </div>
          <SessionStream url={relatedView.streamUrl} live={relatedView.status === "running"} title={relatedView.detail ?? "Related task"} />
        </div>
      )}
    </div>
  );
}
