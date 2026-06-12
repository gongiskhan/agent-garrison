// Pre-trust a cwd for the interactive Claude Code TUI. Ported from
// ekoa-core/src/backends/claude-code-pty/trust.ts.
//
// Interactive `claude` shows a "Do you trust this folder?" dialog the first
// time it's spawned in a directory; `claude -p` auto-skips it. The flag is
// `projects.<cwd>.hasTrustDialogAccepted = true` in ~/.claude.json.
//
// This file holds the user's claude config (project entries, MCP configs,
// credentials), so writes are serialised in-process and atomic (tmp+rename),
// and a corrupt-JSON read bails rather than clobbering.

import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import { claudeGlobalConfigPath } from "./paths.mjs";

let inflight = Promise.resolve();

/** Pre-trust a cwd in ~/.claude.json. Safe under concurrent callers within
 *  the same process. Atomic on disk via tmp-rename. */
export function preTrustCwd(cwd) {
  inflight = inflight
    .then(() => doPreTrust(cwd))
    .catch((err) => {
      console.warn("[claude-pty/trust] preTrustCwd failed:", err?.message ?? err);
    });
  return inflight;
}

function doPreTrust(cwd) {
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    /* path may not exist yet — write under cwd as given */
  }

  const path = claudeGlobalConfigPath();
  let cfg = {};
  if (existsSync(path)) {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      console.warn(`[claude-pty/trust] cannot read ${path}: ${err.message}; skipping pre-trust`);
      return;
    }
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      console.warn(`[claude-pty/trust] ${path} is not valid JSON (${err.message}); skipping pre-trust`);
      return;
    }
  }

  cfg.projects ??= {};
  let dirty = false;
  for (const key of new Set([cwd, canonical])) {
    const entry = cfg.projects[key] ?? {};
    if (entry.hasTrustDialogAccepted !== true) {
      cfg.projects[key] = { ...entry, hasTrustDialogAccepted: true };
      dirty = true;
    }
  }
  if (!dirty) return;

  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
  renameSync(tmpPath, path);
}
