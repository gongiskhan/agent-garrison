#!/usr/bin/env node
// Manual, human-run pairing helper. NOT invoked by setup, verify, tests, or
// any other automated path in this Fitting — the brief is explicit that
// pairing an account is a deliberate, one-time action only the user takes.
//
// Usage (see instructions.md for the full walkthrough):
//   1. Start the whatsapp-web daemon (Views sidebar -> WhatsApp, or
//      `node scripts/start.mjs` by hand).
//   2. node scripts/pair.mjs +351912345678
//   3. On the phone: WhatsApp -> Settings -> Linked Devices -> Link a Device
//      -> "Link with phone number instead" -> enter the 8-character code
//      this prints.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function die(msg, code = 1) {
  process.stderr.write(`whatsapp-web pair: ${msg}\n`);
  process.exit(code);
}

function daemonBaseUrl() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  const file = path.join(home, "ui-fittings", "whatsapp-web.json");
  if (!existsSync(file)) {
    die(`whatsapp-web daemon is not running (no ${file}). Start it first — see instructions.md.`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return String(parsed.url).replace(/\/+$/, "");
}

async function main(argv) {
  const phoneNumber = argv[0];
  if (!phoneNumber) {
    die("usage: node scripts/pair.mjs <full international phone number, e.g. +351912345678>");
  }
  const base = daemonBaseUrl();
  const res = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phoneNumber })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(json.error || `pairing request failed (${res.status})`);
  }
  console.log(`Pairing code: ${json.code}`);
  console.log("On your phone: WhatsApp -> Settings -> Linked Devices -> Link a Device");
  console.log('-> "Link with phone number instead" -> enter this code within 60 seconds.');
}

main(process.argv.slice(2)).catch((err) => die(err.message));
