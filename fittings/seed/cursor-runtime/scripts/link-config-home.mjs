#!/usr/bin/env node
// link-config-home.mjs — the cursor-runtime setup hook.
//
// Every Garrison instance profile redirects XDG_CONFIG_HOME to
// $GARRISON_HOME/xdg/config (scripts/garrison-instance.sh), and Cursor keeps its
// login at $XDG_CONFIG_HOME/cursor/auth.json. So under ANY instance — dev, prod
// or codex — a box whose user ran `cursor-agent login` still looks LOGGED OUT to
// the runtime: verified live, `cursor-agent status` returns
// {"status":"unauthenticated"} against a fresh XDG home.
//
// codex-runtime solves its equivalent by COPYING ~/.codex/auth.json into the
// isolated CODEX_HOME, because Garrison multiplexes Codex accounts and each one
// needs its own home. Cursor has no Garrison account plane — there is exactly one
// machine login — so a copy would only create a second credential store that
// drifts as Cursor rotates its refresh token in place. A SYMLINK to the real
// config dir keeps one store, rotation included.
//
// The awkward case, hit on the first real run: cursor-agent AUTO-CREATES
// $XDG_CONFIG_HOME/cursor/cli-config.json (generated defaults) the moment it runs
// under a fresh XDG home — including during the failing probe that motivates this
// hook. Refusing to touch that generated directory would leave the runtime
// permanently unauthenticated on any box where a probe ever ran, so a directory
// holding NO auth.json is moved aside ONCE to `cursor.pre-garrison` and the link
// takes its place. A directory that DOES hold an auth.json is real credential
// state and is preserved untouched, as is any link the user pointed elsewhere.
// Nothing is ever deleted.
//
// Why a directory link rather than linking auth.json alone: a credential file is
// typically rewritten by temp-file + rename, which would REPLACE a file symlink
// with a regular file and silently break the share. A rename inside a symlinked
// directory lands in the real directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decide and (unless dryRun) perform the link. Pure-ish and injectable so the
 * decision table is unit-testable without touching a real home directory.
 * Returns {action, detail} — action is one of:
 *   native          — XDG_CONFIG_HOME is absent or already the real ~/.config
 *   no-source       — the box has no ~/.config/cursor (never logged in)
 *   already-linked  — the link is present and points at the real config dir
 *   preserved       — real credential state / a foreign link is already there
 *   linked          — the symlink was created (moving aside a generated dir if any)
 */
export function linkConfigHome({ xdgConfigHome, homeDir = os.homedir(), io = fs } = {}) {
  const nativeConfig = path.join(homeDir, ".config");
  const xdg = (xdgConfigHome ?? "").trim();
  if (!xdg || path.resolve(xdg) === path.resolve(nativeConfig)) {
    return { action: "native", detail: "XDG_CONFIG_HOME is the real ~/.config — Cursor reads its login directly" };
  }
  const source = path.join(nativeConfig, "cursor");
  const target = path.join(xdg, "cursor");
  if (!io.existsSync(source)) {
    return {
      action: "no-source",
      detail: `${source} does not exist — run \`cursor-agent login\` on this box (the bridge probe fails loudly until then)`
    };
  }
  // lstat, NOT existsSync: existsSync FOLLOWS symlinks, so a DANGLING link would
  // report "absent" and the symlink call below would then throw EEXIST.
  let stat = null;
  try {
    stat = io.lstatSync(target);
  } catch {
    /* absent — link straight in */
  }
  if (stat?.isSymbolicLink()) {
    let dest = null;
    try {
      dest = io.readlinkSync(target);
    } catch {
      /* unreadable link — treat as foreign, preserve it */
    }
    if (dest && path.resolve(path.dirname(target), dest) === path.resolve(source)) {
      return { action: "already-linked", detail: `${target} -> ${source}` };
    }
    return { action: "preserved", detail: `${target} is a symlink to ${dest ?? "(unreadable)"} — left as-is` };
  }
  if (stat) {
    // A real file/dir sits there. Only a directory WITHOUT credentials is the
    // generated one we may displace — and only by MOVING it, never deleting.
    if (!stat.isDirectory() || io.existsSync(path.join(target, "auth.json"))) {
      return {
        action: "preserved",
        detail: `${target} holds real Cursor state (auth.json present, or it is not a directory) — left as-is`
      };
    }
    const parked = `${target}.pre-garrison`;
    if (io.existsSync(parked)) {
      return { action: "preserved", detail: `${target} exists and ${parked} is already taken — left as-is; move one aside by hand` };
    }
    io.renameSync(target, parked);
    io.symlinkSync(source, target, "dir");
    return { action: "linked", detail: `${target} -> ${source} (generated config dir moved to ${parked})` };
  }
  io.mkdirSync(xdg, { recursive: true });
  io.symlinkSync(source, target, "dir");
  return { action: "linked", detail: `${target} -> ${source}` };
}

function main() {
  const result = linkConfigHome({ xdgConfigHome: process.env.XDG_CONFIG_HOME });
  // Setup is not the gate — the verify probe is. Print what happened (including
  // the no-source remediation) and exit 0 so `up` reaches the loud probe.
  console.log(`cursor config home: ${result.action} — ${result.detail}`);
  console.log("cursor-runtime-ready");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
