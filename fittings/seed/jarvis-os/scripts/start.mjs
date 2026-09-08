#!/usr/bin/env node
// Validate the launcher intent before loading a module that can start a service.
const args = process.argv.slice(2);
const valueFlags = new Set(["--port", "--host", "--gateway-url", "--dev-env-url", "--tls-cert", "--tls-key"]);
const fail = (message) => { console.error(`[jarvis-os] ${message}`); process.exit(2); };

if (args.includes("--probe")) {
  if (args.length !== 1) fail("unsupported argument combination: --probe must be used alone");
  // The dedicated verify entrypoint imports read-only and briefly binds an
  // ephemeral port. It never starts Jarvis or writes an own-port status record.
  await import("./probe.mjs");
} else {
  for (let i = 0; i < args.length; i++) {
    if (!valueFlags.has(args[i])) fail(`unsupported argument: ${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith("--")) fail(`${args[i]} requires a value`);
    i++;
  }
  const { startServer } = await import("./server.mjs");
  startServer().catch((err) => {
    console.error("[jarvis-os] start failed:", err.message);
    process.exit(1);
  });
}
