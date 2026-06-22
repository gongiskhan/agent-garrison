// Voice client for the rich chat — talks ONLY to same-origin proxy routes that
// the host server exposes, never to the deepgram-voice fitting (7085) directly
// (that would be cross-origin / CORS). The dev-env server adds:
//   GET  <base>/voice/health  -> { available, url?, keyConfigured? }
//   POST <base>/voice/tts     -> { text, format? } in, audio bytes out
//   POST <base>/voice/stt     -> raw audio bytes in, { transcript, confidence }
// When the voice fitting is down or the API key is missing the proxy returns
// 503 and the UI disables the voice controls gracefully.
//
// `base` is the same path prefix the chat transport uses (e.g. "/sessions/:id"
// in dev-env, or "" for a root-mounted host). Voice is opt-in: ClaudeChat only
// constructs a VoiceClient when the host enables the voice feature, so
// web-channel (which does not) is entirely unaffected.

export interface VoiceHealth {
  available: boolean;
  url?: string;
  keyConfigured?: boolean;
}

export interface VoiceClient {
  health(): Promise<VoiceHealth>;
  /** Synthesize `text` to speech; resolves to an audio blob (audio/mpeg). */
  tts(text: string): Promise<Blob>;
  /** Transcribe a recorded audio blob; resolves to the transcript text. */
  stt(blob: Blob): Promise<string>;
}

export function createVoiceClient(base = ""): VoiceClient {
  const b = base.replace(/\/$/, "");
  const u = (p: string) => `${b}/voice/${p}`;
  return {
    async health() {
      try {
        const res = await fetch(u("health"));
        if (!res.ok) return { available: false };
        const j = (await res.json().catch(() => ({}))) as VoiceHealth;
        return { available: Boolean(j.available), url: j.url, keyConfigured: j.keyConfigured };
      } catch {
        return { available: false };
      }
    },
    async tts(text) {
      const res = await fetch(u("tts"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, format: "mp3" }),
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
