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
// Idempotent: skips any local port already served. Deterministic serve port =
// 8400 + (localPort % 1000) (e.g. 27086 -> 8486), bumped on collision.
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

// The candidate list exists to FIND the binary, so only "this path does not
// exist" may advance it. Any other failure means we found tailscale and it
// refused the command, and that error is the answer - continuing past it walks
// on to paths that cannot exist on this OS and reports THEIR ENOENT instead.
//
// That is not hypothetical: publishing capture-service failed with
// "spawnSync /Applications/Tailscale.app/Contents/MacOS/Tailscale ENOENT" on a
// Linux box that has a perfectly good /usr/bin/tailscale. The real error was a
// 401 from the first candidate, discarded three iterations earlier.
function tailscale(args) {
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout: 8000 });
    } catch (err) {
      // execFileSync throws on non-zero exit even when stdout is valid (version
      // skew warning). Prefer captured stdout if it looks like JSON.
      const out = err?.stdout;
      if (typeof out === "string" && out.includes("{")) return out;
      if (err?.code === "ENOENT") continue; // not installed here; try the next path
      throw enrich(err, bin);
    }
  }
  throw new Error(
    `tailscale CLI not found (looked in: ${TAILSCALE_CANDIDATES.join(", ")})`
  );
}

// `tailscale serve` is privileged. Without this the operator sees a bare 401 and
// has to go and find out that the fix is a one-time operator grant, which is the
// difference between a 30-second fix and an afternoon.
function enrich(err, bin) {
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
  const e = new Error(`${bin} failed: ${String(err?.stderr ?? err?.message ?? err).trim()}`);
  return e;
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

// Serve port = 8400 + (localPort mod 1000). Note this deliberately IGNORES the
// profile offset, so prod's 8086 and dev's 7086 would both want 8486 — they
// alias by construction. That is safe only because the tailnet fronts PROD
// ALONE (see the guard in main()): the always-on address must never resolve to
// a dev server, or an in-progress edit takes the tailnet down.
function pickServePort(localPort, used) {
  let p = 8400 + (localPort % 1000);
  while (used.has(p) || p === 8443 || p === 8444 || p === 8445 || p === 443) p += 1;
  return p;
}

function main() {
  // HARD RULE: only the prod instance is exposed on the tailnet. Running this
  // from a dev/codex shell would map THAT instance's ports onto the always-on
  // address and silently hand tailnet users a dev server.
  const profile = (process.env.GARRISON_INSTANCE_ID || "").trim();
  if (profile && profile !== "prod" && !process.argv.includes("--force")) {
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
      // Row stays one word so the table survives; the reason is printed in full
      // below, where a multi-line remedy can actually be read.
      result.push({ ...v, servePort, action: "FAILED", error: err });
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
  const failed = result.filter((r) => r.action === "FAILED");
  if (failed.length === 0) {
    console.log(
      `\nDone.${DRY ? " (dry-run — no changes made)" : ""} Garrison will now link these views to their HTTPS tailnet URLs when reached over Tailscale.`
    );
    return;
  }

  // An unpublished own-port view is a blank pane for everyone not sitting at
  // this machine, which is almost everyone (see the tailnet rule in CLAUDE.md).
  // It is not a footnote in a table.
  console.error(`\n!! ${failed.length} view(s) NOT published to the tailnet:\n`);
  const seen = new Set();
  for (const r of failed) {
    const msg = String(r.error?.message ?? r.error ?? "unknown error");
    console.error(`  ${r.fittingId} (local ${r.port} -> :${r.servePort})`);
    if (!seen.has(msg)) {
      console.error(`    ${msg.split("\n").join("\n    ")}`);
      seen.add(msg);
    } else {
      console.error("    (same cause as above)");
    }
  }
  console.error(
    "\nThose views are reachable ON this box only. Over HTTPS they render as a\n" +
      "blank pane (plain-HTTP frames are blocked as mixed content). Fix the cause\n" +
      "above and re-run: npm run prod:redeploy  (or node scripts/tailnet-serve-views.mjs)"
  );
  process.exitCode = 1;
}

main();
