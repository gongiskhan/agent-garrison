"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";

// One session running on another node, driven from here.
//
// Everything on this page goes through /api/mesh/nodes/<node>/... - the mesh
// proxy - so the browser only ever talks to its OWN origin. It never learns a
// peer address, which is what keeps the tailnet rule satisfied without any new
// host allowance.
//
// Three deliberate limits, stated rather than hidden:
//
//  1. This is NOT the web channel. It shows what the session is, what it is
//     doing right now, and the four controls that matter across a node
//     boundary: watch, steer, stop, answer a permission. The full conversation
//     lives on the node that owns it, one click away.
//  2. A permission decision is forwarded synchronously and its status is shown
//     VERBATIM. A 409 means the generation that asked is gone; the page says so
//     instead of pretending the decision landed. Answering twice is the failure
//     an optimistic permission UI produces, and it is worse than a clear "no".
//  3. Raw TTY surfaces (dev-env, remote-shell) are WebSocket and cannot be
//     proxied by a Next route handler at all. For those, "Open on <node>" is
//     the honest answer.

const POLL_MS = 5_000;
const MAX_LIVE_FRAMES = 200;

interface SessionRow {
  id: string;
  homeNode: string;
  threadId: string | null;
  cardId: string | null;
  compositionId: string | null;
  runtime: string | null;
  model: string | null;
  account: string | null;
  cwd: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  openUrl: string | null;
}

interface SessionsPayload {
  node: string;
  isSelf?: boolean;
  tailnetHost: string | null;
  controlBase: string | null;
  sessions: SessionRow[];
}

interface PendingInput {
  inputId: string;
  state: string;
  generationId?: string;
}

interface PermissionBlock {
  type: string;
  requestId: string;
  generationId: string;
  name: string;
  status: string;
  title?: string;
  description?: string;
  input?: unknown;
}

interface ThreadPayload {
  thread?: {
    id: string;
    title?: string;
    runningSince?: string | null;
    pendingInputs?: PendingInput[];
    sessionEvents?: { blocks?: PermissionBlock[] }[];
  };
}

interface Outcome {
  status: number;
  text: string;
  tone: "ok" | "warn" | "bad";
}

interface LiveFrame {
  id: number;
  event: string;
  data: string;
}

const ACTIVE_INPUT_STATES = new Set(["queued", "starting", "running", "stopping"]);

function proxy(node: string, path: string): string {
  return `/api/mesh/nodes/${encodeURIComponent(node)}/${path}`;
}

function shortTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "unknown";
  return new Date(at).toLocaleString();
}

// A forwarded call, reported by its VERBATIM upstream status. `409` is not an
// error to retry past; it is the peer telling the truth about a generation that
// no longer exists.
function describe(status: number, body: unknown, node: string): Outcome {
  const detail =
    body && typeof body === "object" && "error" in (body as Record<string, unknown>)
      ? String((body as Record<string, unknown>).error)
      : "";
  if (status >= 200 && status < 300) return { status, text: "Accepted by " + node + ".", tone: "ok" };
  if (status === 409) {
    return {
      status,
      text: `This no longer exists on ${node}${detail ? ` (${detail})` : ""}. Permission decisions are bound to the generation that asked; a restart there makes them unanswerable.`,
      tone: "warn"
    };
  }
  if (status === 421) return { status, text: "That session is on this node - use the local surfaces.", tone: "warn" };
  if (status === 502) return { status, text: `${node} did not answer${detail ? ` (${detail})` : ""}.`, tone: "bad" };
  if (status === 503) return { status, text: "The state service is unreachable, so this node cannot be located.", tone: "bad" };
  return { status, text: `${node} refused with ${status}${detail ? `: ${detail}` : ""}.`, tone: "bad" };
}

