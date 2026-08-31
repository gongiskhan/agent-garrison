// Runner entrypoint (hardcoded convention: scripts/start.mjs, spawned detached
// from the checkout seed dir by src/lib/own-port-lifecycle.ts).
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error(`[email-channel] fatal: ${err?.stack || err}`);
  process.exit(1);
});
