#!/usr/bin/env node
// Improver entrypoint — invoked by Garrison's runner / own-port lifecycle during
// composition `up` (and the per-Fitting start API). Hands off to server.mjs,
// which serves the review-queue view and self-registers at
// ~/.garrison/ui-fittings/improver.json.
import { startServer } from "./server.mjs";

startServer()
  .then((s) => console.log(`[improver] listening on ${s.host}:${s.port}`))
  .catch((err) => {
    console.error("[improver] start failed:", err);
    process.exit(1);
  });