export default function RemoteSessionPage({ params }: { params: { node: string; id: string } }) {
  // Next delivers dynamic segments URL-ENCODED; session ids carry '@' and
  // ':' so an undecoded read looks up a nonexistent id (found live: the Pro
  // showed "No session recorded" for a session that very much existed).
  const node = decodeURIComponent(params.node);
  const sessionId = decodeURIComponent(params.id);

  const [payload, setPayload] = useState<SessionsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadPayload["thread"] | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [watching, setWatching] = useState(false);
  const [frames, setFrames] = useState<LiveFrame[]>([]);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const frameSeq = useRef(0);

  const session = useMemo(
    () => payload?.sessions.find((row) => row.id === sessionId) ?? null,
    [payload, sessionId]
  );
  // A gateway session does not always carry a web thread (the standing
  // console predates the registry row). The peer's THREAD LIST is proxied,
  // so when the session has none the operator picks one - control is still
  // fully cross-node, just explicitly aimed.
  const [pickedThread, setPickedThread] = useState<string>("");
  const [peerThreads, setPeerThreads] = useState<{ id: string; title?: string }[]>([]);
  const threadId = session?.threadId ?? (pickedThread || null);

  useEffect(() => {
    if (!session || session.threadId) return;
    fetch(proxy(node, "threads"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const threads = (d.threads ?? []) as { id: string; title?: string; updatedAt?: string }[];
        setPeerThreads(threads.slice(0, 20));
      })
      .catch(() => setPeerThreads([]));
  }, [node, session]);

  const loadSession = useCallback(async () => {
    try {
      const res = await fetch(proxy(node, "sessions"), { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        setLoadError(body?.error ? `${body.error} (${res.status})` : `The registry refused with ${res.status}.`);
        return;
      }
      setPayload(body as SessionsPayload);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [node]);

  const loadThread = useCallback(async () => {
    if (!threadId) return;
    try {
      const res = await fetch(proxy(node, `threads/${encodeURIComponent(threadId)}`), { cache: "no-store" });
      const body = (await res.json()) as ThreadPayload & { error?: string };
      if (!res.ok) {
        setThread(null);
        setThreadError(body?.error ? `${body.error} (${res.status})` : `${node} refused with ${res.status}.`);
        return;
      }
      setThread(body.thread ?? null);
      setThreadError(null);
    } catch (err) {
      setThread(null);
      setThreadError(err instanceof Error ? err.message : String(err));
    }
  }, [node, threadId]);

  useEffect(() => {
    void loadSession();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSession();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadSession]);

  useEffect(() => {
    void loadThread();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadThread();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadThread]);

  // The live watch. Read with fetch + a stream reader rather than EventSource:
  // the peer emits open-ended event NAMES (session_event, input, error, ...) and
  // EventSource only delivers the ones you registered a listener for, so a whole
  // class of frames would silently never arrive.
  useEffect(() => {
    if (!watching || !threadId) return;
    const controller = new AbortController();
    setLiveNote(null);

    (async () => {
      try {
        const res = await fetch(proxy(node, `threads/${encodeURIComponent(threadId)}/live`), {
          headers: { accept: "text/event-stream" },
          cache: "no-store",
          signal: controller.signal
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          setLiveNote(
            res.status === 404
              ? `Nothing is running on ${node} right now, so there is no stream to follow.`
              : `The stream could not be opened: ${body?.error ?? res.status}.`
          );
          setWatching(false);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const parsed = parseFrame(block);
            if (parsed) {
              frameSeq.current += 1;
              const frame = { id: frameSeq.current, ...parsed };
              setFrames((current) => [...current, frame].slice(-MAX_LIVE_FRAMES));
            }
            split = buffer.indexOf("\n\n");
          }
        }
        setLiveNote(`The turn on ${node} finished, so the stream closed.`);
        setWatching(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        setLiveNote(`The stream dropped: ${err instanceof Error ? err.message : String(err)}`);
        setWatching(false);
      }
    })();

    // Aborting here is what closes the proxied connection to the peer as well:
    // the route wires this request's signal into its upstream fetch.
    return () => controller.abort();
  }, [watching, threadId, node]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await fetch(proxy(node, path), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const parsed = await res.json().catch(() => ({}));
        setOutcome(describe(res.status, parsed, node));
        void loadThread();
        return res.status;
      } catch (err) {
        setOutcome({ status: 0, text: err instanceof Error ? err.message : String(err), tone: "bad" });
        return 0;
      } finally {
        setBusy(false);
      }
    },
    [node, loadThread]
  );

  const activeInput = (thread?.pendingInputs ?? []).find(
    (input) => ACTIVE_INPUT_STATES.has(input.state) && input.generationId
  );

  const pendingPermissions: PermissionBlock[] = (thread?.sessionEvents ?? []).flatMap((event) =>
    (event.blocks ?? []).filter((block) => block.type === "permission_request" && block.status === "pending")
  );

  return (
    <main>
      <div className="crumbs">
        <Link href="/mesh">Mesh</Link>
        <span aria-hidden> / </span>
        <b>{node}</b>
        <span aria-hidden> / </span>
        <span className="font-mono">{sessionId}</span>
      </div>

      <div className="page">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Remote session</span>
            <h1>{session?.cardId || session?.cwd?.split("/").filter(Boolean).pop() || sessionId}</h1>
          </div>
          <p>
            This session lives on <b>{node}</b>. Everything below is driven through the mesh proxy, so it
            works from any node - but the transcript, the files and the process itself stay where they are.
          </p>
        </header>

        {loadError ? (
          <div className="banner alarm" role="alert" data-testid="remote-session-error">
            <span className="glyph">!</span>
            <div>
              <h5>This session could not be read from the registry</h5>
              <p>{loadError}</p>
            </div>
          </div>
        ) : null}

        {payload && !session ? (
          <p className={styles.empty}>
            No session <span className="font-mono">{sessionId}</span> is recorded for {node}. It may have been
            pruned, or it may belong to another node.
          </p>
        ) : null}

        {session ? (
          <>
            <dl className={styles.facts} data-testid="remote-session-facts">
              <Fact label="Status">
                <span className="font-mono">{session.status}</span>
                {session.endedAt ? <span className={styles.note}> - ended {shortTime(session.endedAt)}</span> : null}
              </Fact>
              <Fact label="Composition">
                <span className="font-mono">{session.compositionId || "none"}</span>
              </Fact>
              <Fact label="Working directory">
                <span className="font-mono">{session.cwd || "unknown"}</span>
              </Fact>
              <Fact label="Runtime">
                <span className="font-mono">{session.runtime || "unknown"}</span>
                {session.model ? <span className={styles.note}> / {session.model}</span> : null}
              </Fact>
              <Fact label="Started">
                <span className="font-mono">{shortTime(session.startedAt)}</span>
              </Fact>
              <Fact label="Card">
                <span className="font-mono">{session.cardId || "none"}</span>
              </Fact>
            </dl>

            {threadId ? (
              // The full conversation, in THIS window: /mesh/talk frames it from
              // the node that owns it (D48), so no tab and no origin change.
              <Link className={styles.open} href={`/mesh/talk/${encodeURIComponent(node)}/${encodeURIComponent(threadId)}`}>
                Open the conversation
                <span aria-hidden> -&gt;</span>
              </Link>
            ) : session.openUrl ? (
              // No web thread to frame: the session's raw terminal and WebSocket
              // surfaces live on the owning node and cannot be proxied, so the
              // honest door is that node's own shell.
              <a className={styles.open} href={session.openUrl} target="_blank" rel="noreferrer">
                Open on {node}
                <span aria-hidden> -&gt;</span>
              </a>
            ) : (
              <p className={styles.note}>
                {node} has no tailnet host recorded, so it cannot be opened directly from here.
              </p>
            )}

            {!threadId && peerThreads.length > 0 ? (
              <section className={styles.controls}>
                <h2 className={styles.sectionTitle}>Control</h2>
                <p className={styles.note}>
                  This session has no web thread of its own. Pick one of {node}&apos;s threads to watch and steer through the mesh proxy:
                </p>
                <select
                  className={styles.textarea}
                  value={pickedThread}
                  onChange={(event) => setPickedThread(event.target.value)}
                  data-testid="remote-thread-picker"
                >
                  <option value="">- pick a thread on {node} -</option>
                  {peerThreads.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title ? `${t.title} (${t.id})` : t.id}
                    </option>
                  ))}
                </select>
              </section>
            ) : null}

            {threadId ? (
              <section className={styles.controls}>
                <h2 className={styles.sectionTitle}>Control</h2>

                {threadError ? (
                  <p className={styles.warn} data-testid="remote-thread-error">
                    The live thread state could not be read: {threadError}
                  </p>
                ) : null}

                {outcome ? (
                  <p
                    className={outcome.tone === "ok" ? styles.ok : outcome.tone === "warn" ? styles.warn : styles.bad}
                    role="status"
                    data-testid="remote-session-outcome"
                    data-status={outcome.status}
                  >
                    <span className="font-mono">{outcome.status || "ERR"}</span> {outcome.text}
                  </p>
                ) : null}

                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !activeInput}
                    onClick={() => {
                      if (!activeInput?.generationId) return;
                      void post(`threads/${encodeURIComponent(threadId)}/interrupt`, {
                        generationId: activeInput.generationId
                      });
                    }}
                    data-testid="remote-session-interrupt"
                  >
                    Interrupt
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setFrames([]);
                      setWatching((current) => !current);
                    }}
                    data-testid="remote-session-watch"
                  >
                    {watching ? "Stop watching" : "Watch"}
                  </button>
                  <span className={styles.note}>
                    {activeInput
                      ? `A turn is in flight on ${node}.`
                      : `Nothing is running on ${node} right now, so there is nothing to interrupt.`}
                  </span>
                </div>

                <form
                  className={styles.steer}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = message.trim();
                    if (!text) return;
                    void post(`threads/${encodeURIComponent(threadId)}/inputs`, {
                      message: text,
                      clientRequestId: `mesh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
                    }).then((status) => {
                      if (status >= 200 && status < 300) setMessage("");
                    });
                  }}
                >
                  <label className={styles.label} htmlFor="steer">
                    Steer
                  </label>
                  <textarea
                    id="steer"
                    className={styles.textarea}
                    rows={3}
                    value={message}
                    placeholder={`Send an instruction to the session on ${node}`}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                  <button type="submit" className="btn primary" disabled={busy || !message.trim()}>
                    Send
                  </button>
                </form>

                {pendingPermissions.length > 0 ? (
                  <div className={styles.permissions} data-testid="remote-permissions">
                    <h3 className={styles.sectionTitle}>Permission requests</h3>
                    {pendingPermissions.map((block) => (
                      <div key={block.requestId} className={styles.permission}>
                        <div className={styles.permissionHead}>
                          <span className="font-mono">{block.name}</span>
                          <span className={styles.note}>{block.title || block.description || ""}</span>
                        </div>
                        <pre className={styles.permissionInput}>
                          {typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}
                        </pre>
                        <div className={styles.actions}>
                          {(["allow_once", "allow_always", "deny"] as const).map((decision) => (
                            <button
                              key={decision}
                              type="button"
                              className={decision === "deny" ? "btn" : "btn primary"}
                              disabled={busy}
                              onClick={() =>
                                void post(
                                  `threads/${encodeURIComponent(threadId)}/permissions/${encodeURIComponent(block.requestId)}`,
                                  { generationId: block.generationId, decision }
                                )
                              }
                            >
                              {decision.replace("_", " ")}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {watching || frames.length > 0 || liveNote ? (
                  <div className={styles.live} data-testid="remote-session-live">
                    <h3 className={styles.sectionTitle}>
                      Live {watching ? <span className={styles.liveDot} aria-label="streaming" /> : null}
                    </h3>
                    {liveNote ? <p className={styles.note}>{liveNote}</p> : null}
                    {frames.length === 0 && watching ? (
                      <p className={styles.note}>Following the turn on {node}...</p>
                    ) : null}
                    <ul className={styles.frames}>
                      {frames.map((frame) => (
                        <li key={frame.id} className={styles.frame}>
                          <span className={styles.frameEvent}>{frame.event}</span>
                          <span className={styles.frameData}>{frame.data.slice(0, 400)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : (
              <p className={styles.note} data-testid="remote-session-no-thread">
                This session has no web thread, so it cannot be watched or steered from here. Open it on {node}.
              </p>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}

// Minimal SSE block parser: `event:` and one or more `data:` lines. Comments
// (`:` keepalives) and unknown fields are ignored, which is what the spec asks
// for and what keeps a heartbeat from rendering as a frame.
function parseFrame(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
