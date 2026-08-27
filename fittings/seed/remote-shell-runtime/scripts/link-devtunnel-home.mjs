#!/usr/bin/env node
// Every Garrison instance profile redirects XDG_DATA_HOME to
// $GARRISON_HOME/xdg/data — and that is exactly where the Microsoft devtunnel
// CLI keeps its login ($XDG_DATA_HOME/DevTunnels/devtunnels-tokens-*). So a
// box that HAS run `devtunnel user login` still reads as "Login required"
// inside an instance until the real store is linked in. Symlink (not copy:
// the CLI refreshes tokens in place) the real ~/.local/share/DevTunnels into
// the instance's XDG data home. Idempotent; never clobbers existing state.
// Same shape as cursor-runtime's link-config-home.mjs.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const real = path.join(os.homedir(), ".local", "share", "DevTunnels");
const xdgData = process.env.XDG_DATA_HOME?.trim();

if (!xdgData || path.resolve(xdgData) === path.join(os.homedir(), ".local", "share")) {
  console.log("[remote-shell] XDG_DATA_HOME not redirected — nothing to link");
  process.exit(0);
}
if (!existsSync(real)) {
  console.log(`[remote-shell] no devtunnel login on this box yet (${real} absent) — skipping link`);
  process.exit(0);
}
const target = path.join(xdgData, "DevTunnels");
let existing = null;
try {
  existing = lstatSync(target);
} catch {}
if (existing?.isDirectory()) {
  // A dir the CLI dropped here on a token-less run. If it holds NO tokens it
  // is exactly the thing shadowing the real login — replace it with the link.
  // A dir WITH tokens is deliberate instance-local auth; never touch it.
  const hasTokens = readdirSync(target).some((n) => n.startsWith("devtunnels-tokens"));
  if (hasTokens) {
    console.log(`[remote-shell] ${target} holds its own tokens — leaving it alone`);
    process.exit(0);
  }
  for (const n of readdirSync(target)) unlinkSync(path.join(target, n));
  rmdirSync(target);
  existing = null;
}
if (existing) {
  console.log(`[remote-shell] ${target} already linked — leaving it alone`);
} else {
  mkdirSync(xdgData, { recursive: true });
  symlinkSync(real, target);
  console.log(`[remote-shell] linked ${target} -> ${real}`);
}
