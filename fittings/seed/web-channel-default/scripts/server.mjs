#!/usr/bin/env node
// Legacy own-port host of the Conversations engine. The engine itself lives in
// @garrison/talk (packages/talk): the router, the thread store and the fitting
// host server are all there, and the Garrison shell mounts the same router at
// /api/* behind its /talk route. This file only keeps the fitting's historical
// entry point resolvable for the probe, the tests and anything importing it by
// path.

export * from "@garrison/talk/server";
import { startServer } from "@garrison/talk/server";

const isDirect = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirect) {
  startServer().catch((err) => {
    console.error("[web-channel] start failed:", err);
    process.exit(1);
  });
}
