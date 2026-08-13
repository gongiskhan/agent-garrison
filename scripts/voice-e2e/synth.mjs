// Synthesize test audio with the macOS `say` TTS engine. This is the workaround
// for Deepgram Aura being English-only: macOS ships native pt-PT (Joana) and
// pt-BR (Luciana) voices, so we generate the audio locally — for free, for any
// text — and let Deepgram only do the STT side (which handles Portuguese fine).
// Using an independent TTS for generation also makes the STT test honest rather
// than a circular Deepgram-into-Deepgram loop.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures");

// 16 kHz mono linear16 WAV — matches the recording format the jarvis-os channel
// sends and Deepgram's linear16 streaming expectations.
const DATA_FORMAT = "LEI16@16000";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`)));
  });
}

// Synthesize `text` in `voice` to a cached 16 kHz mono WAV; returns its path and
// the raw bytes. Re-synthesis is skipped when the fixture already exists.
// opts.rate (words/min, default ~175) and opts.volume (0..1) let us approximate
// a fast, quiet speaker — `say -r 250` plus an inline `[[volm 0.4]]` — to stress
// the STT closer to a real hurried mumble than the default clean read.
export async function synth(voice, text, opts = {}) {
  const { rate = null, volume = null } = opts;
  await mkdir(FIXTURE_DIR, { recursive: true });
  const key = createHash("sha1").update(`${voice}|${DATA_FORMAT}|r=${rate}|v=${volume}|${text}`).digest("hex").slice(0, 16);
  const safeVoice = voice.replace(/[^a-z0-9]/gi, "");
  const file = path.join(FIXTURE_DIR, `${safeVoice}-${key}.wav`);
  const exists = await stat(file).then((s) => s.size > 0).catch(() => false);
  if (!exists) {
    const args = ["-v", voice, "-o", file, "--data-format", DATA_FORMAT];
    if (rate) args.push("-r", String(rate));
    const sayText = volume != null ? `[[volm ${volume}]] ${text}` : text;
    args.push(sayText);
    await run("say", args);
  }
  return { file, bytes: await readFile(file) };
}

// Confirm a voice is installed (clear error beats a cryptic `say` failure).
export async function assertVoice(voice) {
  const out = await new Promise((resolve) => {
    const child = spawn("say", ["-v", "?"], { stdio: ["ignore", "pipe", "ignore"] });
    let s = ""; child.stdout.on("data", (d) => { s += d.toString(); });
    child.on("close", () => resolve(s));
    child.on("error", () => resolve(""));
  });
  const installed = out.split("\n").some((l) => l.trimStart().startsWith(voice + " ") || l.trimStart().startsWith(voice + "\t"));
  if (!installed) {
    throw new Error(`macOS voice "${voice}" not installed. Add it in System Settings → Accessibility → Spoken Content → System Voices. Available: run \`say -v '?'\`.`);
  }
}

// Allow `node synth.mjs <voice> "<text>"` for ad-hoc generation.
const isDirect = path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
if (isDirect) {
  const [voice = "Joana", ...rest] = process.argv.slice(2);
  const text = rest.join(" ") || "Olá, isto é um teste de voz.";
  assertVoice(voice)
    .then(() => synth(voice, text))
    .then(({ file }) => { console.log(file); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
