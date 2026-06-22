// Shared helpers for the voice e2e harness: live-Fitting discovery, WAV parsing,
// transcript similarity scoring, and SSE event parsing. No external deps.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

// Resolve a running own-port Fitting's base URL from its status file (the single
// source of truth per CLAUDE.md), falling back to a default port if absent.
export async function discoverFitting(fittingId, defaultPort) {
  const statusFile = path.join(garrisonDir(), "ui-fittings", `${fittingId}.json`);
  try {
    const raw = await readFile(statusFile, "utf8");
    const json = JSON.parse(raw);
    if (typeof json.url === "string" && json.url) return { url: json.url.replace(/\/+$/, ""), pid: json.pid, fromStatus: true };
    if (typeof json.port === "number") return { url: `http://127.0.0.1:${json.port}`, pid: json.pid, fromStatus: true };
  } catch {}
  return { url: `http://127.0.0.1:${defaultPort}`, pid: null, fromStatus: false };
}

// Resolve the active voice Fitting, preferring whichever is actually running.
// Both expose the same /stt contract ({ transcript, detected_language }); only
// deepgram-voice implements the WS /stream endpoint (local-voice is batch-only),
// so `streaming` gates level B. local-voice needs no API key and is multilingual
// (faster-whisper), which is why it's tried first.
export async function discoverVoice() {
  const candidates = [
    { id: "local-voice", port: 7090, streaming: false, keyless: true },
    { id: "deepgram-voice", port: 7085, streaming: true, keyless: false }
  ];
  const found = [];
  for (const c of candidates) {
    // Env override (e.g. LOCAL_VOICE_URL=http://127.0.0.1:7095) lets the harness
    // target an ad-hoc instance — used to benchmark an unpinned local-voice
    // alongside the runner-managed one without touching the status file.
    const envUrl = process.env[`${c.id.replace(/-/g, "_").toUpperCase()}_URL`];
    const d = envUrl ? { url: envUrl.replace(/\/+$/, ""), fromStatus: false } : await discoverFitting(c.id, c.port);
    const h = await health(d.url, 2500);
    found.push({ ...c, url: d.url, fromStatus: d.fromStatus, healthy: h.ok, body: h.body || {} });
  }
  const healthy = found.filter((f) => f.healthy);
  const pick = healthy.find((f) => f.fromStatus) || healthy[0] || found[0];
  return { ...pick, all: found };
}

export async function health(baseUrl, timeoutMs = 2000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: ac.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json().catch(() => ({})) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

// Minimal PCM/WAV reader: returns { sampleRate, channels, bitsPerSample, pcm }.
// Handles the canonical 44-byte header `say` emits; scans chunks to be safe.
export function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let fmt = null;
  let dataOffset = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buffer.length) {
    const id = buffer.toString("ascii", off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLen = Math.min(size, buffer.length - body);
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) throw new Error("missing fmt/data chunk");
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    pcm: buffer.subarray(dataOffset, dataOffset + dataLen)
  };
}

// Normalize a transcript for comparison: lowercase, strip punctuation, collapse
// whitespace. Accents are PRESERVED (they're meaningful in pt) but a separate
// accent-folded compare is offered for lenient matching.
function normalize(s, { foldAccents = false } = {}) {
  let out = (s || "").toLowerCase();
  if (foldAccents) out = out.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return out
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[0] === undefined ? Infinity : cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Portuguese cardinal number words (accent-folded keys, pt-PT + pt-BR variants).
// Lets us treat a spoken "quarenta e dois" and a smart-formatted "42" as equal —
// the STT understood correctly, it just chose digits. Covers 0–9999.
const PT_NUM = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14,
  quatorze: 14, quinze: 15, dezasseis: 16, dezesseis: 16, dezassete: 17, dezessete: 17,
  dezoito: 18, dezanove: 19, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40,
  cinquenta: 50, cincoenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
  quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600,
  seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800,
  novecentos: 900, novecentas: 900, mil: 1000
};

// Collapse runs of number-words (joined by "e") into a single digit token, so
// "quarenta e dois" → "42". Digits already in the text pass through unchanged.
function foldNumbers(tokens) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    let total = 0, current = 0;
    for (const v of run) {
      if (v === 1000) { current = (current || 1) * 1000; total += current; current = 0; }
      else if (v === 100) { current = (current || 1) * 100; }
      else current += v;
    }
    out.push(String(total + current));
    run = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t in PT_NUM) { run.push(PT_NUM[t]); continue; }
    // "e" stays inside a run only if another number word follows it.
    if (t === "e" && run.length && tokens[i + 1] in PT_NUM) continue;
    flush();
    out.push(t);
  }
  flush();
  return out;
}

// Word-level similarity = 1 - WER (word error rate), accent-folded and
// number-normalized so neither a missing diacritic nor digit-vs-words tanks a
// transcription the STT actually got right. Returns 0..1.
export function similarity(expected, actual) {
  const e = foldNumbers(normalize(expected, { foldAccents: true }).split(" ").filter(Boolean));
  const a = foldNumbers(normalize(actual, { foldAccents: true }).split(" ").filter(Boolean));
  if (e.length === 0) return a.length === 0 ? 1 : 0;
  const dist = levenshtein(e, a);
  return Math.max(0, 1 - dist / e.length);
}

// Parse a single SSE event block ("event: x\ndata: {...}") → { event, data }.
export function parseSseEvent(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data = raw;
  try { data = JSON.parse(raw); } catch {}
  return { event, data };
}

// Strip the Orchestrator control markers the channel UI hides (mirror of
// stripMarkers in jarvis-os/ui/main.tsx) so a level-C reply reads clean.
export function stripMarkers(s) {
  return (s || "")
    .replace(/\[orchestrator-active\]/gi, "")
    .replace(/\[gateway-route:[^\]]*\]/gi, "")
    .replace(/\[delegated\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
