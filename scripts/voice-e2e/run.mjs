#!/usr/bin/env node
// Autonomous voice e2e harness for the jarvis composition.
//
// Closes the loop with NO microphone and NO human: macOS `say` synthesizes test
// audio (native pt-PT / pt-BR / en voices — the workaround for Deepgram TTS being
// English-only), then feeds it through the real running Fittings:
//
//   Level A  audio → deepgram-voice POST /stt  → assert transcript + detected language
//   Level B  audio → deepgram-voice WS /stream → assert utterance_end + endpointing (live STT)
//   Level C  audio → jarvis-os /api/voice/stt → /api/chat (Orchestrator) → /api/voice/tts
//
// The harness holds NO secret: it talks to the already-running Fittings, which
// carry the vault-injected DEEPGRAM_API_KEY. Requires the jarvis composition `up`.
//
//   node scripts/voice-e2e/run.mjs                       # all levels, all langs
//   node scripts/voice-e2e/run.mjs --level=a --langs=pt-PT --limit=2
//   node scripts/voice-e2e/run.mjs --level=a,b --threshold=0.7
import { readFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { WebSocket } from "ws";
import { discoverFitting, discoverVoice, health, parseWav, similarity, parseSseEvent, stripMarkers, sleep } from "./lib.mjs";
import { synth, assertVoice } from "./synth.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { levels: ["a", "b", "c"], langs: null, limit: Infinity, threshold: 0.6, json: false, compare: false };
  for (const a of argv) {
    if (a.startsWith("--level=") || a.startsWith("--levels=")) out.levels = a.split("=")[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a.startsWith("--langs=")) out.langs = a.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--limit=")) out.limit = Math.max(1, Number(a.split("=")[1]) || Infinity);
    else if (a.startsWith("--threshold=")) out.threshold = Number(a.split("=")[1]);
    else if (a === "--json") out.json = true;
    else if (a === "--compare") out.compare = true;
  }
  return out;
}

const C = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" };
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const pct = (n) => `${Math.round(n * 100)}%`;

