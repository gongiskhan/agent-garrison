// Runner entry point (own-port contract: scripts/start.mjs at exactly this
// path). All config arrives via the spawn env the runner projects.
import { startServer } from "./server.mjs";
import { syncTriageJob } from "../lib/scheduler-jobs.mjs";

startServer().then(({ cfg }) => {
  // Only the production launcher registers jobs; isolated server harnesses do not.
  if (!syncTriageJob(cfg)) console.error("[capture-service] triage scheduler unavailable; capture remains running");
}).catch((err) => {
  console.error(`[capture-service] failed to start: ${err?.stack || err}`);
  process.exit(1);
});
