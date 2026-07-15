#!/usr/bin/env node
// Spotify connector — the uniform Garrison connector executor contract every
// connector Fitting implements, so any caller (Automations engine, or the
// Operative over bash) drives it the same way:
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no secrets)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result }
//                                                    | { ok:false, error, awaiting_connector }
//
// Auth is OAuth2. A FRESH access token is resolved from the Vault (Garrison
// auto-refreshes the sealed grant) and reaches this call's env as
// SPOTIFY_ACCESS_TOKEN — injected by the engine, or self-resolved here (a direct
// call) from Garrison's /api/connectors/spotify/auth-env route. The token never
// touches the manifest, disk, or the logs (it is redacted).
//
// Two facts the caller must know (surfaced as errors, not silent): playback
// control requires Spotify PREMIUM (Free => 403), and audio plays on whichever
// device runs the Spotify app — with no active device the Web API returns 404,
// which we translate to "open Spotify on the phone".

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG = {
  service: "spotify",
  auth: "oauth2",
  actions: [
    { name: "current", args: [], mutates: false, description: "What is playing now" },
    { name: "devices", args: [], mutates: false, description: "Available Spotify Connect devices" },
    { name: "pause", args: [], mutates: true, description: "Pause playback" },
    { name: "resume", args: [], mutates: true, description: "Resume playback" },
    { name: "next", args: [], mutates: true, description: "Skip to the next track" },
    { name: "previous", args: [], mutates: true, description: "Go back to the previous track" },
    { name: "play", args: ["query"], mutates: true, description: "Search and play best match on the target device" },
    { name: "play_uri", args: ["uri"], mutates: true, description: "Play a specific Spotify URI" },
    { name: "volume", args: ["percent"], mutates: true, description: "Set volume 0-100" },
    { name: "search", args: ["query", "type"], mutates: false, description: "Search the catalog" },
    { name: "transfer", args: ["device_id"], mutates: true, description: "Move playback to a device and play" }
  ]
};

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

