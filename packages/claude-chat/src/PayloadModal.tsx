import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rewriteHostUrl } from "./host-rewrite";
import { hostCtx, loadHostMap } from "./markdown-safety";
import { payloadKindFromName, type PayloadKind } from "./payload-context";
import { renderTranscriptMarkdown, trapDialogTab, useModalLifecycle } from "./SessionTranscript";

export interface PayloadModalProps {
  /** Where the bytes live. Relative and same-origin in every Garrison surface;
   * an absolute URL is host-rewritten before it is used, because the browser is
   * almost never on the box that wrote the payload. */
  url: string;
  /** What to call it in the head. Also the source of the inferred kind. */
  name: string;
  kind?: PayloadKind;
  onClose: () => void;
}

/** A jsonl payload is read as a list of rows, not as one wall of text. Past this
 * many the list itself becomes the problem, so the tail is stated rather than
 * rendered. */
const JSONL_ROW_CAP = 500;

/** Pretty-print if it parses, otherwise hand back the bytes verbatim. A payload
 * that claims to be JSON and is not must still be readable - that IS the finding. */
function prettyJson(text: string): { text: string; parsed: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), parsed: true };
  } catch {
    return { text, parsed: false };
  }
}

function JsonlRow({ line }: { line: string }) {
  const pretty = useMemo(() => prettyJson(line), [line]);
  return (
    <details className="cc-paymodal-row">
      <summary title={line}>{line}</summary>
      <pre className="cc-paymodal-pre">{pretty.text}</pre>
    </details>
  );
}

/**
 * The conversation's payload viewer: the L3 bytes a ledger row points at, opened
 * in place over the transcript.
 *
 * There is deliberately NO save/edit affordance. A conversation payload is an
 * append-only record of what a stretch actually did; offering to change it would
 * make the record negotiable, and offering to download it would hand the viewer a
 * link the artifact sandbox refuses to act on anyway. Read, and close.
 */
export function PayloadModal({ url, name, kind, onClose }: PayloadModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalLifecycle(dialogRef, closeRef);

  const [, setHostMapReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadHostMap().then(() => { if (alive) setHostMapReady(true); });
    return () => { alive = false; };
  }, []);

  const resolved = useMemo(() => {
    if (!/^https?:\/\//i.test(url)) return url;
    // Empty means "this address is unreachable from where the reader is sitting" -
    // better a stated dead end than a pane that silently never loads.
    return rewriteHostUrl(url, hostCtx());
  }, [url]);

  const shape = kind ?? payloadKindFromName(name);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shape === "image") return;
    if (!resolved) {
      setError("This payload is not reachable from this device.");
      return;
    }
    let alive = true;
    setBody(null);
    setError(null);
    fetch(resolved)
      .then((response) => {
        if (!response.ok) throw new Error(`payload unavailable (${response.status})`);
        return response.text();
      })
      .then((text) => { if (alive) setBody(text); })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : "payload unavailable");
      });
    return () => { alive = false; };
  }, [resolved, shape]);

  const rows = useMemo(() => {
    if (shape !== "jsonl" || body == null) return null;
    const lines = body.split("\n").filter((line) => line.trim() !== "");
    return { lines: lines.slice(0, JSONL_ROW_CAP), omitted: Math.max(0, lines.length - JSONL_ROW_CAP) };
  }, [shape, body]);

  return (
    <dialog
      ref={dialogRef}
      className="cc-paymodal"
      aria-label={`Payload ${name}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
        trapDialogTab(event, dialogRef.current);
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="cc-paymodal-card">
        <div className="cc-paymodal-head">
          <b className="cc-paymodal-name" title={name}>{name}</b>
          <span className="cc-paymodal-kind">{shape}</span>
          {resolved && (
            <a className="cc-paymodal-raw" href={resolved} target="_blank" rel="noopener noreferrer">Raw</a>
          )}
          <button ref={closeRef} type="button" onClick={onClose} aria-label={`Close payload ${name}`}>Close</button>
        </div>
        <div className="cc-paymodal-body">
          {error && <div className="cc-paymodal-error">{error}</div>}
          {!error && shape === "image" && (
            resolved
              ? <img className="cc-paymodal-img" src={resolved} alt={name} />
              : <div className="cc-paymodal-error">This payload is not reachable from this device.</div>
          )}
          {!error && shape !== "image" && body == null && (
            <div className="cc-paymodal-loading">Loading payload…</div>
          )}
          {!error && body != null && shape === "markdown" && (
            <div
              className="cc-md cc-paymodal-md"
              dangerouslySetInnerHTML={{ __html: renderTranscriptMarkdown(body) }}
            />
          )}
          {!error && body != null && shape === "json" && (
            <pre className="cc-paymodal-pre">{prettyJson(body).text}</pre>
          )}
          {!error && rows && (
            <div className="cc-paymodal-rows">
              {rows.lines.map((line, index) => <JsonlRow key={index} line={line} />)}
              {rows.omitted > 0 && (
                <div className="cc-paymodal-omitted">{rows.omitted} more rows - open Raw to read them all.</div>
              )}
            </div>
          )}
          {!error && body != null && shape === "text" && (
            <pre className="cc-paymodal-pre">{body}</pre>
          )}
        </div>
      </div>
    </dialog>
  );
}
