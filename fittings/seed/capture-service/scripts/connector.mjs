#!/usr/bin/env node
// Voice connector - the uniform Garrison connector executor contract over the
// RUNNING capture-service. An automation that transcribes a file or synthesizes
// a line does not talk to Deepgram or ElevenLabs itself: it calls this
// service's POST /stt and POST /tts over loopback, so the automation lane gets
// exactly the backend, cache and config the browser and the phone get (D26).
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no secrets, no network)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result } | { ok:false, error, awaiting_connector }
//
// The service URL comes from the status file the server writes
// ($GARRISON_HOME/ui-fittings/capture-service.json, `url`). CAPTURE_TOKEN is
// the one secret this connector needs (connector.secrets in apm.yml): it is the
// Bearer the service expects, delivered scoped via env, never printed.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { statusFilePath } from "../lib/config.mjs";

export const CATALOG = {
  service: "voice",
  auth: "api_key",
  actions: [
    {
      name: "transcribe",
      args: ["audio_base64", "path", "mime_type", "language"],
      mutates: false,
      description:
        "Speech-to-text: transcribe a recorded clip through the voice layer. audio_base64 suits short clips (under about 100 KB - the automation engine hands args over on the command line); pass path for anything longer."
    },
    {
      name: "synthesize",
      args: ["text", "inline"],
      mutates: false,
      description:
        "Text-to-speech: speaks the text through the configured voice backend and returns the clip's id, its path on the voice layer (/speak/<clip_id>.mp3, content-addressed and cacheable), the byte count and the backend. Pass inline: true to also get audio_base64 - off by default because the automation engine keeps every action result in the run record. One call speaks at most 600 characters (the service's per-request budget, advertised as voice.maxTextChars on /health); split longer text and call once per piece."
    }
  ]
};

const DETAIL_MAX_CHARS = 200;

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

function token(env) {
  const t = (env.CAPTURE_TOKEN ?? "").trim();
  if (!t) throw new NotConnectedError("voice not connected (seal CAPTURE_TOKEN in the Vault)");
  return t;
}

// The running service's base URL, from its status file. Not a connection
// problem (the credential is fine) but a liveness one, so it is a plain error:
// the automation sees "start the composition", not "seal a key".
function serviceUrl(statusFile) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(statusFile, "utf8"));
  } catch {
    throw new Error(`capture-service is not running (no status file at ${statusFile})`);
  }
  const url = typeof raw?.url === "string" ? raw.url.trim().replace(/\/$/, "") : "";
  if (!url) throw new Error(`capture-service status file has no url (${statusFile})`);
  return url;
}

async function failureText(res) {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === "string") {
        return parsed.detail ? `${parsed.error} (${String(parsed.detail).slice(0, DETAIL_MAX_CHARS)})` : parsed.error;
      }
    } catch {
      /* not JSON */
    }
    return text.slice(0, DETAIL_MAX_CHARS);
  } catch {
    return "";
  }
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch, statusFile = null }) {
  const bearer = token(env);
  const base = serviceUrl(statusFile ?? statusFilePath(env));
  const authHeader = { authorization: `Bearer ${bearer}` };
  switch (action) {
    case "transcribe": {
      let audio;
      if (typeof args.audio_base64 === "string" && args.audio_base64.length > 0) {
        audio = Buffer.from(args.audio_base64, "base64");
      } else if (typeof args.path === "string" && args.path.length > 0) {
        audio = readFileSync(args.path);
      } else {
        throw new Error("transcribe needs audio_base64 or path");
      }
      if (audio.length === 0) throw new Error("transcribe: the audio is empty");
      const params = new URLSearchParams();
      if (typeof args.language === "string" && args.language.trim()) params.set("language", args.language.trim());
      const qs = params.size > 0 ? `?${params}` : "";
      const res = await fetchImpl(`${base}/stt${qs}`, {
        method: "POST",
        headers: { ...authHeader, "content-type": args.mime_type || "audio/webm" },
        body: audio
      });
      if (!res.ok) throw new Error(`capture-service /stt ${res.status}: ${await failureText(res)}`);
      const json = await res.json();
      return {
        transcript: typeof json?.transcript === "string" ? json.transcript : "",
        confidence: typeof json?.confidence === "number" ? json.confidence : null,
        language: json?.language ?? null,
        model: json?.model ?? null
      };
    }
    case "synthesize": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) throw new Error("synthesize needs text");
      const res = await fetchImpl(`${base}/tts`, {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({ text, format: "mp3" })
      });
      if (!res.ok) throw new Error(`capture-service /tts ${res.status}: ${await failureText(res)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const clipId = res.headers.get("x-clip-id") ?? null;
      // The bytes stay on the voice layer, addressable by clip id, unless the
      // caller asks for them inline: an automation run record that carried a
      // 100 KB mp3 per spoken line would be the bulk of every run. A service
      // that did not name the clip (no X-Clip-Id) gets the inline form, since
      // there is nothing else to point at.
      const out = {
        clip_id: clipId,
        clip_path: clipId ? `/speak/${clipId}.mp3` : null,
        mime: "audio/mpeg",
        bytes: buf.length,
        backend: res.headers.get("x-voice-backend") ?? null
      };
      if (args.inline === true || !clipId) out.audio_base64 = buf.toString("base64");
      return out;
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    if (!Array.isArray(CATALOG.actions) || CATALOG.actions.length === 0) {
      console.error("catalog empty");
      return 1;
    }
    console.log("connectorOk");
    return 0;
  }
  if (cmd === "catalog") {
    process.stdout.write(JSON.stringify(CATALOG));
    return 0;
  }
  if (cmd === "call") {
    const action = argv[1];
    let args = {};
    if (argv[2]) {
      try {
        args = JSON.parse(argv[2]);
      } catch {
        console.error("args must be JSON");
        return 2;
      }
    }
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
    (err) => {
      console.error(err.stack ?? err.message);
      process.exit(1);
    }
  );
}
