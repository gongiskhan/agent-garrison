#!/usr/bin/env node
import { startServer } from './server.mjs';
startServer(undefined, { onFatal: code => process.exit(code), onShutdown: code => process.exit(code) }).catch(error => {
  console.error(`[local-voice] start failed: ${error.message}`);
  process.exit(1);
});
