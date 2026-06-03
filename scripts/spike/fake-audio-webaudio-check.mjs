#!/usr/bin/env node
// Isolation check (advisor #6): does Chromium's --use-file-for-fake-audio-capture
// flow through the Web Audio graph (getUserMedia → MediaStreamSource →
// ScriptProcessor), and is ctx.resume() needed? Reports max RMS with and without
// an explicit resume.
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const wav = path.join(HERE, "fixtures", "voice-input.wav");

// getUserMedia needs a secure context — 127.0.0.1 counts, about:blank does not.
const srv = http.createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>x</title>"); });
await new Promise((r) => srv.listen(7191, "127.0.0.1", r));

const browser = await chromium.launch({ args: [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=${wav}`,
  "--autoplay-policy=no-user-gesture-required"
] });
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:7191/");

const result = await page.evaluate(async () => {
  async function measure(doResume) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const stateBefore = ac.state;
    if (doResume) { try { await ac.resume(); } catch {} }
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const sink = ac.createGain(); sink.gain.value = 0;
    let maxRms = 0, frames = 0;
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      maxRms = Math.max(maxRms, Math.sqrt(s / d.length));
      frames++;
    };
    src.connect(proc); proc.connect(sink); sink.connect(ac.destination);
    await new Promise((r) => setTimeout(r, 2500));
    const stateAfter = ac.state;
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); await ac.close();
    return { sampleRate: ac.sampleRate, stateBefore, stateAfter, frames, maxRms };
  }
  const noResume = await measure(false);
  const withResume = await measure(true);
  return { noResume, withResume };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
srv.close();
const flows = result.withResume.maxRms > 0.001 || result.noResume.maxRms > 0.001;
console.log(flows ? "RESULT: fake audio DOES flow through Web Audio" : "RESULT: fake audio does NOT reach Web Audio (need a different test input)");
process.exit(0);
