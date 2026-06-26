// Reads the machine's `tailscale serve` config and maps each proxied LOCAL port
// to the HTTPS tailnet URL it is exposed at. Used so /browser-target can hand
// the dev-env UI the browser fitting's reachable HTTPS tailnet URL when the page
// is reached over Tailscale (a raw http://host:7084 would be mixed-content-blocked
// inside the HTTPS dev-env page). Mirror of src/lib/tailnet-serve.ts, in mjs so
// the dev-env fitting (its own process) can use it without importing the app.

import { execFile } from "node:child_process";

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

const CACHE_TTL_MS = 10_000;
let cache = null; // { at, map }

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // The CLI prints a version-skew warning to stderr but returns valid JSON on
      // stdout, so prefer usable stdout even on a non-zero-ish exit.
      if (stdout && stdout.includes("{")) return resolve(stdout);
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

// Map<localPort:number, httpsTailnetUrl:string>. Empty if Tailscale absent.
export async function getTailnetServeMap() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;

  const map = new Map();
  const raw = await readServeStatusJson();
  if (raw) {
    try {
      const status = JSON.parse(raw);
      for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
        const proxy = web?.Handlers?.["/"]?.Proxy;
        if (!proxy) continue;
        const m = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy);
        if (!m) continue;
        const localPort = Number(m[1]);
        if (!Number.isFinite(localPort)) continue;
        if (!map.has(localPort)) map.set(localPort, `https://${hostPort}`);
      }
    } catch {
      // unparseable — empty map
    }
  }

  cache = { at: now, map };
  return map;
}

export async function tailnetUrlForPort(localPort) {
  const map = await getTailnetServeMap();
  return map.get(Number(localPort)) ?? null;
}
