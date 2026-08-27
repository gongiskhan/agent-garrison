import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClaudeChat, type ChatFeatures, type ComposerAdornmentApi } from "./ClaudeChat";
import { resolvedChatScheme, subscribeChatTheme } from "./chat-theme";
import { PayloadModal } from "./PayloadModal";
import { PayloadOpenerContext, type PayloadTarget } from "./payload-context";
import type { RailOptions } from "./AttributionRail";
import type { ChatTransport, TurnRouting } from "./transport";

/**
 * The id an adapter stamps on the SessionEvent it mints for conversation-store
 * record `seq`, and the id a search-hit jump looks for. ONE function owns the
 * mapping in both directions, so the producer (the store→journal adapter) and the
 * consumer (this view's jump) can never drift into two spellings of the same
 * coordinate.
 */
export function conversationEventId(conversationId: string, seq: number): string {
  return `${conversationId}#${seq}`;
}

/** How far back of the hit the re-derived stream starts. Enough context above the
 * landing that the hit reads as part of a conversation rather than as a top edge. */
const JUMP_LOOKBACK = 40;

/** Long enough that a typed word is one request, short enough that the list feels
 * like it is following the typing. */
const SEARCH_DEBOUNCE_MS = 250;

const DEFAULT_BASE = "/api/conversation";

export interface ConversationSearchHit {
  conversationId: string;
  kind: string;
  seq: number;
  snippet?: string;
}

export interface ConversationViewProps {
  conversationId: string;
  /**
   * Where this conversation is served from. ALWAYS relative: the browser is
   * almost never on the Garrison box, so an absolute machine-local base would be
   * both unreachable and mixed content. An absolute value is refused in favour of
   * the default rather than silently producing dead panes.
   */
  base?: string;
  /** Host-owned. ConversationView never fetches turns itself - it owns the header,
   *  the search and the payload viewer, and nothing about message transport. */
  transport: ChatTransport;
  title?: string;
  placeholder?: string;
  features?: ChatFeatures;
  routing?: TurnRouting | null;
  routeOptions?: RailOptions | null;
  onPinChange?: (routing: TurnRouting) => void | Promise<void>;
  draftKey?: string;
  composerAdornment?: React.ReactNode | ((api: ComposerAdornmentApi) => React.ReactNode);
  /** Open the routed runtime's OWN session transcript from a turn's badge. */
  onOpenRuntimeTranscript?: (sessionId: string) => void;
  /** Land on a search hit: re-derives the stream URL with `?from=<seq-40>` and
   *  focuses the event at `seq`. A new value re-points an already-mounted view. */
  focusSeq?: number | null;
  /** The header's search field. Default true; a host with its own search chrome
   *  (or no search route) turns it off. */
  search?: boolean;
  headerExtra?: React.ReactNode;
  /** The host's word on whether this conversation is still being driven (a card
   *  on Running). `false` vetoes the stream's derived working spinners; absent
   *  leaves the event-derived activity in charge. */
  live?: boolean;
}

