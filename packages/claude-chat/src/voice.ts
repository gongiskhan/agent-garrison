// Voice client for the rich chat - talks ONLY to same-origin proxy routes that
// the host server exposes, never to the voice provider fitting (the one
// providing kind:voice, capture-service today) directly (that would be
// cross-origin / CORS, and its /stt and /tts are Bearer-gated by a token the
// page never holds). Both hosts (the dev-env server and the shell's talk
// router) expose the same three routes:
//   GET  <base>/voice/health  -> { available, fitting?, keyConfigured?, tts?, backend?, maxTextChars?, reason? }
//   POST <base>/voice/tts     -> { text, format? } in, audio bytes out
//   POST <base>/voice/stt     -> raw audio bytes in, { transcript, confidence }
// When no provider is stationed, it is down, the vault is locked or the
// transcriber has no key, the proxy returns 503 and the UI disables the voice
// controls gracefully. The health body names the provider FITTING, never its
// machine-local URL: the page is usually on another machine (CLAUDE.md, the
// browser-is-remote rule) and a loopback address would be both unreachable and
// a detail the client has no business holding.
//
// `base` is the same path prefix the chat transport uses (e.g. "/sessions/:id"
// in dev-env, or "" for a root-mounted host). Voice is opt-in: ClaudeChat only
// constructs a VoiceClient when the host enables the voice feature, so
// web-channel (which does not) is entirely unaffected.

export interface VoiceHealth {
  available: boolean;
  /** Id of the fitting providing kind:voice (capture-service today). */
  fitting?: string;
  keyConfigured?: boolean;
  /** Whether read-aloud can work (the provider has a synthesiser backend). */
  tts?: boolean;
  /** The provider's per-request /tts text budget, mirrored from its /health so
   *  read-aloud chunks against the number the server actually enforces. `null`
   *  when the provider did not advertise one (the client falls back to
   *  DEFAULT_CHUNK_CHARS). */
  maxTextChars?: number | null;
  /** Why the voice surface is unavailable, in the host's words ("voice locked",
   *  "no voice provider", ...), so the disabled controls can say which. */
  reason?: string;
}

export interface VoiceClient {
  health(): Promise<VoiceHealth>;
  /** Synthesize ONE chunk of `text` (at most the provider's maxTextChars) to
   *  speech; resolves to an audio blob (audio/mpeg). Callers split longer text
   *  with chunkSpeech and play the pieces back to back. */
  tts(text: string, opts?: { signal?: AbortSignal }): Promise<Blob>;
  /** Transcribe a recorded audio blob; resolves to the transcript text. */
  stt(blob: Blob): Promise<string>;
}

// capture-service caps one /tts request at MAX_TEXT_CHARS (lib/tts.mjs, 600) and
// advertises the number as voice.maxTextChars on /health. This default matches
// that cap so a host that cannot read the advertised value still never sends a
// request the provider will 400; hosts that CAN read it pass it in so the cap
// can move server-side without every long reply starting to fail here.
export const DEFAULT_CHUNK_CHARS = 600;

/** Split text into synthesis-sized chunks at sentence, then clause, boundaries. */
export function chunkSpeech(text: string, maxChars: number = DEFAULT_CHUNK_CHARS): string[] {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const s of sentences) {
    if (s.length > maxChars) {
      push();
      // A single overlong sentence: cut at clause marks, then hard.
      let rest = s.trim();
      while (rest.length > maxChars) {
        const window = rest.slice(0, maxChars);
        const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
        const cut = at > maxChars / 2 ? at + 1 : maxChars;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      // The sentence match carried its own trailing space; trimming the
      // remainder dropped it, so restore the separator before the next one.
      cur = rest ? `${rest} ` : "";
      continue;
    }
    if ((cur + s).length > maxChars) push();
    cur += s;
  }
  push();
  return out;
}

/** The chunk size a health body asks for: a positive integer, else the default. */
export function chunkCharsFor(health: Pick<VoiceHealth, "maxTextChars"> | null | undefined): number {
  const n = health?.maxTextChars;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_CHUNK_CHARS;
}

export function createVoiceClient(base = ""): VoiceClient {
  const b = base.replace(/\/$/, "");
  const u = (p: string) => `${b}/voice/${p}`;
  return {
    async health() {
      try {
        const res = await fetch(u("health"));
        if (!res.ok) return { available: false, reason: `voice health ${res.status}` };
        const j = (await res.json().catch(() => ({}))) as VoiceHealth;
        return {
          available: Boolean(j.available),
          fitting: typeof j.fitting === "string" ? j.fitting : undefined,
          keyConfigured: j.keyConfigured,
          tts: typeof j.tts === "boolean" ? j.tts : undefined,
          maxTextChars: typeof j.maxTextChars === "number" && Number.isInteger(j.maxTextChars) && j.maxTextChars > 0
            ? j.maxTextChars
            : null,
          reason: typeof j.reason === "string" ? j.reason : undefined,
        };
      } catch {
        return { available: false };
      }
    },
    async tts(text, opts) {
      const res = await fetch(u("tts"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, format: "mp3" }),
        signal: opts?.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`tts ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      return await res.blob();
    },
    async stt(blob) {
      const res = await fetch(u("stt"), {
        method: "POST",
        headers: { "content-type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`stt ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      const j = (await res.json().catch(() => ({}))) as { transcript?: string };
      return typeof j.transcript === "string" ? j.transcript : "";
    },
  };
}
