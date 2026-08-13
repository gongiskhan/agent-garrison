#!/usr/bin/env node
// The omi-triage tick entrypoint - run by the scheduler job registered from
// server boot (lib/scheduler-jobs.mjs), or by hand:
//   node scripts/triage.mjs --tick
//
// Loads config from env (the job command bakes the instance env in), runs ONE
// tick (at most one model call, invariant I3), prints a JSON summary, exits 0.
// Exit 0 on skip reasons too - a disabled flag or empty inbox is not an error.

import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, garrisonDir, omiDir } from "../lib/config.mjs";
import { OmiStore, Counters, EventsDirStore } from "../lib/store.mjs";
import { runTriageTick } from "../lib/triage.mjs";
import { inferenceRunFn } from "../lib/gateway-client.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { MemoryWriter } from "../lib/memory-writer.mjs";
import { RelayNotifier, CompanionRelayNotifier } from "../lib/notify.mjs";

const arg = process.argv[2] ?? "--tick";
if (arg !== "--tick") {
  console.error("usage: triage.mjs --tick");
  process.exit(2);
}

const cfg = loadConfig();
const store = new OmiStore(omiDir());
const counters = new Counters(store.root, "triage");
// This process is spawned by the scheduler WITHOUT Omi secrets (they must not
// be baked into the job command); the RelayNotifier hands Omi pushes to the
// fitting server, which holds them. Web-channel degrade stays local.
const notifier = new RelayNotifier({ cfg, store, counters, omiApi: null });

// One brain, one triage: the companion's inbox joins the SAME tick by store
// LAYOUT convention — $GARRISON_HOME/capture (override GARRISON_CAPTURE_DIR),
// discovered by existence, no registration. A parked or absent
// capture-service means no directory and no drain.
const captureDir =
  process.env.GARRISON_CAPTURE_DIR?.trim() || path.join(garrisonDir(), "capture");
const captureStore = existsSync(path.join(captureDir, "events")) ? new EventsDirStore(captureDir) : null;
// Companion notifications relay to the capture-service's /notify (it holds
// the APNs flag, cap and ledger — this process must not re-check flags it
// cannot know); companion memories carry the companion prefix.
const companionNotifier = new CompanionRelayNotifier({ counters });
const companionMemoryWriter = new MemoryWriter({ prefix: "companion", label: "Companion" });
const omiMemoryWriter = new MemoryWriter();

const summary = await runTriageTick({
  cfg,
  store,
  counters,
  runFn: cfg.gatewayUrl
    ? inferenceRunFn(cfg.gatewayUrl, { target: cfg.classifyTarget || null })
    : async () => ({ reply: "" }),
  board: new BoardClient(),
  memoryWriter: omiMemoryWriter,
  notifier,
  extraStores: captureStore ? [captureStore] : [],
  memoryWriterFor: (event) => (event?.source === "companion-ios" ? companionMemoryWriter : omiMemoryWriter),
  notifierFor: (event) => (event?.source === "companion-ios" ? companionNotifier : notifier)
});

// Deliver tips queued by this (and any previous) tick - attempt-once with the
// omi-push -> web-channel degrade chain inside.
const tipReceipts = await notifier.drainTips();

console.log(`[omi-channel] triage tick: ${JSON.stringify({ ...summary, tipsDelivered: tipReceipts.length })}`);
process.exit(0);