// ── Level A: prerecorded STT + language detection ─────────────────────────────
async function levelA(voiceUrl, lang, wav, threshold) {
  // detect_language=true gives us both the transcript and Deepgram's language
  // guess in one call — the honest test of "did it hear pt and know it's pt".
  const t0 = Date.now();
  const res = await fetch(`${voiceUrl}/stt?detect_language=true`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { pass: false, ms, detail: `stt HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json();
  const sim = similarity(lang.expected, data.transcript || "");
  const detected = (data.detected_language || "").toLowerCase();
  const langOk = detected.startsWith(lang.detectPrefix);
  const transcriptOk = sim >= threshold;
  return {
    pass: transcriptOk && langOk,
    sim, detected, ms, transcript: data.transcript || "",
    detail: `sim=${pct(sim)} ${transcriptOk ? "" : "(below threshold) "}lang=${detected || "?"}${langOk ? "" : ` (expected ${lang.detectPrefix}*)`} ${ms}ms`
  };
}

// ── Compare mode: same audio through every running voice Fitting, side by side ─
async function runCompare(voice, langs, args) {
  const engines = voice.all.filter((e) => e.healthy);
  console.log(`${C.bold}Voice compare${C.reset} ${C.dim}— same \`say\` audio, level A (STT + language + latency)${C.reset}`);
  for (const e of engines) console.log(`  ${e.id.padEnd(15)} ${e.url} ${e.keyless ? C.dim + "(local, no key)" + C.reset : C.dim + "(cloud)" + C.reset}`);
  if (engines.length < 2) console.log(warn(`  only ${engines.length} engine up — start both local-voice (7090) and deepgram-voice (7085) for a head-to-head.`));

  const stats = Object.fromEntries(engines.map((e) => [e.id, { pass: 0, total: 0, simSum: 0, msSum: 0, langOk: 0 }]));
  for (const lang of langs) {
    console.log(`\n${C.cyan}${C.bold}${lang.code}${C.reset} ${C.dim}(voice ${lang.voice})${C.reset}`);
    for (const phrase of lang.phrases.slice(0, args.limit)) {
      const { bytes: wav } = await synth(lang.voice, phrase);
      console.log(`  ${C.dim}“${phrase}”${C.reset}`);
      for (const e of engines) {
        let r; try { r = await levelA(e.url, { ...lang, expected: phrase }, wav, args.threshold); } catch (err) { r = { pass: false, sim: 0, ms: 0, detected: "err", detail: err.message }; }
        const s = stats[e.id]; s.total++; if (r.pass) s.pass++; s.simSum += r.sim || 0; s.msSum += r.ms || 0;
        if ((r.detected || "").startsWith(lang.detectPrefix)) s.langOk++;
        console.log(`     ${e.id.padEnd(15)} ${r.pass ? ok("✓") : bad("✗")} sim=${pct(r.sim || 0).padStart(4)} lang=${(r.detected || "?").padEnd(3)} ${String(r.ms || 0).padStart(5)}ms`);
      }
    }
  }

  console.log(`\n${C.bold}Summary — averages per engine${C.reset}`);
  console.log(`  ${"engine".padEnd(15)} ${"pass".padStart(6)} ${"avg sim".padStart(8)} ${"lang ok".padStart(8)} ${"avg latency".padStart(12)}`);
  for (const e of engines) {
    const s = stats[e.id];
    const line = `  ${e.id.padEnd(15)} ${`${s.pass}/${s.total}`.padStart(6)} ${pct(s.simSum / s.total).padStart(8)} ${`${s.langOk}/${s.total}`.padStart(8)} ${(Math.round(s.msSum / s.total) + "ms").padStart(12)}`;
    console.log(s.pass === s.total ? ok(line) : warn(line));
  }
  console.log(`\n${C.dim}Note: level B (live streaming + endpointing) is deepgram-only — local-voice has no WS /stream.${C.reset}`);
  const totalFail = engines.reduce((n, e) => n + (stats[e.id].total - stats[e.id].pass), 0);
  process.exit(totalFail > 0 ? 1 : 0);
}

// ── Level B: live streaming STT with silence endpointing ──────────────────────
async function levelB(voiceUrl, lang, wav, threshold) {
  const { sampleRate, channels, bitsPerSample, pcm } = parseWav(wav);
  if (channels !== 1 || bitsPerSample !== 16) {
    return { pass: false, detail: `expected mono 16-bit PCM, got ${channels}ch/${bitsPerSample}bit` };
  }
  const wsUrl = voiceUrl.replace(/^http/, "ws") + `/stream?sample_rate=${sampleRate}&language=${encodeURIComponent(lang.deepgram)}&utterance_end_ms=1000`;
  const ws = new WebSocket(wsUrl);

  const finals = [];
  let utterance = null;
  let endpointed = false;
  let errored = null;

  const done = new Promise((resolve) => {
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "transcript" && msg.isFinal && msg.text) finals.push(msg.text);
      else if (msg.type === "utterance_end") { endpointed = true; utterance = msg.transcript || finals.join(" "); resolve(); }
      else if (msg.type === "error") { errored = msg.error; resolve(); }
    });
    ws.on("error", (e) => { errored = e.message; resolve(); });
    ws.on("close", () => resolve());
  });

  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); }).catch((e) => { errored = e.message; });
  if (errored) return { pass: false, detail: `ws: ${errored}` };

  // Wait for the server's {ready} before streaming (it's relaying to Deepgram).
  await sleep(150);
  // Stream the audio in ~20 ms linear16 frames at real-time pace, then a tail of
  // silence so Deepgram's endpointing fires UtteranceEnd (utterance_end_ms=1000).
  const frameBytes = Math.round(sampleRate * 0.02) * 2; // 20 ms, 16-bit mono
  for (let i = 0; i < pcm.length; i += frameBytes) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(pcm.subarray(i, i + frameBytes));
    await sleep(20);
  }
  const silence = Buffer.alloc(frameBytes);
  for (let i = 0; i < 75 && ws.readyState === WebSocket.OPEN; i++) { ws.send(silence); await sleep(20); } // ~1.5 s

  // Bounded wait for utterance_end, then close.
  await Promise.race([done, sleep(8000)]);
  try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
  try { ws.close(); } catch {}

  if (errored) return { pass: false, detail: `stream error: ${errored}` };
  const text = utterance ?? finals.join(" ");
  const sim = similarity(lang.expected, text);
  return {
    pass: endpointed && sim >= threshold,
    sim, transcript: text, endpointed,
    detail: `${endpointed ? "endpointed " : bad("no-utterance_end ")}sim=${pct(sim)}`
  };
}

