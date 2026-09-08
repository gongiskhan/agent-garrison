// Shared `tailscale serve` CLI plumbing, extracted from
// scripts/tailnet-serve-views.mjs so scripts/tailnet-serve-tether.mjs (the
// tethered-node analog, publishing an OWNER node's forwarded csg ports rather
// than its own fitting views) can reuse the identical binary-resolution,
// privilege-escalation, and status-read logic rather than a second copy that
// drifts. `pickServePort` and the own-port-view discovery stay in the views
// script - they are specific to that one caller.

import { execFileSync } from "node:child_process";

export const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

// `tailscale serve` is privileged. Without this the operator sees a bare 401
// and has to go find out that the fix is a one-time operator grant, which is
// the difference between a 30-second fix and an afternoon.
export function enrich(err, bin) {
  const text = `${err?.stderr ?? ""}${err?.message ?? ""}`;
  if (/must be root|operator|401 Unauthorized/i.test(text)) {
    const e = new Error(
      `${bin} refused the command: ${String(err?.stderr ?? err?.message ?? "").trim()}\n` +
        `    -> \`tailscale serve\` is privileged. Grant it once with:\n` +
        `         sudo tailscale set --operator=$USER\n` +
        `       after which redeploys publish new views without sudo.`
    );
    e.actionable = true;
    return e;
  }
  return new Error(`${bin} failed: ${String(err?.stderr ?? err?.message ?? err).trim()}`);
}

// The candidate list exists to FIND the binary, so only "this path does not
// exist" may advance it. Any other failure means we found tailscale and it
// refused the command, and that error is the answer - continuing past it
// walks on to paths that cannot exist on this OS and reports THEIR ENOENT
// instead (caught live: a Linux box's real 401 was discarded three candidate
// paths before the loop finally gave up on macOS-only ones).
export function tailscale(args) {
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout: 8000 });
    } catch (err) {
      const out = err?.stdout;
      if (typeof out === "string" && out.includes("{")) return out;
      if (err?.code === "ENOENT") continue;
      throw enrich(err, bin);
    }
  }
  throw new Error(`tailscale CLI not found (looked in: ${TAILSCALE_CANDIDATES.join(", ")})`);
}

// tailscale >=1.98 requires root (or a sudo-capable operator) for EVERY serve
// config write. Reads never elevate; writes try plain first, then `sudo -n`
// (the sudoers NOPASSWD entry for /usr/bin/tailscale).
export function tailscaleServeWrite(args) {
  try {
    return tailscale(args);
  } catch (err) {
    if (!String(err?.message ?? err).includes("401")) throw err;
    try {
      return execFileSync("sudo", ["-n", "tailscale", ...args], { encoding: "utf8", timeout: 8000 });
    } catch {
      throw enrich(err, "tailscale");
    }
  }
}

export function serveStatus() {
  try {
    const raw = tailscale(["serve", "status", "--json"]);
    return JSON.parse(raw.slice(raw.indexOf("{")));
  } catch (err) {
    console.error("Could not read `tailscale serve status --json`:", err?.message ?? err);
    return { Web: {}, TCP: {} };
  }
}

// localPort -> { servePort, url }  and the set of serve ports already in use.
export function existingMappings(status) {
  const byLocal = new Map();
  const usedServePorts = new Set();
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    const servePort = Number(hostPort.split(":").pop());
    if (Number.isFinite(servePort)) usedServePorts.add(servePort);
    const proxy = web?.Handlers?.["/"]?.Proxy;
    const m = proxy && /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy);
    if (m) byLocal.set(Number(m[1]), { servePort, url: `https://${hostPort}` });
  }
  return { byLocal, usedServePorts };
}
