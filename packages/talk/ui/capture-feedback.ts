// Feedback for a spoken conversation turn while the page is open (D56).
//
// A broadcast's wake hit lands in the conversation as a user message with
// `origin: "capture"`; the operative answers in a stretch loop. Out of the app
// the phone hears about both through capture-service's pushes (and the pendant
// or in-app mic speaks them); IN the app the page is the only thing that can
// speak on the broadcast lane, because the broadcast extension's mic has no
// echo coupling to the app speaker (ADR §6) - so it does, here.
//
// The watcher polls the ledger (`GET /api/conversation/:id/log?fromIndex=`)
// from the index the conversation had when the watch began, so nothing older
// is ever announced, and folds the same way capture-service's reply watcher
// does: a heard capture turn is reported at once; the answer is the last
// assistant text of the first stretch that ends with a user-facing duty AFTER
// that turn, or - when no such stretch follows within the idle grace, as when
// triage alone answers with a question (D57) - the last stretch that ended.
// The page and the push therefore say the same thing. Typed turns never
// trigger a spoken answer.

export const CAPTURE_REPLY_DUTIES = ["discuss"];
// Mirrors capture-service's wakeReplyPollMs-scaled grace: a stretch loop that
// has been quiet this long is not going to add a discuss stretch.
export const CAPTURE_REPLY_IDLE_MS = 20_000;
// A lock-screen line is short; what the page speaks can be longer, but a wall
// of text read aloud is not feedback either.
export const CAPTURE_REPLY_SPEAK_CAP = 1200;

export interface CaptureHeard {
  text: string;
  at: number;
}

export interface CaptureReply {
  text: string;
  duty: string | null;
  stretchId: string;
  at: number;
}

export interface CaptureFeedbackHandlers {
  onHeard?: (heard: CaptureHeard) => void;
  onReply?: (reply: CaptureReply) => void;
  /** How many heard turns still wait for an answer; fires on every change. */
  onAwaiting?: (count: number) => void;
}

interface LedgerEvent {
  kind?: string;
  payload?: Record<string, unknown> | null;
}

export interface FoldState {
  running: string | null;
  texts: Map<string, string>;
  /** Capture turns heard and not yet answered. */
  awaiting: number;
  /** The last stretch that ended without a reply duty while a turn waited:
   *  the answer if nothing else follows (settleCaptureIdle). */
  lastEnded: CaptureReply | null;
}

export function createFoldState(): FoldState {
  return { running: null, texts: new Map(), awaiting: 0, lastEnded: null };
}

// The routing trailer every stretch appends ("[route: ...]",
// "[orchestrator-active]") is bookkeeping; code fences are unspeakable.
export function cleanSpokenText(raw: unknown, cap: number = CAPTURE_REPLY_SPEAK_CAP): string {
  let text = String(raw ?? "").replace(/\r/g, "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]*\]$/.test(line));
  let out = lines.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length > cap) out = `${out.slice(0, cap - 3).trimEnd()}...`;
  return out;
}