// ── Level C: full chain audio → Orchestrator → spoken reply ───────────────────
async function levelC(jarvisUrl, lang, wav) {
  // 1) audio → transcript (through the channel's own /api/voice proxy)
  const sttRes = await fetch(`${jarvisUrl}/api/voice/stt`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  if (!sttRes.ok) return { pass: false, detail: `voice/stt HTTP ${sttRes.status}` };
  const transcript = (await sttRes.json()).transcript || "";
  if (!transcript.trim()) return { pass: false, detail: "empty transcript from /api/voice/stt" };

  // 2) transcript → Orchestrator (SSE), collect the reply
  const chatRes = await fetch(`${jarvisUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message: transcript })
  });
  if (!chatRes.ok || !chatRes.body) return { pass: false, detail: `chat HTTP ${chatRes.status}`, transcript };

  let assembled = "";
  let finalReply = "";
  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 75_000; // Orchestrator PTY turns can be slow
  outer: while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const ev = parseSseEvent(block);
      if (!ev) continue;
      if (ev.event === "chunk" && typeof ev.data?.text === "string") assembled += ev.data.text;
      else if (ev.event === "done") { finalReply = typeof ev.data?.reply === "string" ? ev.data.reply : ""; break outer; }
      else if (ev.event === "error") return { pass: false, detail: `chat error: ${ev.data?.error || "?"}`, transcript };
    }
  }
  try { await reader.cancel(); } catch {}
  const reply = stripMarkers(assembled || finalReply);
  if (!reply) return { pass: false, detail: "empty Orchestrator reply", transcript };

  // 3) reply → speech (proves the read-aloud leg)
  const ttsRes = await fetch(`${jarvisUrl}/api/voice/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: reply.slice(0, 400), format: "wav" })
  });
  if (!ttsRes.ok) return { pass: false, detail: `voice/tts HTTP ${ttsRes.status}`, transcript, reply };
  const audio = Buffer.from(await ttsRes.arrayBuffer());
  const spoke = audio.length > 1000 && (ttsRes.headers.get("content-type") || "").includes("audio");
  return {
    pass: spoke,
    transcript, reply,
    detail: `heard "${transcript.slice(0, 40)}…" → replied ${reply.length}ch → ${spoke ? `${audio.length}B audio` : bad("no audio")}`
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(await readFile(path.join(HERE, "corpus.json"), "utf8"));
  let langs = corpus.languages.sort((a, b) => a.priority - b.priority);
  if (args.langs) langs = langs.filter((l) => args.langs.includes(l.code));
  if (langs.length === 0) { console.error(bad(`no matching languages for ${args.langs}`)); process.exit(2); }

  // Discover the active voice Fitting (local-voice or deepgram-voice) and the
  // channel for level C. Status files are the source of truth.
  const voice = await discoverVoice();
  if (args.compare) return runCompare(voice, langs, args);
  const jarvis = await discoverFitting("jarvis-os", 7092);
  const wantC = args.levels.includes("c");

  console.log(`${C.bold}Voice e2e harness${C.reset} ${C.dim}— audio via macOS \`say\`, pipeline via running Fittings${C.reset}`);
  console.log(`  voice Fitting: ${C.bold}${voice.id}${C.reset} @ ${voice.url} ${voice.keyless ? C.dim + "(local, no key)" + C.reset : ""}${voice.fromStatus ? "" : warn(" (default port — no status file)")}`);
  if (wantC) console.log(`  jarvis-os:     ${jarvis.url} ${jarvis.fromStatus ? "" : warn("(default port — no status file)")}`);

  // Preflight: the voice Fitting must be reachable and ready.
  if (!voice.healthy) { console.error(bad(`\nNo voice Fitting reachable (tried local-voice:7090, deepgram-voice:7085). Bring the jarvis composition up first.`)); process.exit(2); }
  if (voice.body.keyConfigured === false) { console.error(bad(`\n${voice.id}: DEEPGRAM_API_KEY not configured — set it in the Garrison vault, then re-up. (Or use the keyless local-voice Fitting.)`)); process.exit(2); }
  if (voice.body.enginesReady === false) { console.error(bad(`\n${voice.id}: speech engines still warming up (whisper JIT). Wait ~10s and retry.`)); process.exit(2); }
  // Level B (live streaming) needs a /stream WS endpoint — only deepgram-voice has it.
  if (args.levels.includes("b") && !voice.streaming) {
    console.log(warn(`\n${voice.id} has no WS /stream endpoint (batch-only) — skipping level B. Use deepgram-voice for streaming tests.`));
    args.levels = args.levels.filter((l) => l !== "b");
  }
  if (wantC && !(await health(jarvis.url, 2500)).ok) {
    console.log(warn(`\njarvis-os not reachable — skipping level C (full chain).`));
    args.levels = args.levels.filter((l) => l !== "c");
  }

  const results = [];
  for (const lang of langs) {
    console.log(`\n${C.cyan}${C.bold}${lang.code}${C.reset} ${C.dim}(voice ${lang.voice}, deepgram=${lang.deepgram})${C.reset}`);
    try { await assertVoice(lang.voice); } catch (e) { console.log(bad(`  ${e.message}`)); results.push({ lang: lang.code, phrase: "—", level: "voice", pass: false }); continue; }

    const phrases = lang.phrases.slice(0, args.limit);
    for (const phrase of phrases) {
      const expected = phrase;
      const { bytes: wav } = await synth(lang.voice, phrase);
      const ctx = { ...lang, expected };
      console.log(`  ${C.dim}“${phrase}”${C.reset}`);
      for (const level of ["a", "b", "c"]) {
        if (!args.levels.includes(level)) continue;
        let r;
        try {
          if (level === "a") r = await levelA(voice.url, ctx, wav, args.threshold);
          else if (level === "b") r = await levelB(voice.url, ctx, wav, Math.max(0.4, args.threshold - 0.1));
          else r = await levelC(jarvis.url, ctx, wav);
        } catch (e) { r = { pass: false, detail: e.message }; }
        results.push({ lang: lang.code, phrase, level, ...r });
        const tag = level.toUpperCase();
        console.log(`    ${r.pass ? ok(`✓ ${tag}`) : bad(`✗ ${tag}`)}  ${C.dim}${r.detail || ""}${C.reset}`);
      }
    }
  }

  // Summary
  console.log(`\n${C.bold}Summary${C.reset}`);
  for (const level of ["a", "b", "c"].filter((l) => args.levels.includes(l))) {
    const rows = results.filter((r) => r.level === level);
    const passed = rows.filter((r) => r.pass).length;
    const label = { a: "A round-trip STT + language", b: "B live streaming + endpointing", c: "C full chain (audio→agent→speech)" }[level];
    const line = `  ${level.toUpperCase()}  ${passed}/${rows.length}  ${label}`;
    console.log(passed === rows.length ? ok(line) : (passed === 0 ? bad(line) : warn(line)));
  }
  if (args.json) console.log("\n" + JSON.stringify(results, null, 2));

  const failed = results.filter((r) => !r.pass).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(bad(err.stack || err.message)); process.exit(2); });
