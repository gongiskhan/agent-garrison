import { execFile } from "node:child_process";

// Reads the machine's `tailscale serve` config and maps each proxied LOCAL port
// to the HTTPS tailnet URL it is exposed at. Own-port Fittings bind 127.0.0.1
// and are NOT reachable over Tailscale by themselves; when the user (or
// scripts/tailnet-serve-views.mjs) maps a view's port via `tailscale serve`,
// this lets Garrison hand the browser the reachable HTTPS tailnet URL instead of
// a loopback URL (which would be unreachable + mixed-content-blocked over the
// HTTPS tailnet origin).
//
// Shape from `tailscale serve status --json`:
//   { "Web": { "<host>:<servePort>": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:<localPort>" } } } } }

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

const CACHE_TTL_MS = 10_000;
let cache: { at: number; map: Map<number, string> } | null = null;

interface ServeStatus {
  Web?: Record<
    string,
    { Handlers?: Record<string, { Proxy?: string }> }
  >;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // The CLI prints a version-skew warning to stderr but still returns valid
      // JSON on stdout, so a non-zero-ish exit with usable stdout is fine.
      if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function readServeStatusJson(): Promise<string | null> {
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

// Map of local loopback port -> its HTTPS tailnet URL (e.g. 27086 ->
// "https://host.ts.net:8486"). Empty when Tailscale isn't installed/serving.
export async function getTailnetServeMap(): Promise<Map<number, string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;

  const map = new Map<number, string>();
  const raw = await readServeStatusJson();
  if (raw) {
    try {
      const status = JSON.parse(raw) as ServeStatus;
      for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
        const proxy = web?.Handlers?.["/"]?.Proxy;
        if (!proxy) continue;
        const m = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))/.exec(proxy);
        if (!m) continue;
        const localPort = Number(m[1]);
        if (!Number.isFinite(localPort)) continue;
        // hostPort is "<host>:<servePort>"; build the https URL the browser uses.
        const url = `https://${hostPort}`;
        // First mapping for a local port wins (stable across duplicate handlers).
        if (!map.has(localPort)) map.set(localPort, url);
      }
    } catch {
      // unparseable — leave the map empty
    }
  }

  cache = { at: now, map };
  return map;
}

// The HTTPS tailnet URL for a given local port, or null when not serve-mapped.
export async function tailnetUrlForPort(localPort: number): Promise<string | null> {
  const map = await getTailnetServeMap();
  return map.get(localPort) ?? null;
}
