#!/usr/bin/env node
// Provision the isolated CODEX_HOME the launcher points `codex exec` at
// ($GARRISON_HOME/runtime-homes/codex). Two jobs:
//
//   1. Make the dir exist. The Codex CLI errors ("Error finding codex home")
//      when it is absent, which parks any adversarial-review / adversarial-test
//      phase routed to a codex target.
//   2. LINK — never copy — the box's login into it.
//
// (2) is the whole point of this script, and the reason the previous inline
// `copyFileSync` was a bug rather than a shortcut. A ChatGPT `auth.json` holds a
// ROTATING refresh token: every refresh mints a new one and invalidates the old,
// and OpenAI treats a second presentation of a superseded token as replay and
// revokes the entire token family. So two homes holding copies of one login are
// not two working logins - they are a race that ends with BOTH revoked and the
// user staring at "Your access token could not be refreshed because your refresh
// token was revoked". That is exactly what Garrison did to this box between
// 2026-07-22 and 2026-08-16: the copy seeded here fought ~/.codex, and the user
// re-ran `codex login` five times.
//
// A symlink has none of that: one file, one refresh token, whoever rotates it
// rotates it for everyone. Verified against codex-cli 0.147.0 - it rewrites
// auth.json THROUGH the symlink (write-in-place, not tmp+rename), so the link
// survives a login and a refresh.
//
// The isolated home is still worth having: config.toml, sessions, history and
// MCP servers stay per-instance. Only the credential is shared, because a
// credential is the one thing that CANNOT be.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const notes = [];
const warn = (message) => notes.push(`WARN ${message}`);

/** The box's own Codex config dir - the single owner of the real login. */
function nativeHomeDir() {
  const override = process.env.GARRISON_CODEX_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".codex");
}

/**
 * Which ChatGPT identity a credential file belongs to, or null when it carries
 * no OAuth tokens at all (an API-key file, or an unreadable/!JSON one).
 */
function accountIdOf(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const id = parsed?.tokens?.account_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Point `home`'s auth.json at the box's. Returns what happened, so the setup log
 * says which case this run hit instead of just claiming success.
 */
function linkCredential(home, nativeAuth) {
  const dst = path.join(home, "auth.json");
  const current = fs.lstatSync(dst, { throwIfNoEntry: false });

  if (current?.isSymbolicLink()) {
    if (fs.readlinkSync(dst) === nativeAuth) return "already linked";
    fs.unlinkSync(dst);
    fs.symlinkSync(nativeAuth, dst);
    return "re-pointed at the box login";
  }

  if (current?.isFile()) {
    // Only a COPY of the box's own login may be replaced. A file belonging to a
    // different identity is somebody's real, independent credential; clobbering
    // it would log them out for good, so leave it and say so.
    if (accountIdOf(dst) !== accountIdOf(nativeAuth)) {
      warn(
        `${dst} holds a DIFFERENT identity than ${nativeAuth} - left untouched. ` +
          `If it is a stale copy, delete it: two homes must never hold one login.`
      );
      return "left in place (different identity)";
    }
    fs.unlinkSync(dst);
    fs.symlinkSync(nativeAuth, dst);
    return "replaced a duplicate copy with a link";
  }

  fs.symlinkSync(nativeAuth, dst);
  return "linked";
}

function main() {
  const home = process.env.CODEX_HOME?.trim();
  if (!home) {
    // Nothing to isolate: `codex` will use the box's own home, which is correct.
    console.log("codex-runtime-ready (no CODEX_HOME set - using the box's own ~/.codex)");
    return;
  }

  const nativeHome = nativeHomeDir();
  if (path.resolve(home) === path.resolve(nativeHome)) {
    console.log("codex-runtime-ready (CODEX_HOME is the box's own home)");
    return;
  }

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const nativeAuth = path.join(nativeHome, "auth.json");
  let credential;
  if (fs.existsSync(nativeAuth)) {
    credential = linkCredential(home, nativeAuth);
  } else {
    // Not fatal: `up` must not be held hostage by a runtime nobody has logged
    // into yet. The fitting's verify probe is where that surfaces.
    credential = "skipped";
    warn(`${nativeAuth} is absent - run \`codex login\` on this box to authenticate the Codex runtime.`);
  }

  // config.toml is settings, not a credential: a per-instance copy is the point
  // (its MCP servers and model belong to this instance), so seed it once and
  // never touch it again.
  const config = path.join(home, "config.toml");
  const nativeConfig = path.join(nativeHome, "config.toml");
  let settings = "already present";
  if (!fs.existsSync(config)) {
    if (fs.existsSync(nativeConfig)) {
      fs.copyFileSync(nativeConfig, config);
      settings = "seeded from the box config";
    } else {
      settings = "none to seed";
    }
  }

  for (const note of notes) console.log(note);
  console.log(`codex-runtime-ready (auth: ${credential}; config.toml: ${settings})`);
}

main();
