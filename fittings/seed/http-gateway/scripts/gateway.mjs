#!/usr/bin/env node

// Stable package entrypoint. There is one Operative, one Orchestrator prompt,
// and one duty/level vocabulary, so every launch enters the routed PTY gateway.
// Legacy environment configuration cannot select another engine.
await import("./gateway-pty.mjs");
