#!/usr/bin/env node
// Verify surface. Read-only by contract: setup causes side effects, verify only
// observes. Prints "ok" and exits 0, or explains itself and exits non-zero.

import { main } from "./server.mjs";

main(["--probe"]).catch((err) => {
  process.stderr.write(`probe failed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
