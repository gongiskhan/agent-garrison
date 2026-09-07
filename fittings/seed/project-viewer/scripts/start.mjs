#!/usr/bin/env node
// Entrypoint Garrison spawns. Thin on purpose: all the behaviour lives in
// server.mjs so it can be imported by tests without starting a listener.

import { main } from "./server.mjs";

main().catch((err) => {
  process.stderr.write(`project-viewer failed to start: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
