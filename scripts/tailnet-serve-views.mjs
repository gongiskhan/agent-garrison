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

import { readdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailscale, tailscaleServeWrite, serveStatus, existingMappings } from "./lib/tailnet-serve-cli.mjs";

const DRY = process.argv.includes("--dry-run");

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

// Serve port = 8400 + (localPort mod 1000). This deliberately IGNORES the
// profile offset — on the mesh that is an INVARIANT, not a hazard: every node
// runs the committed map at offset 0, so the same fitting gets the same serve
// port on every machine, and a peer's view URL is computable as
// https://<peer-host>:<8400 + port%1000> without asking the peer
// (tests/mesh-serve-ports.test.ts pins this). The old aliasing hazard died
// with the offsets; the guard in main() now protects the other half: only the
// NODE profile (offset 0, this machine's real Garrison) may publish — a
// dev/codex sandbox on shifted ports must never own the always-on address.
function pickServePort(localPort, used) {
  let p = 8400 + (localPort % 1000);
  while (used.has(p) || p === 8443 || p === 8444 || p === 8445 || p === 443) p += 1;
  return p;
}

function main() {
  // HARD RULE: only the NODE profile is exposed on the tailnet. Running this
  // from a dev/codex shell would map THAT sandbox's ports onto the always-on
  // address and silently hand tailnet users a sandbox server. "prod" is the
  // legacy alias for node.
  const profile = (process.env.GARRISON_INSTANCE_ID || "").trim();
  if (profile && profile !== "node" && profile !== "prod" && !process.argv.includes("--force")) {
    console.error(
      `Refusing to publish the '${profile}' instance to the tailnet — only the node profile is served.\n` +
        `Run this from a node shell:  bash scripts/garrison-instance.sh node env\n` +
        `(override with --force only if you know why)`
    );
    process.exitCode = 2;
    return;
  }
  // A machine that never ran the node installer has no mesh identity; publish
  // is how its ports become the mesh's — identity first.
  const nodeJsonPath = path.join(os.homedir(), ".garrison", "node.json");
  if (!existsSync(nodeJsonPath) && !process.argv.includes("--force")) {
    console.error(
      `Refusing to publish: ${nodeJsonPath} does not exist — this machine has no node identity yet.\n` +
        `Run scripts/install-node.sh first (or --force if you know why).`
    );
    process.exitCode = 2;
    return;
  }
  // A TETHERED node (csg) has no tailscale interface of its own - it reaches
  // the tailnet only through its owner's reverse tunnel, and `tailscale serve`
  // here would either fail outright or (worse) publish nothing useful. Its
  // own-port views are published on the OWNER's tailnet host instead, by
  // scripts/tailnet-serve-tether.mjs running there.
  if (existsSync(nodeJsonPath)) {
    try {
      const identity = JSON.parse(readFileSync(nodeJsonPath, "utf8"));
      if (identity?.tethered === true) {
        console.log(`tethered node: views are published by ${identity.tetherHost || "its owner node"}`);
        return;
      }
    } catch {
      /* malformed node.json - fall through to the normal publish path, which
         will fail loudly on its own terms if the identity is unusable */
    }
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
      tailscaleServeWrite(args);
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
