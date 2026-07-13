#!/usr/bin/env node
// Secure-context helper for the Web Channel - iOS mic capture (`getUserMedia`)
// only works in a SECURE CONTEXT (https, or localhost). A phone hitting the LAN /
// tailnet IP over plain http gets NO mic. This script reports whether a secure
// context is available and, on request, creates the recommended `tailscale serve`
// HTTPS mapping.
//
// This is an ADVISORY tool, not a gate: `--check` always exits 0. The composition
// `up` verify (scripts/probe.mjs) stays about "server loads + binds"; securing the
// origin for the phone is an owner step surfaced here + in README.md.
//
//   node scripts/secure-context.mjs --check   # report availability (exit 0)
//   node scripts/secure-context.mjs --serve   # create the tailscale HTTPS mapping
//
// What is AUTOMATIC vs MANUAL:
//   - Automatic: localhost/127.0.0.1 is already a secure context (desktop, Playwright).
//   - Automatic: the server serves https itself when tls_cert/tls_key are configured.
//   - Manual (this script's --serve, or `tailscale serve`, or the platform helper
//     scripts/tailnet-serve-views.mjs): expose 127.0.0.1:<port> at an https tailnet
//     URL. Nothing runs `tailscale serve` during `up`.

import { execFileSync } from "node:child_process";

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

function parseArgs(argv) {
  const out = {
    check: argv.includes("--check"),
    serve: argv.includes("--serve"),
    port: Number(process.env.WEB_CHANNEL_PORT || 7083)
  };
  const pi = argv.indexOf("--port");
  if (pi !== -1 && argv[pi + 1]) out.port = Number(argv[pi + 1]);
  return out;
}

// Run the tailscale CLI, tolerating the version-skew warning it prints to stderr
// alongside valid stdout. Throws only when no candidate binary exists.
function tailscale(args) {
  let lastErr;
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout: 8000 });
    } catch (err) {
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
  } catch {
    return null; // CLI missing / not serving
  }
}

// The https tailnet URL currently fronting http://127.0.0.1:<port>, or null.
function tailnetUrlForPort(port, status) {
  if (!status?.Web) return null;
  for (const [hostPort, web] of Object.entries(status.Web)) {
    const proxy = web?.Handlers?.["/"]?.Proxy;
    const m = proxy && /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy);
    if (m && Number(m[1]) === port) return `https://${hostPort}`;
  }
  return null;
}

// Deterministic serve port, matching scripts/tailnet-serve-views.mjs so the two
// helpers agree and stay idempotent (7083 -> 8483).
function pickServePort(localPort, used) {
  let p = 8400 + (localPort % 1000);
  while (used.has(p) || p === 8443 || p === 8444 || p === 8445 || p === 443) p += 1;
  return p;
}

// Report the secure-context posture for the given port. Never throws.
export function checkSecureContext(port = 7083) {
  const methods = [];
  const tlsCert = process.env.WEB_CHANNEL_TLS_CERT?.trim();
  const tlsKey = process.env.WEB_CHANNEL_TLS_KEY?.trim();
  if (tlsCert && tlsKey) methods.push("builtin-tls");

  const status = serveStatus();
  const tailscaleAvailable = status !== null;
  const tailnetUrl = tailnetUrlForPort(port, status);
  if (tailnetUrl) methods.push("tailscale-serve");

  return {
    port,
    secureContextAvailable: methods.length > 0,
    methods,
    tailnetUrl,
    tailscaleAvailable,
    // localhost is always a secure context - desktop/Playwright never need any of
    // the above; the phone (LAN/tailnet IP) does.
    localhostAlwaysSecure: true
  };
}

function printCheck(r) {
  console.log(`web-channel secure-context (port ${r.port}):`);
  if (r.secureContextAvailable) {
    console.log(`  AVAILABLE via ${r.methods.join(", ")}`);
    if (r.tailnetUrl) console.log(`  tailnet URL: ${r.tailnetUrl}`);
  } else {
    console.log("  NOT available for phone access (LAN/tailnet IP over plain http blocks mic capture).");
    console.log("  Fix: `node scripts/secure-context.mjs --serve` (tailscale), or set tls_cert/tls_key.");
    if (!r.tailscaleAvailable) console.log("  (tailscale CLI not found / not serving.)");
  }
  console.log("  Note: localhost/127.0.0.1 is always a secure context (desktop is unaffected).");
  // Machine-readable final line for scripts/tests.
  console.log(`SECURE_CONTEXT=${JSON.stringify(r)}`);
}

function doServe(port) {
  const status = serveStatus();
  if (status === null) {
    console.error("tailscale CLI not found or `tailscale serve status` failed - install Tailscale and sign in first.");
    process.exit(1);
  }
  const existing = tailnetUrlForPort(port, status);
  if (existing) {
    console.log(`Already served: ${existing} -> http://127.0.0.1:${port}`);
    return;
  }
  const used = new Set(
    Object.keys(status.Web ?? {})
      .map((hp) => Number(hp.split(":").pop()))
      .filter(Number.isFinite)
  );
  const servePort = pickServePort(port, used);
  try {
    tailscale(["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${port}`]);
  } catch (err) {
    console.error(`tailscale serve failed: ${err?.message ?? err}`);
    process.exit(1);
  }
  const url = tailnetUrlForPort(port, serveStatus());
  console.log(`Served ${url ?? `https://<tailnet-host>:${servePort}`} -> http://127.0.0.1:${port}`);
  console.log("Open that https URL on the phone (must be on the tailnet). Mic capture now works.");
}

const isDirect = process.argv[1] && process.argv[1].endsWith("secure-context.mjs");
if (isDirect) {
  const args = parseArgs(process.argv.slice(2));
  if (args.serve) {
    doServe(args.port);
  } else {
    // Default action is --check (advisory report, always exit 0).
    printCheck(checkSecureContext(args.port));
  }
}