// The 0600 per-machine capability token that gates Garrison's auth-env route.
// Absent (or unreadable) => "" and we simply can't self-resolve, which surfaces
// as awaiting_connector below.
function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// Self-resolve a freshly-refreshed access token from Garrison when nothing
// pre-injected it. Mirrors the engine's auth-env fetch: POST with the internal
// token; a non-2xx (incl. 409 not-connected) yields {} so the caller falls
// through to awaiting_connector.
async function fetchInjectedEnv(fetchImpl) {
  const tok = internalToken();
  if (!tok) return {};
  const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777";
  try {
    const res = await fetchImpl(`${base}/api/connectors/spotify/auth-env`, {
      method: "POST",
      headers: { "x-garrison-internal": tok }
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.env ?? {};
  } catch {
    return {};
  }
}

async function resolveToken(env, fetchImpl) {
  let t = env.SPOTIFY_ACCESS_TOKEN;
  if (!t) t = (await fetchInjectedEnv(fetchImpl)).SPOTIFY_ACCESS_TOKEN;
  if (!t) throw new NotConnectedError("Spotify not connected (connect via OAuth so the Vault holds a grant)");
  return t;
}

const API = "https://api.spotify.com/v1";

// One HTTP call to the Web API. 204 (the common response for control endpoints)
// and empty bodies return {}. Common failures get a human hint appended so the
// Operative can tell the user something actionable instead of a bare status.
function makeCall(access, fetchImpl) {
  return async (method, p, body) => {
    const res = await fetchImpl(API + p, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return {};
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new NotConnectedError("Spotify token rejected (reconnect the connector)");
      if (res.status === 403) throw new Error(`Spotify refused (403) — Premium required for playback control, or the token lacks a scope. ${text}`.trim());
      if (res.status === 404) throw new Error("No active Spotify device — open the Spotify app on the phone, then try again.");
      throw new Error(`spotify ${res.status}: ${text}`);
    }
    if (!text) return {};
    // Spotify sometimes answers 2xx with a non-JSON opaque body (e.g. the
    // player control endpoints) — the action succeeded, so treat it as empty.
    try { return JSON.parse(text); } catch { return {}; }
  };
}

// Resolve the device to target. Prefer a configured name (the phone), else the
// active device, else the first available; null when Spotify lists none (caller
// turns that into the "open Spotify" hint). Best-effort — never throws.
async function resolveDeviceId(call, env) {
  const want = String(env.SPOTIFY_DEVICE_NAME || "").trim().toLowerCase();
  let devices = [];
  try {
    const d = await call("GET", "/me/player/devices");
    devices = Array.isArray(d.devices) ? d.devices : [];
  } catch {
    devices = [];
  }
  if (want) {
    const m = devices.find((x) => String(x.name || "").toLowerCase().includes(want));
    if (m) return m.id;
  }
  const active = devices.find((x) => x.is_active);
  if (active) return active.id;
  return devices.length ? devices[0].id : null;
}

// Body for a play request from free text: prefer a track hit (play that track),
// else an artist hit (play the artist's top tracks via its context).
async function resolvePlayFromQuery(call, query, env = process.env) {
  const q = encodeURIComponent(String(query || "").trim());
  if (!q) throw new Error("play needs a query");
  // NB: no `market=from_token` — it requires the user-read-private scope (403
  // "Insufficient client scope" without it, verified 2026-07-15). SPOTIFY_MARKET
  // (ISO country, e.g. PT) scopes results when set; omitted = global catalog.
  const mkt = String(env.SPOTIFY_MARKET || "").trim().toUpperCase();
  const s = await call("GET", `/search?q=${q}&type=track,artist&limit=5${mkt ? `&market=${mkt}` : ""}`);
  const track = s.tracks?.items?.[0];
  if (track) {
    return { body: { uris: [track.uri] }, label: `${track.name} — ${(track.artists || []).map((a) => a.name).join(", ")}` };
  }
  const artist = s.artists?.items?.[0];
  if (artist) return { body: { context_uri: artist.uri }, label: `${artist.name} (top tracks)` };
  throw new Error(`Nothing on Spotify matched "${query}"`);
}

function withDevice(p, deviceId) {
  if (!deviceId) return p;
  return p + (p.includes("?") ? "&" : "?") + `device_id=${encodeURIComponent(deviceId)}`;
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  const access = await resolveToken(env, fetchImpl);
  const call = makeCall(access, fetchImpl);

  switch (action) {
    case "current": {
      const p = await call("GET", "/me/player");
      if (!p || !p.item) return { is_playing: false };
      return {
        is_playing: Boolean(p.is_playing),
        track: p.item?.name ?? null,
        artist: (p.item?.artists || []).map((a) => a.name).join(", ") || null,
        device: p.device?.name ?? null,
        // extras for the HUD's now-playing widget (additive, nothing breaks)
        album: p.item?.album?.name ?? null,
        art: p.item?.album?.images?.[0]?.url ?? null,
        progress_ms: p.progress_ms ?? null,
        duration_ms: p.item?.duration_ms ?? null
      };
    }
    case "devices": {
      const d = await call("GET", "/me/player/devices");
      return (d.devices || []).map((x) => ({ id: x.id, name: x.name, is_active: Boolean(x.is_active) }));
    }
    case "pause":
      await call("PUT", "/me/player/pause");
      return { paused: true };
    case "resume": {
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice("/me/player/play", dev));
      return { resumed: true, device: dev || "active" };
    }
    case "next":
      await call("POST", "/me/player/next");
      return { skipped: true };
    case "previous":
      await call("POST", "/me/player/previous");
      return { back: true };
    case "play": {
      const { body, label } = await resolvePlayFromQuery(call, args.query, env);
      const dev = await resolveDeviceId(call, env);
      if (!dev) throw new Error("No Spotify device available — open the Spotify app on the phone, then try again.");
      await call("PUT", withDevice("/me/player/play", dev), body);
      return { playing: label, device: dev };
    }
    case "play_uri": {
      const uri = String(args.uri || "").trim();
      if (!uri) throw new Error("play_uri needs a uri");
      const body = /^spotify:track:/.test(uri) ? { uris: [uri] } : { context_uri: uri };
      const dev = await resolveDeviceId(call, env);
      if (!dev) throw new Error("No Spotify device available — open the Spotify app on the phone, then try again.");
      await call("PUT", withDevice("/me/player/play", dev), body);
      return { playing: uri, device: dev };
    }
    case "volume": {
      const pct = Math.max(0, Math.min(100, Math.round(Number(args.percent))));
      if (!Number.isFinite(pct)) throw new Error("volume needs percent 0-100");
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice(`/me/player/volume?volume_percent=${pct}`, dev));
      return { volume: pct };
    }
    case "search": {
      const q = encodeURIComponent(String(args.query || "").trim());
      if (!q) throw new Error("search needs a query");
      const type = ["track", "artist", "album", "playlist"].includes(args.type) ? args.type : "track";
      const s = await call("GET", `/search?q=${q}&type=${type}&limit=5&market=from_token`);
      const items = s[`${type}s`]?.items || [];
      return items.map((it) => ({
        name: it.name,
        uri: it.uri,
        by: (it.artists || []).map((a) => a.name).join(", ") || undefined
      }));
    }
    case "transfer": {
      const id = String(args.device_id || "").trim();
      if (!id) throw new Error("transfer needs a device_id (see `devices`)");
      await call("PUT", "/me/player", { device_ids: [id], play: true });
      return { transferred_to: id };
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    // Verify must not require live secrets — just confirm the executor + catalog.
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
      try { args = JSON.parse(argv[2]); }
      catch { console.error("args must be JSON"); return 2; }
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
    (err) => { console.error(err.stack ?? err.message); process.exit(1); }
  );
}
