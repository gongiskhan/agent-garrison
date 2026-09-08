#!/usr/bin/env node
// Legacy own-port host of the Conversations engine. The engine itself lives in
// @garrison/talk (packages/talk): the router, the thread store and the fitting
// host server are all there, and the Garrison shell mounts the same router at
// /api/* behind its /talk route. This file only keeps the fitting's historical
// entry point resolvable for the probe, the tests and anything importing it by
// path.

export * from "@garrison/talk/server";
import { parseArgs, startServer } from "@garrison/talk/server";

// The voice pair the router needs (createTalkRouter's `voice` option). The
// runner projects GARRISON_VOICE_FITTING_ID (the fitting providing kind:voice,
// absent when none is stationed) and delivers CAPTURE_TOKEN through this
// fitting's secret_scope; the shell host resolves the same two from the
// capability graph and the vault per request. Read at call time so a heal
// restart with new env is the only refresh needed - no copy is cached here.
export function voiceOptionsFromEnv(env = process.env) {
  return {
    fittingId: () => env.GARRISON_VOICE_FITTING_ID?.trim() || null,
    token: () => env.CAPTURE_TOKEN || null
  };
}

const isDirect = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirect) {
  startServer({ ...parseArgs(process.argv.slice(2)), voice: voiceOptionsFromEnv() }).catch((err) => {
    console.error("[web-channel] start failed:", err);
    process.exit(1);
  });
}
