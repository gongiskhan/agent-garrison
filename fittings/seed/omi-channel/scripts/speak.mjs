#!/usr/bin/env node
//
// speak.mjs - drive the Omi integration end to end as if the user had spoken.
//
// Three injection points, matching the three ways speech actually reaches
// Garrison. Each one enters the system at the same place a real utterance does
// and then FOLLOWS it: the script waits for the downstream effect and prints
// what happened, so a run either shows the card/answer/notification or says
// plainly that nothing arrived.
//
//   say       the realtime pipe (wake word -> spoken command). Posts segments
//             to the live /omi/realtime webhook in Omi's exact wire shape,
//             including the malformed double-'?' query Omi really sends.
//   converse  the conversation pipe, THROUGH THE OMI CLOUD. Writes a real
//             conversation into the user's Omi account via the Developer API;
//             Omi transcribes/structures it and calls our public webhook back.
//             This is the only mode that exercises Omi's own processing.
//   ask       the Omi chat tool (ask_gary), called exactly as Omi calls it.
//
// What this canNOT do, stated so nobody mistakes a green run for more coverage
// than it gives: Omi exposes no inbound audio API, so the `say` path starts at
// the transcript, not at sound. Omi's own speech-to-text is therefore NOT under
// test here - and on this account it is the weakest link (see RUNBOOK). Use
// --garble to at least feed the pipeline the kind of mangled text the real
// transcriber produces.
//
// Usage:
//   node scripts/speak.mjs say "Gary, cria uma tarefa para comprar peixe"
//   node scripts/speak.mjs say "Gary, what is on my board?" --garble --wait 180
//   node scripts/speak.mjs converse "I decided we ship on Friday. Remind me to call the bank."
//   node scripts/speak.mjs ask "which cards are in progress?"
//
// Options:
//   --base <url>     omi-channel base URL (default: from the status file)
//   --wait <sec>     how long to wait for downstream effects (default 120)
//   --garble         interleave the unrelated background speech a real
//                    always-on mic picks up (drawn from actual captures)
//   --clean-url      use a well-formed query instead of Omi's malformed one
//   --quiet          only print the verdict

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const mode = argv[0];
const text = argv.find((a, i) => i > 0 && !a.startsWith("--")) ?? "";
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const has = (name) => argv.includes(`--${name}`);
const QUIET = has("quiet");
const WAIT_MS = Number(flag("wait", 120)) * 1000;

const say = (...a) => {
  if (!QUIET) console.log(...a);
};

if (!["say", "converse", "ask"].includes(mode) || !text) {
  console.error(
    "usage: speak.mjs <say|converse|ask> \"<text>\" [--base URL] [--wait SEC] [--garble] [--clean-url] [--quiet]"
  );
  process.exit(2);
}

// ---- environment ------------------------------------------------------------

const HOME = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
const OMI_DIR = process.env.GARRISON_OMI_DIR?.trim() || path.join(HOME, "omi");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Secrets come from the composition's materialized .env - the same file the
// runner delivers to the fitting at spawn. Reading it here (rather than taking
// keys on the command line) keeps secrets out of shell history and process args.
function loadSecrets() {
  const explicit = process.env.GARRISON_COMPOSITION_DIR?.trim();
  const candidates = [
    explicit && path.join(explicit, ".env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "compositions/default/.env"),
    path.resolve(new URL("../../../../compositions/default/.env", import.meta.url).pathname)
  ].filter(Boolean);
  const out = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at <= 0) continue;
      const k = line.slice(0, at).trim();
      if (k.startsWith("OMI_") && !out[k]) out[k] = line.slice(at + 1).trim();
    }
    if (Object.keys(out).length) break;
  }
  for (const k of ["OMI_WEBHOOK_SECRET", "OMI_DEV_API_KEY", "OMI_APP_ID", "OMI_IMPORT_API_KEY"]) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

const secrets = loadSecrets();
const status = readJson(path.join(HOME, "ui-fittings", "omi-channel.json"), {});
const BASE = String(flag("base", status?.url || "http://127.0.0.1:7094")).replace(/\/$/, "");
const UID = readJson(path.join(OMI_DIR, "state.json"), {})?.pinnedUid;

function requireValue(value, what) {
  if (!value) {
    console.error(`speak.mjs: missing ${what}. Is the composition up and the vault unlocked?`);
    process.exit(1);
  }
  return value;
}

// ---- the wire shape ---------------------------------------------------------