function assistantText(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || payload.role !== "assistant" || !Array.isArray(payload.blocks)) return "";
  return (payload.blocks as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/** Fold one page of ledger events; pure apart from the handler calls. */
export function foldCaptureEvents(
  state: FoldState,
  events: LedgerEvent[],
  handlers: CaptureFeedbackHandlers,
  { duties = CAPTURE_REPLY_DUTIES, now = Date.now() }: { duties?: string[]; now?: number } = {},
): void {
  for (const ev of events) {
    const kind = ev?.kind;
    const payload = (ev?.payload ?? {}) as Record<string, unknown>;
    if (kind === "user-message") {
      if (payload.origin === "capture") {
        const text = typeof payload.text === "string" ? payload.text.split(/\n\nAttached files?:/)[0].trim() : "";
        state.awaiting += 1;
        state.lastEnded = null;
        handlers.onHeard?.({ text, at: now });
        handlers.onAwaiting?.(state.awaiting);
      }
    } else if (kind === "stretch-started") {
      state.running = typeof payload.stretchId === "string" ? payload.stretchId : "?";
      state.texts.set(state.running, "");
      // Another stretch is answering: whatever ended before it was a step.
      state.lastEnded = null;
    } else if (kind === "session-event") {
      const text = assistantText(payload);
      if (text && state.running) state.texts.set(state.running, text);
    } else if (kind === "stretch-ended") {
      const id = typeof payload.stretchId === "string" ? payload.stretchId : state.running ?? "?";
      const text = cleanSpokenText(state.texts.get(id) ?? "");
      state.texts.delete(id);
      state.running = null;
      const duty = typeof payload.duty === "string" ? payload.duty : null;
      if (state.awaiting <= 0 || !text) continue;
      if (duty && duties.includes(duty)) {
        state.awaiting -= 1;
        state.lastEnded = null;
        handlers.onReply?.({ text, duty, stretchId: id, at: now });
        handlers.onAwaiting?.(state.awaiting);
      } else {
        state.lastEnded = { text, duty, stretchId: id, at: now };
      }
    }
  }
}

/**
 * The idle fallback, called on every poll tick (also the empty ones): a turn
 * still waits, no stretch runs, and the last one ended long enough ago that no
 * reply-duty stretch is coming - so what it said IS the answer. The same rule
 * capture-service's watcher applies before it pushes.
 */
export function settleCaptureIdle(
  state: FoldState,
  handlers: CaptureFeedbackHandlers,
  { now = Date.now(), idleMs = CAPTURE_REPLY_IDLE_MS }: { now?: number; idleMs?: number } = {},
): CaptureReply | null {
  if (state.awaiting <= 0 || state.running || !state.lastEnded) return null;
  if (now - state.lastEnded.at < idleMs) return null;
  const reply = { ...state.lastEnded, at: now };
  state.lastEnded = null;
  state.awaiting -= 1;
  handlers.onReply?.(reply);
  handlers.onAwaiting?.(state.awaiting);
  return reply;
}

export interface WatchOptions {
  base?: string;
  pollMs?: number;
  duties?: string[];
  idleMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Start watching a conversation; returns a stop function. The first poll
 * establishes the baseline (nothing already in the log is announced).
 */
export function watchCaptureFeedback(
  conversationId: string,
  handlers: CaptureFeedbackHandlers,
  { base = "/api/conversation", pollMs = 3000, duties = CAPTURE_REPLY_DUTIES, idleMs = CAPTURE_REPLY_IDLE_MS, fetchImpl }: WatchOptions = {},
): () => void {
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const state = createFoldState();
  const id = encodeURIComponent(conversationId);
  let cursor: number | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (cursor === null) {
        const res = await doFetch(`${base}/${id}`, { cache: "no-store" });
        const meta = res.ok ? ((await res.json().catch(() => null)) as { total?: unknown } | null) : null;
        cursor = typeof meta?.total === "number" ? meta.total : 0;
      } else {
        const res = await doFetch(`${base}/${id}/log?fromIndex=${cursor}&limit=500`, { cache: "no-store" });
        const page = res.ok ? ((await res.json().catch(() => null)) as { events?: LedgerEvent[]; nextIndex?: unknown } | null) : null;
        const events = Array.isArray(page?.events) ? page.events : [];
        if (events.length) {
          cursor = typeof page?.nextIndex === "number" ? page.nextIndex : cursor + events.length;
          if (!stopped) foldCaptureEvents(state, events, handlers, { duties, now: Date.now() });
        }
        if (!stopped) settleCaptureIdle(state, handlers, { now: Date.now(), idleMs });
      }
    } catch {
      // A missed poll is retried on the next tick; the watcher never dies on a
      // transient read miss.
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(() => { void tick(); }, pollMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export interface SpeechBridge {
  speak(args: { text: string; lang?: string }): Promise<{ completed?: boolean }>;
  settings(): Promise<{ master?: boolean; info?: boolean }>;
}

/** Plays one rendered clip to the end; resolves false when it could not. */
export interface ClipPlayer {
  play(audio: Blob): Promise<boolean>;
}

/** The voice layer's `/tts` ceiling per request (capture-service MAX_TEXT_CHARS). */
export const TTS_MAX_CHARS = 600;

/**
 * Split an answer into pieces the voice layer renders in one call, breaking
 * at sentence ends, then at clause ends, then at spaces, never inside a word
 * unless one word is longer than the cap.
 */
export function chunkForTts(text: string, max: number = TTS_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  // Candidate break points, most preferred first: after a sentence end, after a clause, at any space.
  const breakers = [/[.!?]["')\]]?\s+/g, /[,;:]\s+/g, /\s+/g];
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of breakers) {
      for (const m of window.matchAll(re)) {
        const at = m.index ?? 0;
        if (at > 0 && at + m[0].length <= max + 1) cut = at + m[0].length;
      }
      if (cut > 0) break;
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** An HTMLAudioElement-backed player; the webview allows playback without a gesture. */
export function createAudioClipPlayer(): ClipPlayer {
  return {
    play(audio: Blob) {
      return new Promise<boolean>((resolve) => {
        if (typeof Audio === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") { resolve(false); return; }
        const url = URL.createObjectURL(audio);
        const el = new Audio(url);
        const done = (ok: boolean) => { URL.revokeObjectURL(url); resolve(ok); };
        el.addEventListener("ended", () => done(true), { once: true });
        el.addEventListener("error", () => done(false), { once: true });
        el.play().catch(() => done(false));
      });
    },
  };
}

/**
 * Render the answer with the voice layer (`POST /api/voice/tts`, the same
 * Deepgram / ElevenLabs voice the pendant hears) and play the clips in order.
 * The next chunk renders while the current one plays. `played: false` carries
 * a short reason (the proxy's status, "unreachable", "unplayable") so the
 * caller can fall back to the phone's own voice AND say why it did.
 */
export async function speakViaVoiceLayer(
  text: string,
  { lang, fetchImpl, player, maxChars = TTS_MAX_CHARS }: { lang?: string; fetchImpl?: typeof fetch; player: ClipPlayer; maxChars?: number },
): Promise<{ played: boolean; reason?: string }> {
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const render = async (chunk: string): Promise<{ blob: Blob | null; reason?: string }> => {
    try {
      const r = await doFetch("/api/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lang ? { text: chunk, lang, format: "mp3" } : { text: chunk, format: "mp3" }),
      });
      if (!r.ok) {
        let detail = "";
        try { detail = String(((await r.json()) as { error?: string })?.error ?? ""); } catch { /* not json */ }
        return { blob: null, reason: `voice layer ${r.status}${detail ? ` (${detail})` : ""}` };
      }
      const blob = await r.blob();
      return blob.size > 0 ? { blob } : { blob: null, reason: "voice layer sent an empty clip" };
    } catch {
      return { blob: null, reason: "voice layer unreachable" };
    }
  };
  const chunks = chunkForTts(text, maxChars);
  if (chunks.length === 0) return { played: false, reason: "nothing to say" };
  let next = render(chunks[0]);
  for (let i = 0; i < chunks.length; i += 1) {
    const clip = await next;
    // Once the start was heard the phone must not restart it in another voice.
    if (!clip.blob) return i > 0 ? { played: true } : { played: false, reason: clip.reason };
    if (i + 1 < chunks.length) next = render(chunks[i + 1]);
    const played = await player.play(clip.blob);
    if (!played) return i > 0 ? { played: true } : { played: false, reason: "clip would not play" };
  }
  return { played: true };
}

/**
 * Speak an answer through the phone, echo-guarded: the voice layer learns the
 * text (`POST /api/voice/spoken`) before the speaker says it, and again every
 * 20 s while a long answer is still being read, so a live broadcast mic does
 * not transcribe our own voice back into the conversation. The voice is the
 * voice layer's own (D58: rendered clips over `/api/voice/tts`); the phone's
 * synthesizer speaks only when no clip can be had. Speech settings the user
 * turned off (master) are honoured; a page that is not visible stays silent -
 * the push carries the answer then.
 */
export async function speakReply(
  speech: SpeechBridge,
  text: string,
  { lang, fetchImpl, registerEveryMs = 20_000, player = createAudioClipPlayer(), onFallback }: { lang?: string; fetchImpl?: typeof fetch; registerEveryMs?: number; player?: ClipPlayer | null; onFallback?: (reason: string) => void } = {},
): Promise<boolean> {
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  try {
    const settings = await speech.settings();
    if (settings?.master === false) return false;
  } catch {
    // An older native build without settings still speaks.
  }
  const register = () =>
    doFetch("/api/voice/spoken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => undefined);
  await register();
  const timer = setInterval(() => { void register(); }, registerEveryMs);
  try {
    if (player) {
      const rendered = await speakViaVoiceLayer(text, { lang, fetchImpl: doFetch, player });
      if (rendered.played) return true;
      onFallback?.(rendered.reason ?? "voice layer failed");
    } else {
      onFallback?.("no clip player");
    }
    const r = await speech.speak(lang ? { text, lang } : { text });
    return r?.completed !== false;
  } catch {
    return false;
  } finally {
    clearInterval(timer);
  }
}