/** Refuse an absolute base rather than handing the client a URL it cannot reach. */
function relativeBase(base: string | undefined): string {
  const value = (base ?? DEFAULT_BASE).replace(/\/+$/, "");
  if (value === "" || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    if (base) console.warn(`ConversationView: base must be relative, ignoring ${base}`);
    return DEFAULT_BASE;
  }
  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * A conversation, whole: the append-only stream IS the body, the composer writes
 * into it, and the header carries the name, the search and whatever the host puts
 * beside them.
 *
 * Deliberately thin. Everything it renders already exists - ClaudeChat in
 * `transcriptOnly`, SessionStream's jump, the shared PayloadModal - so this file
 * owns exactly three things a host would otherwise re-invent per surface: the
 * header row, the search-and-jump loop, and the payload seam that turns a ledger
 * row's reference into an opened record.
 */
export function ConversationView({
  conversationId,
  base,
  transport,
  title,
  placeholder,
  features,
  routing,
  routeOptions,
  onPinChange,
  draftKey,
  composerAdornment,
  onOpenRuntimeTranscript,
  focusSeq = null,
  search = true,
  headerExtra,
  live,
}: ConversationViewProps) {
  const root = useMemo(() => relativeBase(base), [base]);
  // The host's `focusSeq` is the initial/authoritative value; a hit clicked in
  // this view's own results moves it locally, exactly as the rail treats `routing`.
  const [seq, setSeq] = useState<number | null>(focusSeq ?? null);
  useEffect(() => { setSeq(focusSeq ?? null); }, [focusSeq]);

  const streamUrl = seq == null
    ? `${root}/${encodeURIComponent(conversationId)}/stream`
    : `${root}/${encodeURIComponent(conversationId)}/stream?from=${Math.max(0, seq - JUMP_LOOKBACK)}`;

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationSearchHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hitsOpen, setHitsOpen] = useState(false);
  const closeHits = useCallback(() => setHitsOpen(false), []);

  // The header sits OUTSIDE .cc-root, so it does not inherit the chat's resolved
  // scheme. Follow the same shared theme signal ClaudeChat follows, on the same
  // opt-in, or the header would stay dark while the chat under it went light.
  const themeOn = Boolean(features?.theme);
  const [scheme, setScheme] = useState<"light" | "dark">(() => resolvedChatScheme());
  useEffect(() => {
    if (!themeOn) return;
    return subscribeChatTheme(() => setScheme(resolvedChatScheme()));
  }, [themeOn]);

  useEffect(() => {
    if (!search) return;
    const term = query.trim();
    if (term === "") {
      setHits(null);
      setTruncated(false);
      setSearchError(null);
      setHitsOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const url = `${root}/search?q=${encodeURIComponent(term)}&id=${encodeURIComponent(conversationId)}`;
      fetch(url, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`search unavailable (${response.status})`);
          return response.json();
        })
        .then((payload: { hits?: ConversationSearchHit[]; truncated?: boolean }) => {
          setHits(Array.isArray(payload?.hits) ? payload.hits : []);
          setTruncated(Boolean(payload?.truncated));
          setSearchError(null);
          setHitsOpen(true);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setHits([]);
          setTruncated(false);
          setSearchError(cause instanceof Error ? cause.message : "search unavailable");
          setHitsOpen(true);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, query, root, conversationId]);

  const [payload, setPayload] = useState<PayloadTarget | null>(null);
  const openPayload = useCallback((target: PayloadTarget) => setPayload(target), []);

  return (
    <div className="cc-conversation" data-theme={themeOn ? scheme : undefined}>
      <div className="cc-conv-head">
        <span className="cc-conv-title" title={title ?? conversationId}>{title ?? conversationId}</span>
        {search && (
          <div className="cc-conv-search">
            <input
              type="search"
              className="cc-conv-searchinput"
              value={query}
              placeholder="Search this conversation"
              aria-label="Search this conversation"
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => { if (hits) setHitsOpen(true); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (hitsOpen) closeHits();
                  else setQuery("");
                }
              }}
            />
            {hitsOpen && (
              <div className="cc-conv-hits" role="listbox" aria-label="Search results">
                {searchError && <div className="cc-conv-hitnote">{searchError}</div>}
                {!searchError && hits?.length === 0 && (
                  <div className="cc-conv-hitnote">No matches in this conversation.</div>
                )}
                {hits?.map((hit) => (
                  <button
                    key={`${hit.conversationId}:${hit.seq}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="cc-conv-hit"
                    onClick={() => { setSeq(hit.seq); closeHits(); }}
                  >
                    <span className="cc-conv-hitkind">{hit.kind}</span>
                    <span className="cc-conv-hitsnip">{hit.snippet ?? ""}</span>
                    <span className="cc-conv-hitseq">#{hit.seq}</span>
                  </button>
                ))}
                {truncated && (
                  <div className="cc-conv-hitnote">More matches than shown - narrow the search.</div>
                )}
              </div>
            )}
          </div>
        )}
        {headerExtra}
      </div>

      {seq != null && (
        <div className="cc-conv-jumped">
          <span>Showing the conversation around #{seq}.</span>
          <button type="button" onClick={() => setSeq(null)}>Back to live</button>
        </div>
      )}

      <PayloadOpenerContext.Provider value={openPayload}>
        <div className="cc-conv-body">
          <ClaudeChat
            transport={transport}
            title={title}
            placeholder={placeholder}
            features={features}
            transcriptUrl={streamUrl}
            transcriptOnly
            transcriptLive={live}
            transcriptFocusEventId={seq == null ? undefined : conversationEventId(conversationId, seq)}
            routing={routing}
            routeOptions={routeOptions}
            onPinChange={onPinChange}
            draftKey={draftKey}
            composerAdornment={composerAdornment}
            onOpenTranscript={onOpenRuntimeTranscript}
          />
        </div>
      </PayloadOpenerContext.Provider>

      {payload && (
        <PayloadModal
          url={`${root}/${encodeURIComponent(conversationId)}/payload/${encodeURIComponent(payload.ref)}`}
          name={payload.name ?? payload.ref}
          kind={payload.kind}
          onClose={() => setPayload(null)}
        />
      )}
    </div>
  );
}
