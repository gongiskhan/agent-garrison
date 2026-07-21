// End-of-speech → first-audio latency instrumentation (S6b, D20).
//
// The S6a voice server emits per-stage `voice-latency` JSON lines to its OWN
// stdout (audio_in / first_interim / utterance_end on the STT socket;
// tts_text_in / tts_first_audio on the TTS socket) — the browser can't read
// those. So the client re-measures the one budget that matters end-to-end from
// the events it CAN observe over the two WebSockets:
//   • utterance_end   — the STT relay's silence endpoint (end of speech)
//   • tts_first_audio — the first audio frame off the streaming-TTS relay
// The gap between them is the perceived "I stopped talking → it started
// answering" latency, with a 2s budget. Pure + host-agnostic so it unit-tests
// with injected timestamps (tests/voice-latency.test.ts).

export const FIRST_AUDIO_BUDGET_MS = 2000;

export interface StageMark {
  stage: string;
  ts: number;
}

export interface BudgetVerdict {
  /** end-of-speech → first-audio, ms; null when a required mark is missing. */
  ms: number | null;
  /** true within budget, false over, null when unmeasurable. */
  ok: boolean | null;
  budgetMs: number;
  /** How far OVER budget, ms (0 when within, null when unmeasurable). */
  overBy: number | null;
}

export class LatencyTracker {
  private marks: StageMark[] = [];

  mark(stage: string, ts: number = Date.now()): void {
    this.marks.push({ stage, ts });
  }

  reset(): void {
    this.marks = [];
  }

  getMarks(): StageMark[] {
    return this.marks.slice();
  }

  /** ms between the LAST `from` mark and the FIRST `to` mark that follows it.
   *  null when either is absent or `to` never occurs after `from`. */
  between(from: string, to: string): number | null {
    let fromTs: number | null = null;
    for (const m of this.marks) {
      if (m.stage === from) fromTs = m.ts;
    }
    if (fromTs === null) return null;
    for (const m of this.marks) {
      if (m.stage === to && m.ts >= fromTs) return m.ts - fromTs;
    }
    return null;
  }

  /** The headline budget metric: utterance_end → tts_first_audio. */
  endOfSpeechToFirstAudioMs(): number | null {
    return this.between("utterance_end", "tts_first_audio");
  }

  budget(budgetMs: number = FIRST_AUDIO_BUDGET_MS): BudgetVerdict {
    const ms = this.endOfSpeechToFirstAudioMs();
    if (ms === null) return { ms: null, ok: null, budgetMs, overBy: null };
    return { ms, ok: ms <= budgetMs, budgetMs, overBy: Math.max(0, ms - budgetMs) };
  }

  /** Per-stage breakdown relative to end-of-speech, for a detailed readout. */
  stages(): { stage: string; ms: number }[] {
    let base: number | null = null;
    for (const m of this.marks) {
      if (m.stage === "utterance_end") base = m.ts;
    }
    if (base === null) return [];
    const out: { stage: string; ms: number }[] = [];
    for (const m of this.marks) {
      if (m.ts >= base && m.stage !== "utterance_end") out.push({ stage: m.stage, ms: m.ts - base });
    }
    return out;
  }
}
