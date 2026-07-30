#!/usr/bin/env node
// Manual backfeed trigger (the server runs it on an interval when the flag is
// on; this CLI exists for the runbook and for verification):
//   node scripts/backfeed.mjs --run
import { loadConfig, omiDir } from "../lib/config.mjs";
import { OmiStore, Counters } from "../lib/store.mjs";
import { Backfeed } from "../lib/backfeed.mjs";
import { OmiApi } from "../lib/omi-api.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { boardCardUrl } from "../lib/notify.mjs";

const arg = process.argv[2] ?? "--run";
if (arg !== "--run") {
  console.error("usage: backfeed.mjs --run");
  process.exit(2);
}

const cfg = loadConfig();
const store = new OmiStore(omiDir());
const counters = new Counters(store.root, "backfeed");
const backfeed = new Backfeed({
  cfg,
  store,
  counters,
  omiApi: new OmiApi({
    appId: cfg.secrets.appId,
    appSecret: cfg.secrets.appSecret,
    importApiKey: cfg.secrets.importApiKey
  }),
  board: new BoardClient(),
  cardUrlFn: (id) => boardCardUrl(id)
});

const summary = await backfeed.runOnce();
console.log(`[omi-channel] backfeed: ${JSON.stringify(summary)}`);
process.exit(0);
