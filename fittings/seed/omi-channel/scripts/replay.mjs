#!/usr/bin/env node
// Fixture replay harness (spec M1): POST any fixture set against a local
// omi-channel instance. Filename prefix picks the endpoint:
//   conversation-* / malformed-memory* -> POST /omi/memory
//   day-summary-*                      -> POST /omi/day-summary
//   realtime-*                         -> POST /omi/realtime
//
// Usage:
//   node scripts/replay.mjs --base http://127.0.0.1:7094 --key <secret> \
//        [--uid omi_test_user_1] [--dir fixtures] [--twice]
//
// Replaying the same set twice must yield identical inbox state (I6).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    base: "",
    key: process.env.OMI_WEBHOOK_SECRET || "",
    uid: "omi_test_user_1",
    dir: path.resolve(here, "..", "fixtures"),
    twice: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else if (a === "--uid") out.uid = argv[++i];
    else if (a === "--dir") out.dir = path.resolve(argv[++i]);
    else if (a === "--twice") out.twice = true;
  }
  if (!out.base) {
    console.error("usage: replay.mjs --base <url> --key <secret> [--uid u] [--dir d] [--twice]");
    process.exit(2);
  }
  return out;
}

export function endpointForFixture(name) {
  if (name.startsWith("day-summary")) return "/omi/day-summary";
  if (name.startsWith("realtime-")) return "/omi/realtime";
  return "/omi/memory";
}

export async function replayFixtures({ base, key, uid, dir, fetchImpl = fetch }) {
  const results = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    const body = readFileSync(path.join(dir, file), "utf8");
    const endpoint = endpointForFixture(file);
    const query = new URLSearchParams({ key, uid });
    if (endpoint === "/omi/realtime") query.set("session_id", `replay-${file}`);
    const target = `${base.replace(/\/$/, "")}${endpoint}?${query}`;
    let status = 0;
    let error = null;
    try {
      const res = await fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      });
      status = res.status;
    } catch (err) {
      error = err?.message ?? String(err);
    }
    results.push({ file, endpoint, status, error });
  }
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const rounds = opts.twice ? 2 : 1;
  for (let round = 1; round <= rounds; round++) {
    const results = await replayFixtures(opts);
    for (const r of results) {
      console.log(
        `[replay] round ${round} ${r.file} -> ${r.endpoint} ${r.error ? `ERROR ${r.error}` : r.status}`
      );
    }
  }
}
