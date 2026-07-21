import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const TAILSCALE_SELF_PATH = path.join(
  process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison"),
  "tailscale-self.json"
);
const TAILSCALE_MAC_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

let cachedHostname: string | null = null;

export function resolveTailscaleHostname(): string {
  if (cachedHostname !== null) return cachedHostname;

  if (existsSync(TAILSCALE_SELF_PATH)) {
    try {
      const data = JSON.parse(readFileSync(TAILSCALE_SELF_PATH, "utf8")) as { hostname?: string };
      if (data?.hostname) {
        cachedHostname = data.hostname;
        return cachedHostname;
      }
    } catch { /* fall through */ }
  }

  for (const cmd of ["tailscale", TAILSCALE_MAC_APP_BINARY]) {
    try {
      const result = spawnSync(cmd, ["ip", "--4"], { encoding: "utf8", timeout: 2000 });
      const ip = result.stdout?.trim();
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        cachedHostname = ip;
        return cachedHostname;
      }
    } catch { /* try next */ }
  }

  cachedHostname = os.hostname();
  return cachedHostname;
}

export function isTailscaleResolved(): boolean {
  const h = resolveTailscaleHostname();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(".ts.net");
}

export function computeUrls(
  ports: Record<string, number> | undefined,
  hostname?: string
): Record<string, string> {
  if (!ports) return {};
  const host = hostname ?? resolveTailscaleHostname();
  const urls: Record<string, string> = {};
  for (const [name, port] of Object.entries(ports)) {
    urls[name] = `http://${host}:${port}`;
  }
  return urls;
}

export function _resetTailscaleCacheForTests(): void {
  cachedHostname = null;
}
