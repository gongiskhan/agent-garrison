#!/usr/bin/env node
// Expose every own-port Fitting view over the HTTPS Tailscale address, so its
// links/embeds work from a phone/iPad on the tailnet (not just localhost).
//
// Own-port views bind 127.0.0.1, so `tailscale serve` must front each one at an
// HTTPS tailnet port (TLS terminated by Tailscale → no mixed content; it proxies
// HTTP/WebSocket/SSE, so the dev-env terminal etc. keep working). Garrison reads
// the resulting `tailscale serve status` (src/lib/tailnet-serve.ts) and hands the
// browser the HTTPS tailnet URL when reached over Tailscale.
//
// Idempotent: skips any local port already served. Serve port = the local port
// itself (same number on and off the box), bumped only on collision.
//
// Usage:  node scripts/tailnet-serve-views.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

function tailscale(args) {
  let lastErr;
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout: 8000 });
    } catch (err) {
      // execFileSync throws on non-zero exit even when stdout is valid (version
      // skew warning). Prefer captured stdout if it looks like JSON.
      const out = err?.stdout;
      if (typeof out === "string" && out.includes("{")) return out;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("tailscale CLI not found");
}

function serveStatus() {
  try {
    const raw = tailscale(["serve", "status", "--json"]);
    return JSON.parse(raw.slice(raw.indexOf("{")));
  } catch (err) {
    console.error("Could not read `tailscale serve status --json`:", err?.message ?? err);
    return { Web: {}, TCP: {} };
  }
}

// localPort -> { servePort, url }  and the set of serve ports already in use.
function existingMappings(status) {
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

function ownPortViews() {
  const garrisonHome = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  const dir = path.join(garrisonHome, "ui-fittings");
  let files = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.includes(path.sep));
  } catch {
    return [];
  }
  const views = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (typeof j.fittingId === "string" && typeof j.port === "number") {
        views.push({ fittingId: j.fittingId, port: j.port });
      }
    } catch {
      /* skip malformed */
    }
  }
  // Stable order, unique by port.
  const seen = new Set();
  return views
    .filter((v) => (seen.has(v.port) ? false : (seen.add(v.port), true)))
    .sort((a, b) => a.port - b.port);
}

// Serve port = the local port itself. The user's rule: one number per thing,
// identical on every machine — localhost:7777 on the Mac and mac-host:7777
// off-box are the same service. Tailscale listens on the tailnet address, the
// fitting on 127.0.0.1, so the identical numbers never collide; and dev (7xxx)
// vs prod (8xxx) are distinct by the profile offset, so both publish safely.
function pickServePort(localPort, used) {
  let p = localPort;
  while (used.has(p) || p === 8443 || p === 8444 || p === 8445 || p === 443) p += 1;
  return p;
}

function main() {
  // HARD RULE: only the prod instance is exposed on the tailnet. Running this
  // from a dev/codex shell would map THAT instance's ports onto the always-on
  // address and silently hand tailnet users a dev server.
  const profile = (process.env.GARRISON_INSTANCE_ID || "").trim();
  if (profile && profile !== "prod" && profile !== "dev" && !process.argv.includes("--force")) {
    console.error(
      `Refusing to publish the '${profile}' instance to the tailnet — only prod is served.\n` +
        `Run this from a prod shell:  bash scripts/garrison-instance.sh prod env\n` +
        `(override with --force only if you know why)`
    );
    process.exitCode = 2;
    return;
  }

  const status = serveStatus();
  const { byLocal, usedServePorts } = existingMappings(status);
  const views = ownPortViews();
  // The app servers (7777 dev / 8777 prod) are mapped by hand and persist in
  // tailscaled state; this script only tracks fittings.

  if (views.length === 0) {
    console.log("No own-port views found in ~/.garrison/ui-fittings — start the operative first.");
    return;
  }

  console.log(`Found ${views.length} own-port view(s). Ensuring tailscale serve mappings...\n`);
  const result = [];
  for (const v of views) {
    const existing = byLocal.get(v.port);
    if (existing) {
      result.push({ ...v, servePort: existing.servePort, url: existing.url, action: "kept" });
      continue;
    }
    const servePort = pickServePort(v.port, usedServePorts);
    usedServePorts.add(servePort);
    const args = ["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${v.port}`];
    if (DRY) {
      result.push({ ...v, servePort, url: `(dry-run)`, action: "would-add" });
      continue;
    }
    try {
      tailscale(args);
      result.push({ ...v, servePort, action: "added" });
    } catch (err) {
      result.push({ ...v, servePort, action: "FAILED: " + (err?.message ?? err) });
    }
  }

  // Re-read so printed URLs are authoritative.
  const fresh = existingMappings(serveStatus()).byLocal;
  let host = "<tailnet-host>";
  try {
    const st = JSON.parse(tailscale(["status", "--json"]).replace(/^[^{]*/, ""));
    host = (st.Self?.DNSName ?? host).replace(/\.$/, "");
  } catch { /* keep placeholder */ }

  console.log("Fitting            local   tailnet URL");
  console.log("-----------------  ------  ------------------------------------------");
  for (const r of result) {
    const m = fresh.get(r.port);
    const url = m ? m.url : (r.url ?? `https://${host}:${r.servePort}`);
    console.log(`${r.fittingId.padEnd(17)}  ${String(r.port).padEnd(6)}  ${url}   [${r.action}]`);
  }
  console.log(
    `\nDone.${DRY ? " (dry-run — no changes made)" : ""} Garrison will now link these views to their HTTPS tailnet URLs when reached over Tailscale.`
  );
}

main();