// Omi appends the uid with a SECOND '?' instead of '&', so the key parameter
// arrives carrying the uid glued to it. The fitting repairs this; reproducing it
// here is deliberate - a harness that sends a clean URL would not exercise the
// repair, and the repair is load-bearing on every single realtime delivery.
function realtimeUrl(sessionId) {
  const key = encodeURIComponent(requireValue(secrets.OMI_WEBHOOK_SECRET, "OMI_WEBHOOK_SECRET"));
  const uid = encodeURIComponent(requireValue(UID, "pinned uid (omi/state.json)"));
  return has("clean-url")
    ? `${BASE}/omi/realtime?key=${key}&uid=${uid}&session_id=${sessionId}`
    : `${BASE}/omi/realtime?key=${key}?uid=${uid}&session_id=${sessionId}`;
}

// Real background speech from this account's own captures: television, family,
// and the transcriber's own hallucinated filler. Interleaving it is what turns a
// clean sentence into the signal-to-noise ratio the wake bus actually faces.
const BACKGROUND = [
  "Vamos, vamos.",
  "O que é que te estás a fazer, Laura?",
  "Está com mais na boca?",
  "Ação ao risco, de Portugal noventa e oito por é positivo.",
  "Denk goed na.",
  "Isso, e depois logo se vê.",
  "Não, não, espera aí."
];

// Omi delivers a sentence as several short segments with real gaps, not as one
// tidy string - the capture window's timing behaviour only gets exercised if the
// harness fragments the same way.
function toSegments(sentence, { garble }) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const segments = [];
  let t = 0;
  let i = 0;
  let noise = 0;
  while (i < words.length) {
    const take = 2 + Math.floor(((i * 7919) % 5)); // deterministic 2-6 words
    const chunk = words.slice(i, i + take).join(" ");
    i += take;
    const dur = Math.max(0.6, chunk.length / 12);
    segments.push({ text: chunk, speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: t, end: t + dur });
    t += dur + 0.2;
    if (garble && i < words.length && segments.length % 3 === 0) {
      const line = BACKGROUND[noise++ % BACKGROUND.length];
      const d = Math.max(0.6, line.length / 12);
      // Attributed to another speaker, exactly as the real transcript does -
      // and often mis-attributed, which is why the classifier gets context.
      segments.push({ text: line, speaker: "SPEAKER_01", speakerId: 1, is_user: false, start: t, end: t + d });
      t += d + 0.2;
    }
  }
  return segments;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mode: say (realtime / wake) -------------------------------------------

function newestFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs }));
}

async function waitForNew(dir, before, deadline, label) {
  const seen = new Set(before.map((x) => x.f));
  while (Date.now() < deadline) {
    for (const { f } of newestFiles(dir)) {
      if (!seen.has(f)) return { file: path.join(dir, f), name: f };
    }
    await sleep(1500);
  }
  say(`  (no ${label} within the wait window)`);
  return null;
}

async function runSay() {
  const sessionId = `speak-${Date.now()}`;
  const segments = toSegments(text, { garble: has("garble") });
  const url = realtimeUrl(sessionId);
  const resultsDir = path.join(OMI_DIR, "wake-results");
  const before = newestFiles(resultsDir);

  say(`\n[say] session ${sessionId} -> ${BASE}/omi/realtime`);
  say(`[say] ${segments.length} segments${has("garble") ? " (with background speech)" : ""}`);

  // Delivered across several calls, the way Omi streams a conversation.
  for (let i = 0; i < segments.length; i += 2) {
    const batch = segments.slice(i, i + 2);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, segments: batch })
    }).catch((err) => ({ ok: false, status: 0, statusText: String(err?.message ?? err) }));
    if (!res.ok) {
      console.error(`[say] webhook rejected: HTTP ${res.status} ${res.statusText ?? ""}`);
      process.exit(1);
    }
    say(`  -> ${batch.map((s) => JSON.stringify(s.text)).join(" ")}`);
    await sleep(700);
  }

  say(`[say] delivered; waiting for the capture window to close and Gary to answer...`);
  const deadline = Date.now() + WAIT_MS;
  const hit = await waitForNew(resultsDir, before, deadline, "wake result");
  if (!hit) return { ok: false, reason: "no wake result - was the wake word recognised?" };

  const result = readJson(hit.file, {});
  say(`\n[wake] command assembled: ${JSON.stringify(result.command)}`);
  say(`[wake] intent: ${result.intent ?? "(none)"}`);
  for (const [k, v] of Object.entries(result)) {
    if (!["command", "eventId", "intent"].includes(k)) say(`[wake] ${k}: ${JSON.stringify(v)}`);
  }

  // A delegated request answers later, on a second notification - follow it too,
  // otherwise the run would report "on it" as if that were the outcome.
  if (result.intent === "delegate") {
    const eventId = hit.name.replace(/\.json$/, "");
    const file = path.join(resultsDir, `${eventId}.delegate.json`);
    say(`\n[delegate] handed to the operative; waiting for the answer...`);
    while (Date.now() < deadline && !existsSync(file)) await sleep(2000);
    if (!existsSync(file)) {
      return { ok: false, reason: `delegated, but no answer within ${WAIT_MS / 1000}s` };
    }
    const d = readJson(file, {});
    say(`[delegate] request: ${JSON.stringify(d.request)}`);
    say(`[delegate] answered in ${Math.round((d.elapsedMs ?? 0) / 1000)}s: ${d.reply}`);
    return { ok: d.ok !== false, reply: d.reply };
  }
  return { ok: true, intent: result.intent };
}

