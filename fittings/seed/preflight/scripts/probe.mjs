#!/usr/bin/env node
// Preflight probe — the runner's verify-hook surface. Verifies the server and
// core modules load, the pure API is intact, and that the port this fitting
// will actually bind is available. Prints "ok" + exits 0 on success.
//
// It deliberately checks the CONFIGURED port, not an ephemeral one: the manifest
// promises the server exits non-zero rather than shifting when its port is
// taken, so a probe that binds port 0 passes at exactly the moment startup is
// about to fail. The catch is that verify also runs while this fitting is
// ALREADY listening (a restart, or any up() of a composition that stations it),
// so a taken port is only a failure when the holder is not us.

import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (!args.includes("--probe")) {
  console.error("usage: probe.mjs --probe");
  process.exit(2);
}

function tryBind(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => resolve(err.code || "EADDRINUSE"));
    srv.once("listening", () => srv.close(() => resolve(null)));
    srv.listen(port, host);
  });
}

function health(port, host) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.once("error", () => resolve(null));
    req.once("timeout", () => { req.destroy(); resolve(null); });
  });
}

function recordedPid() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    return JSON.parse(readFileSync(path.join(home, "ui-fittings", "preflight.json"), "utf8"))?.pid ?? null;
  } catch { return null; }
}

async function main() {
  let server;
  try {
    server = await import("./server.mjs");
    if (typeof server.startServer !== "function") {
      console.error("probe: server.mjs missing startServer");
      process.exit(1);
    }
  } catch (err) {
    console.error(`probe: failed to import server.mjs — ${err.message}`);
    process.exit(1);
  }
  try {
    const core = await import("../lib/preflight-core.mjs");
    for (const fn of [
      "parseManifest", "parseComposition", "crossCheckLibrary", "buildPortClaims",
      "findPortCollisions", "findOrphanServeMappings", "assessVerifyResults",
      "assessSweepResults", "serveCoverage", "classifyOrphans", "assessDrift",
      "scanKinds", "summarize", "demote"
    ]) {
      if (typeof core[fn] !== "function") {
        console.error(`probe: preflight-core.mjs missing ${fn}`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`probe: failed to import preflight-core.mjs — ${err.message}`);
    process.exit(1);
  }
  try {
    const fixers = await import("../lib/fixers.mjs");
    if (typeof fixers.runFix !== "function") {
      console.error("probe: fixers.mjs missing runFix");
      process.exit(1);
    }
  } catch (err) {
    console.error(`probe: failed to import fixers.mjs — ${err.message}`);
    process.exit(1);
  }

  // Same resolution the server uses, so the two can never disagree about which
  // port is "the" port.
  // Verify runs inside the app's environment, where the generic PORT is the
  // APP's port (8777) - not ours. The runner only sets GARRISON_PREFLIGHT_PORT
  // on the server's own spawn, so without it fall back to the manifest default.
  const pinned = process.env.GARRISON_PREFLIGHT_PORT ?? process.env.PREFLIGHT_PORT;
  const manifestDefault = readFileSync(new URL("../apm.yml", import.meta.url), "utf8")
    .match(/- key: port\s+type: integer\s+default: (\d+)/)?.[1];
  const { port, host } = server.parseArgs(["--port", String(pinned ?? manifestDefault ?? 0)]);
  const failure = await tryBind(port, host);
  if (!failure) {
    console.log("ok");
    process.exit(0);
  }
  if (port === 0) {
    console.error(`probe: cannot bind an ephemeral port on ${host} (${failure})`);
    process.exit(1);
  }
  // Taken. Ours, or someone else's?
  const live = await health(port, host);
  const recorded = recordedPid();
  if (live?.ok && live.pid && recorded && live.pid === recorded) {
    console.log("ok");
    process.exit(0);
  }
  console.error(live?.ok
    ? `probe: port ${port} answers /health as pid ${live.pid}, but ~/.garrison/ui-fittings/preflight.json records ${recorded ?? "nothing"} — refusing to call a foreign process this fitting.`
    : `probe: port ${port} is taken (${failure}) by something that is not preflight; the server exits rather than shifting, so startup would fail.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("probe:", err.message);
  process.exit(1);
});
