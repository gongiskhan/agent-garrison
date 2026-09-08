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
function internalToken(env) {
  try {
    const home = env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// Self-resolve a freshly-refreshed access token from Garrison when nothing
// pre-injected it. Mirrors the engine's auth-env fetch: POST with the internal
// token; a non-2xx (incl. 409 not-connected) yields {} so the caller falls
// through to awaiting_connector.
async function fetchInjectedEnv(env, fetchImpl, signal) {
  // No port literal (HARD RULE: a fitting must be TOLD a peer address, never
  // guess it). The runner projects GARRISON_APP_URL; the legacy
  // GARRISON_BASE_URL alias is also accepted. Without either there is no way
  // to know WHICH instance to ask, and a baked 7777 asked DEV on prod"s behalf.
  // Absent env falls through exactly like an absent token: {} -> the caller
  // reports awaiting_connector instead of crossing instances.
  const base = (env.GARRISON_APP_URL || env.GARRISON_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return {};
  const tok = internalToken(env);
  if (!tok) return {};
  try {
    signal.throwIfAborted();
    const res = await fetchImpl(`${base}/api/connectors/spotify/auth-env`, {
      method: "POST",
      headers: { "x-garrison-internal": tok },
      signal,
      redirect: "error"
    });
    signal.throwIfAborted();
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return {};
    }
    const json = await res.json();
    signal.throwIfAborted();
    return json?.env ?? {};
  } catch {
    signal.throwIfAborted();
    return {};
  }
}

async function resolveToken(env, fetchImpl, signal) {
  let t = env.SPOTIFY_ACCESS_TOKEN;
  if (!t) t = (await fetchInjectedEnv(env, fetchImpl, signal)).SPOTIFY_ACCESS_TOKEN;
  if (typeof t !== "string" || !t.trim()) throw new NotConnectedError("Spotify not connected (connect via OAuth so the Vault holds a grant)");
  return t.trim();
}

const API = "https://api.spotify.com/v1";

// One HTTP call to the Web API. 204 (the common response for control endpoints)
// and empty bodies return {}. Common failures get a human hint appended so the
// Operative can tell the user something actionable instead of a bare status.
function makeCall(access, fetchImpl, signal) {
  return async (method, p, body) => {
    signal.throwIfAborted();
    let res;
    try {
      res = await fetchImpl(API + p, {
        method,
        headers: {
          Authorization: `Bearer ${access}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
        redirect: "error"
      });
    } catch {
      signal.throwIfAborted();
      throw new Error("Spotify request failed; check the connection before trying again");
    }
    signal.throwIfAborted();
    if (res.status === 204) return {};
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      if (res.status === 401) throw new NotConnectedError("Spotify token rejected (reconnect the connector)");
      if (res.status === 403) throw new Error("Spotify refused (403) — check Premium, the app's allowed users and the granted scopes");
      if (res.status === 404 && p.startsWith("/me/player")) throw new Error("No active Spotify device — open the Spotify app on the target device, then try again.");
      if (res.status === 429) throw new Error("Spotify rate limit reached (429); wait before trying again");
      // Never copy a provider body or transport exception into the caller's log.
      throw new Error(`Spotify request failed (HTTP ${res.status})`);
    }
    let text;
    try { text = await res.text(); } catch {
      signal.throwIfAborted();
      throw new Error("Spotify response could not be read");
    }
    signal.throwIfAborted();
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new Error("Spotify returned an invalid JSON response"); }
  };
}

// No preference means Spotify's currently active device (omit device_id).
// A preference must resolve to one controllable device; never silently play
// elsewhere when that device is missing or its name matches several devices.
async function resolveDeviceId(call, env) {
  const want = String(env.GARRISON_SPOTIFY_DEVICE_NAME ?? env.SPOTIFY_DEVICE_NAME ?? "").trim().toLowerCase();
  if (!want) return null;
  const d = await call("GET", "/me/player/devices");
  const devices = Array.isArray(d?.devices) ? d.devices.filter(Boolean) : [];
  const exact = devices.filter((x) => String(x.name || "").trim().toLowerCase() === want);
  const matches = exact.length ? exact : devices.filter((x) => String(x.name || "").toLowerCase().includes(want));
  if (!matches.length) throw new Error("Preferred Spotify device unavailable; open Spotify on that device or update the device name");
  if (matches.length !== 1) throw new Error("Preferred Spotify device name is ambiguous; use its exact name");
  const device = matches[0];
  if (device.is_restricted || typeof device.id !== "string" || !device.id.trim()) throw new Error("Preferred Spotify device cannot be controlled through the Web API");
  return device.id;
}

function marketQuery(env) {
  const market = String(env.GARRISON_SPOTIFY_MARKET ?? env.SPOTIFY_MARKET ?? "").trim().toUpperCase();
  if (!market) return "";
  if (!/^[A-Z]{2}$/.test(market)) throw new Error("Spotify market must be a two-letter country code");
  return `&market=${market}`;
}

// Body for a play request from free text: prefer a track hit (play that track),
// else an artist hit (play the artist's top tracks via its context).
async function resolvePlayFromQuery(call, query, env = process.env) {
  const q = encodeURIComponent(String(query || "").trim());
  if (!q) throw new Error("play needs a query");
  // A user access token supplies its account country. An explicit market, when
  // supplied, is an ISO country code; "from_token" is not a documented value.
  const s = await call("GET", `/search?q=${q}&type=track,artist&limit=5${marketQuery(env)}`);
  const track = s.tracks?.items?.find((item) => item?.uri && item.is_playable !== false);
  if (track) {
    return { body: { uris: [track.uri] }, label: `${track.name} — ${(track.artists || []).map((a) => a.name).join(", ")}` };
  }
  const artist = s.artists?.items?.find((item) => item?.uri);
  if (artist) return { body: { context_uri: artist.uri }, label: `${artist.name} (top tracks)` };
  throw new Error(`Nothing on Spotify matched "${query}"`);
}

function withDevice(p, deviceId) {
  if (!deviceId) return p;
  return p + (p.includes("?") ? "&" : "?") + `device_id=${encodeURIComponent(deviceId)}`;
}

async function executeAction({ action, args, env, fetchImpl, signal }) {
  const access = await resolveToken(env, fetchImpl, signal);
  const call = makeCall(access, fetchImpl, signal);

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
      return (Array.isArray(d?.devices) ? d.devices : []).filter(Boolean).map((x) => ({ id: x.id, name: x.name, is_active: Boolean(x.is_active), is_restricted: Boolean(x.is_restricted) }));
    }
    case "pause": {
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice("/me/player/pause", dev));
      return { paused: true };
    }
    case "resume": {
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice("/me/player/play", dev));
      return { resumed: true, device: dev || "active" };
    }
    case "next": {
      const dev = await resolveDeviceId(call, env);
      await call("POST", withDevice("/me/player/next", dev));
      return { skipped: true };
    }
    case "previous": {
      const dev = await resolveDeviceId(call, env);
      await call("POST", withDevice("/me/player/previous", dev));
      return { back: true };
    }
    case "play": {
      const { body, label } = await resolvePlayFromQuery(call, args.query, env);
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice("/me/player/play", dev), body);
      return { playing: label, device: dev || "active" };
    }
    case "play_uri": {
      const uri = String(args.uri || "").trim();
      if (!/^spotify:(track|album|artist|playlist):[A-Za-z0-9]+$/.test(uri)) throw new Error("play_uri needs a Spotify track, album, artist or playlist URI");
      const body = /^spotify:track:/.test(uri) ? { uris: [uri] } : { context_uri: uri };
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice("/me/player/play", dev), body);
      return { playing: uri, device: dev || "active" };
    }
    case "volume": {
      const value = args.percent;
      const numeric = (typeof value === "number" || (typeof value === "string" && value.trim())) ? Number(value) : NaN;
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) throw new Error("volume needs percent 0-100");
      const pct = Math.round(numeric);
      const dev = await resolveDeviceId(call, env);
      await call("PUT", withDevice(`/me/player/volume?volume_percent=${pct}`, dev));
      return { volume: pct };
    }
    case "search": {
      const q = encodeURIComponent(String(args.query || "").trim());
      if (!q) throw new Error("search needs a query");
      const type = ["track", "artist", "album", "playlist"].includes(args.type) ? args.type : "track";
      const s = await call("GET", `/search?q=${q}&type=${type}&limit=5${marketQuery(env)}`);
      const items = s[`${type}s`]?.items || [];
      return items.filter(Boolean).map((it) => ({
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

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  if (!CATALOG.actions.some((entry) => entry.name === action)) throw new Error(`unknown action: ${action}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be a JSON object");
  // One deadline includes auth, discovery, search and response bodies. Aborting
  // also prevents a delayed read from starting a playback write after return.
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Spotify action timed out; check playback before retrying");
      controller.abort(err);
      reject(err);
    }, 10_000);
  });
  try {
    return await Promise.race([executeAction({ action, args, env, fetchImpl, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
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
