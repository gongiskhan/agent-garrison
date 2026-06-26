#!/usr/bin/env node
// Deepgram connector — the uniform Garrison connector executor contract, exposing
// Deepgram's transcribe (speech-to-text) and synthesize (text-to-speech) as
// catalog actions alongside the Fitting's own-port voice server (which serves the
// live /stt//tts//stream surface web-channel consumes). The connector path is for
// automations: transcribe an audio file, or synthesize speech to a file.
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no secrets)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result } | { ok:false, awaiting_connector }
//
// DEEPGRAM_API_KEY arrives scoped via env (the Vault materializes only this
// connector's secret_scope); it never appears in the manifest or logs.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CATALOG = {
  service: "deepgram",
  auth: "api_key",
  actions: [
    { name: "transcribe", args: ["audio_base64", "path", "mime_type", "model"], mutates: false, description: "Speech-to-text: transcribe audio." },
    { name: "synthesize", args: ["text", "model"], mutates: false, description: "Text-to-speech: returns base64 audio." }
  ]
};

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

function key(env) {
  const k = env.DEEPGRAM_API_KEY;
  if (!k) throw new NotConnectedError("Deepgram not connected (seal DEEPGRAM_API_KEY in the Vault)");
  return k;
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  const apiKey = key(env);
  const authHeader = { Authorization: `Token ${apiKey}` };
  switch (action) {
    case "transcribe": {
      const audio = args.audio_base64
        ? Buffer.from(args.audio_base64, "base64")
        : Buffer.from(readFileSync(args.path));
      const model = encodeURIComponent(args.model ?? "nova-2");
      const res = await fetchImpl(`https://api.deepgram.com/v1/listen?model=${model}&smart_format=true`, {
        method: "POST",
        headers: { ...authHeader, "content-type": args.mime_type ?? "audio/wav" },
        body: audio
      });
      if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const transcript = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      return { transcript, raw: json };
    }
    case "synthesize": {
      const model = encodeURIComponent(args.model ?? "aura-asteria-en");
      const res = await fetchImpl(`https://api.deepgram.com/v1/speak?model=${model}`, {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({ text: args.text ?? "" })
      });
      if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { audio_base64: buf.toString("base64"), bytes: buf.length };
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    if (!Array.isArray(CATALOG.actions) || CATALOG.actions.length === 0) { console.error("catalog empty"); return 1; }
    console.log("connectorOk");
    return 0;
  }
  if (cmd === "catalog") { process.stdout.write(JSON.stringify(CATALOG)); return 0; }
  if (cmd === "call") {
    const action = argv[1];
    let args = {};
    if (argv[2]) { try { args = JSON.parse(argv[2]); } catch { console.error("args must be JSON"); return 2; } }
    try {
      const result = await runAction({ action, args });
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return 0;
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message, awaiting_connector: Boolean(err.awaiting_connector) }));
      return 1;
    }
  }
  console.error("usage: connector.mjs --probe | catalog | call <action> [argsJson]");
  return 2;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => { console.error(err.stack ?? err.message); process.exit(1); }
  );
}
