#!/usr/bin/env node
// Read-only audit. Empty output from a failed CLI must never mean no exposure.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { TAILSCALE_CANDIDATES, enrich } from "./lib/tailnet-serve-cli.mjs";

export function publicFunnels(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Invalid Tailscale Serve status");
  const found = [];
  function scan(config, scope) {
    for (const [hostPort, enabled] of Object.entries(config.AllowFunnel ?? {})) {
      if (enabled === true) found.push({ scope, hostPort, paths: Object.keys(config.Web?.[hostPort]?.Handlers ?? {}) });
    }
    for (const [id, child] of Object.entries(config.Foreground ?? {})) scan(child, `${scope}/foreground/${id}`);
  }
  scan(status, "background");
  return found;
}
export function auditFunnels({ run = execFileSync } = {}) {
  for (const bin of TAILSCALE_CANDIDATES) {
    let raw;
    try { raw = run(bin, ["serve", "status", "--json"], { encoding: "utf8", timeout: 8000 }); }
    catch (error) { if (error.code === "ENOENT") continue; throw enrich(error, bin); }
    const status = JSON.parse(raw.slice(raw.indexOf("{")));
    if (status?.error || status?.Error) throw new Error("Tailscale returned an error status");
    return publicFunnels(status);
  }
  throw new Error("Tailscale CLI unavailable");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const funnels = auditFunnels();
    console.log(JSON.stringify({ publicFunnels: funnels }, null, 2));
    if (funnels.length) process.exitCode = 1;
  } catch (error) { console.error(`Funnel audit failed: ${error.message}`); process.exitCode = 2; }
}
