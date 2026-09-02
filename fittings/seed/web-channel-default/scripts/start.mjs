#!/usr/bin/env node
// Web-channel Fitting entrypoint, invoked by Garrison's runner during composition
// `up`. Reads CLI args / env vars and hands off to the @garrison/talk host server,
// serving this fitting's built UI bundle from ../dist.

import path from "node:path";
import url from "node:url";
import { startServer } from "./server.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

startServer(undefined, { distDir: path.resolve(HERE, "..", "dist") }).catch((err) => {
  console.error("[web-channel] start failed:", err);
  process.exit(1);
});