// ---- mode: converse (through the Omi cloud) --------------------------------

async function runConverse() {
  const key = requireValue(secrets.OMI_DEV_API_KEY, "OMI_DEV_API_KEY");
  const started = new Date(Date.now() - 60_000).toISOString();
  say(`\n[converse] writing a conversation into the Omi cloud...`);
  const res = await fetch("https://api.omi.me/v1/dev/user/conversations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      started_at: started,
      finished_at: new Date().toISOString(),
      text_source: "audio_transcript",
      text_source_spec: "phone_call"
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[converse] Omi refused: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  const conversationId = body.id;
  say(`[converse] Omi created conversation ${conversationId} (${body.status})`);

  // Omi now runs its own structuring and calls our webhook. Watch for the event
  // carrying this conversation id - that is the proof the round trip closed.
  const eventsDir = path.join(OMI_DIR, "events");
  const deadline = Date.now() + WAIT_MS;
  let event = null;
  while (Date.now() < deadline && !event) {
    for (const { f } of newestFiles(eventsDir)) {
      const d = readJson(path.join(eventsDir, f), {});
      if (d?.provenance?.omi_conversation_id === conversationId) {
        event = { id: d.id, doc: d };
        break;
      }
    }
    if (!event) await sleep(2000);
  }
  if (!event) return { ok: false, reason: "Omi never called our webhook back" };

  const n = event.doc.normalized ?? {};
  say(`\n[webhook] arrived as event ${event.id}`);
  say(`[webhook] Omi's title: ${JSON.stringify(n.title)}`);
  say(`[webhook] Omi's action items: ${JSON.stringify((n.action_items ?? []).map((a) => a.description))}`);

  say(`\n[triage] waiting for the triage tick to classify it...`);
  while (Date.now() < deadline) {
    const d = readJson(path.join(eventsDir, `${event.id}.json`), {});
    if (d.status && d.status !== "pending") {
      say(`[triage] status: ${d.status}${d.drop_reason ? ` (${d.drop_reason})` : ""}`);
      if (d.triage_result_ref) {
        const r = readJson(path.join(OMI_DIR, d.triage_result_ref), {});
        say(`[triage] result: ${JSON.stringify(r).slice(0, 600)}`);
      }
      return { ok: d.status === "triaged", status: d.status };
    }
    await sleep(3000);
  }
  return { ok: false, reason: "still pending - is the omi-triage scheduler job running?" };
}

// ---- mode: ask (the Omi chat tool) -----------------------------------------

async function runAsk() {
  const key = requireValue(secrets.OMI_WEBHOOK_SECRET, "OMI_WEBHOOK_SECRET");
  const url = `${BASE}/omi/chat?key=${encodeURIComponent(key)}`;
  say(`\n[ask] calling the chat tool exactly as Omi does...`);
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uid: requireValue(UID, "pinned uid"),
      app_id: secrets.OMI_APP_ID,
      tool_name: "ask_gary",
      query: text
    })
  });
  const body = await res.json().catch(() => ({}));
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  say(`[ask] HTTP ${res.status} in ${elapsed}s`);
  say(`[ask] ${JSON.stringify(body)}`);
  if (body.error) return { ok: false, reason: body.error };

  // An escalated question answers on a notification, not in this response.
  if (/looking into that/i.test(String(body.result ?? ""))) {
    const resultsDir = path.join(OMI_DIR, "chat-results");
    const before = newestFiles(resultsDir);
    say(`\n[ask] escalated to the operative; waiting for the real answer...`);
    const hit = await waitForNew(resultsDir, before, Date.now() + WAIT_MS, "answer");
    if (!hit) return { ok: false, reason: "escalated, but no answer arrived" };
    const d = readJson(hit.file, {});
    say(`[ask] answered in ${Math.round((d.elapsedMs ?? 0) / 1000)}s and pushed to the wearer`);
    return { ok: true, answer: d.reply };
  }
  return { ok: true, answer: body.result };
}

// ---- run --------------------------------------------------------------------

const outcome = await (mode === "say" ? runSay() : mode === "converse" ? runConverse() : runAsk());
if (outcome.ok) {
  console.log(`\nOK${outcome.answer ? `: ${outcome.answer}` : outcome.reply ? `: ${outcome.reply}` : ""}`);
  process.exit(0);
}
console.error(`\nFAILED: ${outcome.reason ?? "see above"}`);
process.exit(1);
