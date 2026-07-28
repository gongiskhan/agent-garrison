import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { filePathMarkedExtension } from "./host-rewrite";

// Rich Claude session-transcript renderer: the structured blocks the plain-text
// chat stream drops - collapsible thinking, tool calls with input/result, and
// inline images. Ported from the drill fitting's SessionStream, generalised to
// take a stream `url` so the web channel (and any host) can reuse it. Fed by an
// SSE endpoint that tails the session's JSONL and emits `init`/`events`/`end`
// frames of pre-parsed events.

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

interface SessionImage {
  mediaType: string;
  data: string;
}
interface SessionBlock {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  toolUseId?: string | null;
  isError?: boolean;
  images?: SessionImage[];
}
interface SessionEvent {
  id: string | null;
  role: string;
  ts: number | null;
  toolResultsOnly?: boolean;
  blocks: SessionBlock[];
}

type StreamStatus = "connecting" | "streaming" | "ended" | "unavailable";

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

function ToolBlock({ block, result }: { block: SessionBlock; result: SessionBlock | undefined }) {
  const hint = (block.input ?? "").replace(/\s+/g, " ").replace(/^[{[]\s*/, "").slice(0, 90);
  return (
    <div className="cc-session-toolwrap">
      <details className="cc-session-tool">
        <summary>
          <span className="cc-session-tool-ico" aria-hidden="true">⚙</span>
          <b>{block.name}</b>
          <span className="cc-session-tool-hint">{hint}</span>
          {result?.isError && <span className="cc-session-err">error</span>}
        </summary>
        {block.input && <pre className="cc-session-pre">{block.input}</pre>}
        {result?.text && <pre className="cc-session-pre cc-session-result">{result.text}</pre>}
      </details>
      {(result?.images ?? []).map((image, index) => (
        <img
          key={index}
          className="cc-session-img"
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={`${block.name ?? "tool"} result image ${index + 1}`}
          loading="lazy"
        />
      ))}
    </div>
  );
}

export function SessionStream({ url, live }: { url: string; live?: boolean }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setEvents([]);
    setStatus("connecting");
    stickRef.current = true;
    const source = new EventSource(url);
    source.onmessage = (message) => {
      let payload: any;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload.type === "init") {
        setEvents(payload.events ?? []);
        setStatus(payload.available === false ? "unavailable" : payload.live ? "streaming" : "ended");
      } else if (payload.type === "events") {
        if (payload.events?.length) setEvents((current) => [...current, ...payload.events]);
      } else if (payload.type === "end") {
        setStatus((current) => (current === "unavailable" ? current : "ended"));
        source.close();
      }
    };
    source.onerror = () => {
      setStatus((current) => (current === "unavailable" ? current : "ended"));
      source.close();
    };
    return () => source.close();
  }, [url]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const resultsByToolUse = useMemo(() => {
    const map = new Map<string, SessionBlock>();
    for (const event of events) {
      for (const block of event.blocks) {
        if (block.type === "tool_result" && block.toolUseId) map.set(block.toolUseId, block);
      }
    }
    return map;
  }, [events]);

  return (
    <div className="cc-session">
      <div className="cc-session-scroll" ref={scrollRef} onScroll={onScroll}>
        {events.length === 0 && (
          <div className="cc-session-empty">
            {status === "connecting"
              ? "Opening the transcript…"
              : status === "unavailable"
                ? "No rich transcript yet — send a message, then reopen."
                : live
                  ? "Waiting for the first activity…"
                  : "No transcript activity."}
          </div>
        )}
        {events
          .filter((event) => !event.toolResultsOnly)
          .map((event, index) => (
            <div key={event.id ?? `event-${index}`} className={"cc-session-turn " + (event.role === "user" ? "user" : "assistant")}>
              <span className="cc-session-role">{event.role === "user" ? "You" : "Assistant"}</span>
              {event.blocks.map((block, blockIndex) => {
                if (block.type === "text") return <TextBlock key={blockIndex} text={block.text ?? ""} role={event.role} />;
                if (block.type === "thinking") {
                  return (
                    <details key={blockIndex} className="cc-session-thinking">
                      <summary>Thinking</summary>
                      <pre className="cc-session-pre">{block.text}</pre>
                    </details>
                  );
                }
                if (block.type === "tool_use") {
                  return <ToolBlock key={blockIndex} block={block} result={block.toolUseId ? resultsByToolUse.get(block.toolUseId) : undefined} />;
                }
                return null;
              })}
            </div>
          ))}
      </div>
    </div>
  );
}
