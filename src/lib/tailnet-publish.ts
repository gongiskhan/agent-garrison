// Publish a machine-local own-port fitting to the HTTPS tailnet via
// `tailscale serve`, so its view/links work from a phone/iPad on the tailnet
// (issue #6: a fitting started AFTER the last redeploy was unpublished until
// scripts/tailnet-serve-views.mjs re-ran). The lifecycle calls
// publishPortToTailnet(port) on start (prod-only, gated by the CALLER); the
// embed "Publish now" route calls it on demand.
//
// Deterministic serve port = 8400 + (localPort % 1000), bumped on collision -
// identical to scripts/tailnet-serve-views.mjs, which stays the redeploy-time
// batch publisher. (The .ts lib and the .mjs script are parallel by the same
// house rule that keeps tailnet-serve triplicated: the script runs under bare
// node, the lib under the Next toolchain.)

import { execFile } from "node:child_process";

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // The CLI prints a version-skew warning to stderr but returns valid output
      // on stdout, so a non-zero exit with usable stdout is fine.
      if (stdout && stdout.trim()) return resolve(stdout);
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function tailscale(args: string[]): Promise<string> {
  let lastErr: unknown;
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      return await run(bin, args);
    } catch (err) {
      const out = (err as { stdout?: string })?.stdout;
      if (typeof out === "string" && out.includes("{")) return out;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("tailscale CLI not found");
}

interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

async function serveStatus(): Promise<ServeStatus> {
  try {
    const raw = await tailscale(["serve", "status", "--json"]);
    return JSON.parse(raw.slice(raw.indexOf("{"))) as ServeStatus;
  } catch {
    return { Web: {} };
  }
}

// localPort -> { servePort, url }, and every serve port already in use.
function existingMappings(status: ServeStatus): {
  byLocal: Map<number, { servePort: number; url: string }>;
  usedServePorts: Set<number>;
} {
  const byLocal = new Map<number, { servePort: number; url: string }>();
  const usedServePorts = new Set<number>();
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    const servePort = Number(hostPort.split(":").pop());
    if (Number.isFinite(servePort)) usedServePorts.add(servePort);
    const proxy = web?.Handlers?.["/"]?.Proxy;
    const m = proxy ? /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy) : null;
    if (m) byLocal.set(Number(m[1]), { servePort, url: `https://${hostPort}` });
  }
  return { byLocal, usedServePorts };
}

// Serve port = 8400 + (localPort mod 1000), bumped past collisions and the
// reserved 8443/8444/8445/443. Deliberately profile-agnostic (prod 8086 and dev
// 7086 both want 8486) - safe ONLY because the tailnet fronts prod alone.
export function pickServePort(localPort: number, used: Set<number>): number {
  let p = 8400 + (localPort % 1000);
  while (used.has(p) || p === 8443 || p === 8444 || p === 8445 || p === 443) p += 1;
  return p;
}

export interface PublishResult {
  localPort: number;
  servePort: number;
  url: string;
  action: "kept" | "added" | "failed";
  error?: string;
}

// Idempotently ensure `localPort` is fronted by `tailscale serve`. Returns the
// existing mapping ("kept") when already served, else creates one ("added").
// The CALLER is responsible for the prod-only guard.
export async function publishPortToTailnet(localPort: number): Promise<PublishResult> {
  const { byLocal, usedServePorts } = existingMappings(await serveStatus());
  const existing = byLocal.get(localPort);
  if (existing) {
    return { localPort, servePort: existing.servePort, url: existing.url, action: "kept" };
  }
  const servePort = pickServePort(localPort, usedServePorts);
  try {
    await tailscale(["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${localPort}`]);
  } catch (err) {
    return {
      localPort,
      servePort,
      url: "",
      action: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // Re-read so the returned URL is authoritative (carries the tailnet host).
  const fresh = existingMappings(await serveStatus()).byLocal.get(localPort);
  return { localPort, servePort, url: fresh?.url ?? "", action: "added" };
}
