#!/usr/bin/env node
// One bounded tick over the Garrison phone and pendant capture inbox.
import { loadConfig } from "../lib/config.mjs";
import { CaptureStore, Counters } from "../lib/store.mjs";
import { runTriageTick } from "../lib/triage.mjs";
import { inferenceRunFn } from "../lib/gateway-client.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { MemoryWriter } from "../lib/memory-writer.mjs";
import { CompanionRelayNotifier } from "../lib/triage-notify.mjs";

if ((process.argv[2] ?? "--tick") !== "--tick") throw new Error("usage: triage.mjs --tick");
const cfg = loadConfig();
const store = new CaptureStore(cfg.stateDir);
const counters = new Counters(store.root, "triage");
const notifier = new CompanionRelayNotifier({ store, counters });
const companionWriter = new MemoryWriter({ prefix: "companion", label: "Companion" });
const pendantWriter = new MemoryWriter({ prefix: "pendant", label: "Pendant" });
const summary = await runTriageTick({
  cfg, store, counters,
  runFn: cfg.gatewayUrl ? inferenceRunFn(cfg.gatewayUrl, { target: cfg.triageClassifyTarget || cfg.classifyTarget || null }) : async () => ({ reply: "" }),
  board: new BoardClient(), memoryWriter: companionWriter, notifier,
  memoryWriterFor: event => event?.source === "pendant" ? pendantWriter : companionWriter,
  notifierFor: () => notifier
});
const tips = cfg.triageEnabled && cfg.tipsEnabled ? await notifier.drainTips() : [];
console.log(`[capture-service] triage tick: ${JSON.stringify({ ...summary, tipsDelivered: tips.length })}`);
