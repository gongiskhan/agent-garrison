#!/usr/bin/env node
// Publish a TETHERED node's forwarded ports on THIS machine's tailnet - the
// owner-side half of the tether. A tethered node (csg) has no tailscale
// interface of its own; its app and Shells fitting are reachable only
// through the `-L` legs TetherManager holds open on this box, so THIS
// machine's own tailnet identity is what has to publish them.
//
// Reads $GARRISON_HOME/remote-shell/tether.json (written by TetherManager the
// moment a tether comes up: {transport, node, forwards:[{name, localPort,
// servePort}]}) and idempotently maps each forward's localPort to its
// declared servePort via `tailscale serve`. Unlike tailnet-serve-views.mjs
// the servePort is NOT derived here (pickServePort) - it is fixed by the
// transport's own config (section 2.5's tether.forwards[].publish.servePort),
// which the mesh-wide 8400-8499 reservation already keeps collision-free.
//
// Usage:  node scripts/tailnet-serve-tether.mjs [--dry-run]

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailscale, tailscaleServeWrite, serveStatus, existingMappings } from "./lib/tailnet-serve-cli.mjs";

const DRY = process.argv.includes("--dry-run");
// Reserved everywhere a servePort could land - the mesh's own own-port band
// (8400-8499, tests/mesh-serve-ports.test.ts) plus the fixed infrastructure
// ports tailnet-serve-views.mjs also refuses.
const RESERVED = new Set([443, 8443, 8444, 8445, 8860]);
function reserved(port) {
  return (port >= 8400 && port <= 8499) || RESERVED.has(port);
}

function main() {
  // Same HARD RULE as tailnet-serve-views.mjs: only the node profile publishes.
  const profile = (process.env.GARRISON_INSTANCE_ID || "").trim();
  if (profile && profile !== "node" && profile !== "prod" && !process.argv.includes("--force")) {
    console.error(
      `Refusing to publish the '${profile}' instance to the tailnet — only the node profile is served.\n` +
        `(override with --force only if you know why)`
    );
    process.exitCode = 2;
    return;
  }

  const garrisonHome = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  const nodeJsonPath = path.join(garrisonHome, "node.json");
  if (!existsSync(nodeJsonPath) && !process.argv.includes("--force")) {
    console.error(`Refusing to publish: ${nodeJsonPath} does not exist — this machine has no node identity yet.`);
    process.exitCode = 2;
    return;
  }

  const tetherPath = path.join(garrisonHome, "remote-shell", "tether.json");
  let doc;
  try {
    doc = JSON.parse(readFileSync(tetherPath, "utf8"));
  } catch {
    console.log(`No tether.json at ${tetherPath} — nothing tethered on this node yet, or its tether has not come up.`);
    return;
  }
  const forwards = Array.isArray(doc?.forwards) ? doc.forwards : [];
  if (forwards.length === 0) {
    console.log(`tether.json for "${doc?.node ?? "?"}" declares no publishable forwards.`);
    return;
  }

  const status = serveStatus();
  const { byLocal } = existingMappings(status);

  console.log(`Publishing ${forwards.length} tethered forward(s) for node "${doc.node}" (transport "${doc.transport}")...\n`);
  const result = [];
  for (const f of forwards) {
    const localPort = Number(f.localPort);
    const servePort = Number(f.servePort);
    if (!Number.isInteger(localPort) || !Number.isInteger(servePort)) {
      result.push({ ...f, action: "FAILED", error: "malformed localPort/servePort" });
      continue;
    }
    if (reserved(servePort)) {
      result.push({ ...f, action: "FAILED", error: `servePort ${servePort} is reserved (8400-8499, 443, 8443-8445, 8860)` });
      continue;
    }
    const existing = byLocal.get(localPort);
    if (existing && existing.servePort === servePort) {
      result.push({ ...f, url: existing.url, action: "kept" });
      continue;
    }
    if (DRY) {
      result.push({ ...f, url: "(dry-run)", action: "would-add" });
      continue;
    }
    try {
      tailscaleServeWrite(["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${localPort}`]);
      result.push({ ...f, action: "added" });
    } catch (err) {
      result.push({ ...f, action: "FAILED", error: err });
    }
  }

  const fresh = existingMappings(serveStatus()).byLocal;
  let host = "<tailnet-host>";
  try {
    const st = JSON.parse(tailscale(["status", "--json"]).replace(/^[^{]*/, ""));
    host = (st.Self?.DNSName ?? host).replace(/\.$/, "");
  } catch { /* keep placeholder */ }

  console.log("Forward       local   tailnet URL");
  console.log("------------  ------  ------------------------------------------");
  for (const r of result) {
    const m = fresh.get(Number(r.localPort));
    const url = m ? m.url : (r.url ?? `https://${host}:${r.servePort}`);
    console.log(`${String(r.name).padEnd(13)} ${String(r.localPort).padEnd(6)}  ${url}   [${r.action}]`);
  }

  const failed = result.filter((r) => r.action === "FAILED");
  if (failed.length === 0) {
    console.log(`\nDone.${DRY ? " (dry-run — no changes made)" : ""}`);
    return;
  }
  console.error(`\n!! ${failed.length} tethered forward(s) NOT published:\n`);
  for (const r of failed) {
    console.error(`  ${r.name} (local ${r.localPort} -> :${r.servePort}): ${String(r.error?.message ?? r.error)}`);
  }
  process.exitCode = 1;
}

main();
