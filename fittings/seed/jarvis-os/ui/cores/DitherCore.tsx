"use client";

import { useCallback, useRef } from "react";
import { DitheringShader } from "./dithering-shader";

// ---------------------------------------------------------------------------
// DITHER CORE — the Jarvis centerpiece.
// One dithered sphere; color + speed are the state language, and when Jarvis
// speaks or listens the sphere mouths the audio (equator swell + ripples +
// brightness).
//
// Garrison wiring (the Fable "Phase 2"): the host passes a real `getLevel`
// (AnalyserNode RMS over the mic while listening, and over the TTS <audio>
// while speaking). When no external getLevel is supplied it falls back to the
// Fable synthetic envelope, so the component still works standalone.
// Stable Core boundary: <Core mode getLevel /> — swapping DitherCore for
// GraphCore later is just changing this import.
// Wrapper stays square: the shader has no aspect correction.
// ---------------------------------------------------------------------------

export type CoreMode = "idle" | "working" | "listening" | "speaking" | "error";

const MODE_COLOR: Record<CoreMode, string> = {
  idle: "#d97757",
  working: "#ffb347",
  listening: "#5577ff",
  speaking: "#ffc94a",
  error: "#ff4d3d",
};

const MODE_SPEED: Record<CoreMode, number> = {
  idle: 0.9,
  working: 2.4,
  listening: 1.4,
  speaking: 1.8,
  error: 3.2,
};

// synthetic speech envelope — syllable bursts with pauses, looks like talking
function fakeSpeechLevel(): number {
  const t = performance.now() * 0.001;
  const gate = Math.sin(t * 0.9) > -0.6 ? 1 : 0.08;
  const syllables = (0.45 + 0.55 * Math.sin(t * 6.1)) * (0.4 + 0.6 * Math.sin(t * 2.3));
  return gate * Math.max(0, syllables);
}

export default function DitherCore({
  mode = "idle",
  getLevel: externalGetLevel
}: {
  mode?: CoreMode;
  // Real audio envelope 0..1 (mic while listening, TTS while speaking). When
  // omitted, falls back to the Fable synthetic envelope on "speaking".
  getLevel?: () => number | null;
}) {
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const externalRef = useRef(externalGetLevel);
  externalRef.current = externalGetLevel;

  const getLevel = useCallback(() => {
    if (externalRef.current) {
      const real = externalRef.current();
      if (real != null) return real;
    }
    if (modeRef.current !== "speaking") return 0;
    return fakeSpeechLevel();
  }, []);

  return (
    <div className="dither-core" aria-hidden="true">
      <DitheringShader
        shape="sphere"
        type="random"
        colorBack="#0b0807"
        colorFront={MODE_COLOR[mode]}
        pxSize={2}
        speed={MODE_SPEED[mode]}
        getLevel={getLevel}
      />
    </div>
  );
}
