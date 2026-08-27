// Runner entry point (own-port contract: scripts/start.mjs at exactly this
// path). All config arrives via the spawn env the runner projects.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error(`[capture-service] failed to start: ${err?.stack || err}`);
  process.exit(1);
});
