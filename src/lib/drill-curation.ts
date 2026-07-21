// Drill Spotter curation (Evidence V2, S2) — the lane-independent core of
// the /api/drill/curation route: frame validation (paths confined to the
// drill evidence root), the batch judging prompt, and tolerant parsing of
// the model's JSON-array reply. Images travel as LOCAL FILE PATHS the routed
// session opens with its Read tool — bytes never cross the gateway (its
// body cap is 5 MiB and the image row's history proves the hazard).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  escapeStringControlCharacters,
  escapeUnambiguousInteriorQuotes
} from "@/app/api/automations/vision/input";

export const CURATION_MAX_FRAMES = 40; // hard per-call cap
export const CURATION_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const CURATION_ANNOTATION_MAX = 240;

export type CurationFrameInput = {
  name: string;
  path: string;
  trigger?: string;
  chunk?: string | null;
  tMs?: number;
};

export type CurationVerdict = {
  name: string;
  keep: boolean;
  importance: "normal" | "high";
  annotation: string;
  highlight: { x: number; y: number; w: number; h: number } | null;
};

export function drillEvidenceRoot(): string {
  return path.join(
    process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"),
    "drill",
    "evidence"
  );
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

// Frames arrive as {name, path} rows minted by the drill server from its own
// evidence dir. The route still treats them as untrusted: every path must
// realpath-resolve inside the drill evidence root and carry its own name.
export async function validateCurationFrames(raw: unknown): Promise<CurationFrameInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("frames array required");
  }
  if (raw.length > CURATION_MAX_FRAMES) {
    throw new Error(`too many frames (max ${CURATION_MAX_FRAMES} per call)`);
  }
  const root = await fs.realpath(drillEvidenceRoot()).catch(() => null);
  if (!root) throw new Error("drill evidence root does not exist");
  const frames: CurationFrameInput[] = [];
  for (const entry of raw) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    const p = typeof entry?.path === "string" ? entry.path : "";
    if (!NAME_RE.test(name) || !/\.(jpg|png)$/.test(name)) {
      throw new Error(`invalid frame name: ${name.slice(0, 60)}`);
    }
    if (!path.isAbsolute(p) || path.basename(p) !== name) {
      throw new Error(`invalid frame path for ${name}`);
    }
    const real = await fs.realpath(p).catch(() => null);
    if (!real || !real.startsWith(root + path.sep)) {
      throw new Error(`frame path escapes the drill evidence root: ${name}`);
    }
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > CURATION_MAX_FRAME_BYTES) {
      throw new Error(`frame ${name} is missing, empty, or too large`);
    }
    frames.push({
      name,
      path: real,
      trigger: typeof entry?.trigger === "string" ? entry.trigger.slice(0, 40) : undefined,
      chunk: typeof entry?.chunk === "string" ? entry.chunk.slice(0, 200) : null,
      tMs: Number.isFinite(Number(entry?.tMs)) ? Math.max(0, Math.round(Number(entry.tMs))) : undefined
    });
  }
  return frames;
}

const fmtOffset = (tMs?: number) =>
  typeof tMs === "number" ? `${(tMs / 1000).toFixed(1)}s` : "?";

export function buildCurationPrompt(
  frames: CurationFrameInput[],
  meta: { app?: string; runId?: string } = {}
): string {
  const list = frames
    .map(
      (f, i) =>
        `${i + 1}. name: ${f.name} | check: ${f.chunk ?? "(between checks)"} | trigger: ${
          f.trigger ?? "unknown"
        } | t: ${fmtOffset(f.tMs)} | file: ${f.path}`
    )
    .join("\n");
  return [
    `You are curating evidence frames captured during an automated UI drill run${
      meta.app ? ` of "${meta.app}"` : ""
    }. A human reviewer will watch the kept frames as a debrief reel instead of manually testing the app.`,
    "",
    `${frames.length} frames follow. Each was captured by a deterministic trigger (step-start/step-end = check boundary, phash = the page visibly changed, console-burst = a burst of console output, message-growth = a watched region gained content). Read EVERY listed image file with your Read tool before judging.`,
    "",
    "Frames:",
    list,
    "",
    "Return ONLY a JSON array — no prose, no markdown fences — with EXACTLY one entry per frame:",
    `[{"name": "<frame name>", "keep": true, "importance": "normal", "annotation": "<one factual line: what the frame shows and why it matters>", "highlight": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1}}]`,
    "",
    "Rules:",
    "- keep: true ONLY for frames a reviewer must see — meaningful app states, transitions, errors, visual defects, outcomes. false for redundant or uninformative frames (blank screens, mid-transition smears, near-duplicates of an earlier kept frame).",
    "- A tight reel beats a complete one: when in doubt, DROP. Never keep two frames of the same visual state — when a boundary frame and a nearby frame show the same screen, keep exactly one (the most informative). A typical reel keeps well under half the frames.",
    '- importance: "high" ONLY for failures, errors, visual defects, or decisive outcomes; otherwise "normal".',
    `- annotation: specific and factual, under ${CURATION_ANNOTATION_MAX} characters ("Login form showing a validation error under the email field"), never generic filler.`,
    "- highlight: the region that makes the frame worth seeing, in coordinates normalized to the frame (x/y = top-left corner, w/h = size, all 0..1). Use null when the whole frame is the point.",
    "- Every listed frame MUST appear exactly once in the array."
  ].join("\n");
}

function firstBalancedArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0 && char === "]") return text.slice(start, index + 1);
    }
  }
  return null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function normalizeHighlight(raw: unknown): CurationVerdict["highlight"] {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  const nums = [h.x, h.y, h.w, h.h].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  // Pixel-looking values (anything past the normalized range) are not
  // repairable without the frame size — drop the highlight, keep the frame.
  if (nums.some((n) => n < 0 || n > 1)) return null;
  const [x, y, w, h2] = nums.map(clamp01);
  if (w < 0.005 || h2 < 0.005) return null;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h2, 1 - y) };
}

// Tolerant parse of the model's array reply: same PTY-damage repairs as the
// vision route, then per-entry validation. Entries with unknown names are
// dropped; the caller treats missing names as uncurated (never as dropped
// evidence).
export function parseCurationReply(text: unknown): CurationVerdict[] {
  if (typeof text !== "string") throw new Error("curation reply was not text");
  const candidate = firstBalancedArray(text);
  if (!candidate) throw new Error("curation reply had no complete JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const repaired = escapeStringControlCharacters(
      escapeUnambiguousInteriorQuotes(candidate)
    );
    parsed = JSON.parse(repaired);
  }
  if (!Array.isArray(parsed)) throw new Error("curation reply JSON must be an array");
  const verdicts: CurationVerdict[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const importance = e.importance === "high" ? "high" : "normal";
    const annotation =
      typeof e.annotation === "string"
        ? e.annotation.trim().slice(0, CURATION_ANNOTATION_MAX)
        : "";
    verdicts.push({
      name,
      keep: e.keep === true,
      importance,
      annotation,
      highlight: normalizeHighlight(e.highlight)
    });
  }
  if (verdicts.length === 0) throw new Error("curation reply contained no usable entries");
  return verdicts;
}
