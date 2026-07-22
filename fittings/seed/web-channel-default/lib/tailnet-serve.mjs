// Maps machine-local ports to their HTTPS tailnet URLs via `tailscale serve
// status`. Drill hands the browser absolute URLs into the Browser fitting
// (canvas embeds); those are loopback URLs, and the user is usually NOT on the
// machine running Garrison - they reach it from another device over the
// HTTPS tailnet address, where a loopback URL is unreachable and a plain-http
// rebind is mixed content. The server therefore pairs every such URL with its
// tailnet form (when serve-mapped) and the UI picks by where it actually runs.
//
// Fitting-local port of src/lib/tailnet-serve.ts (house convention: own-port
// fittings install independently; there is no cross-fitting lib import path).

import { execFile } from "node:child_process";

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

const CACHE_TTL_MS = 10_000;
let cache = null; // { at, map: Map<localPort, httpsUrl> }

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // The CLI prints a version-skew warning to stderr but still returns
      // valid JSON on stdout, so non-zero exit with usable stdout is fine.
      if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function readServeStatusJson() {
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      const out = await run(bin, ["serve", "status", "--json"]);
      if (out && out.includes("{")) return out.slice(out.indexOf("{"));
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Pure: `tailscale serve status --json` payload -> Map(localPort -> https URL).
// Exported for tests.
export function serveMapFromStatus(status) {
  const map = new Map();
  for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (!proxy) continue;
    const m = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))/.exec(proxy);
    if (!m) continue;
    const localPort = Number(m[1]);
    if (!Number.isFinite(localPort)) continue;
    if (!map.has(localPort)) map.set(localPort, `https://${hostPort}`);
  }
  return map;
}

export async function getTailnetServeMap() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;
  let map = new Map();
  const raw = await readServeStatusJson();
  if (raw) {
    try {
      map = serveMapFromStatus(JSON.parse(raw));
    } catch {
      // unparseable - leave the map empty
    }
  }
  cache = { at: now, map };
  return map;
}

// Pure: the given absolute machine-local URL rehosted at its HTTPS tailnet
// mapping from `map`, or null when its port has no mapping. Path and query
// survive the swap. Exported for tests.
export function rehostToTailnet(absoluteUrl, map) {
  if (!absoluteUrl) return null;
  let url;
  try {
    url = new URL(absoluteUrl);
  } catch {
    return null;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const base = map.get(port);
  if (!base) return null;
  try {
    const b = new URL(base);
    url.protocol = b.protocol;
    url.host = b.host;
    return url.toString();
  } catch {
    return null;
  }
}

// The live form: rehost against this machine's current `tailscale serve`
// config (null when tailscale isn't installed or the port isn't mapped).
export async function toTailnetUrl(absoluteUrl) {
  if (!absoluteUrl) return null;
  return rehostToTailnet(absoluteUrl, await getTailnetServeMap());
}
