import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome } from "./claude-home";
import { readFileTolerant, writeJsonAtomic } from "./atomic-write";

// Removal (uninstall) for Claude-Code-managed plugins in
// plugins/installed_plugins.json. That manifest is the SOURCE OF TRUTH for what
// is installed — there is no separate enabled-plugins list in settings.json, and
// known_marketplaces.json only lists availability (it never auto-reinstalls). So
// dropping a plugin's manifest entry uninstalls it; it is reversible (reinstall
// re-clones from the marketplace).
//
// We also remove the install dir(s) for a clean uninstall, but ONLY when the
// installPath is inside <home>/plugins/ — a path guard so a bespoke/external
// installPath is never rm'd. INSTALL (from a marketplace) is NOT done here — it
// needs marketplace resolution + git clone and stays with Claude Code's /plugin
// (gated on SP6). Cooperative ownership: a running Claude Code may rewrite this
// file on exit (same caveat as settings.json), so the UI warns to restart.

export interface PluginRemoveResult {
  ok: boolean;
  key?: string;
  removedDirs?: string[];
  code?: "not-found";
  error?: string;
}

function manifestPath(home: string): string {
  return path.join(home, "plugins", "installed_plugins.json");
}

interface InstalledManifest {
  version?: number;
  plugins?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readManifest(home: string): Promise<InstalledManifest | null> {
  const res = await readFileTolerant(manifestPath(home));
  if (!res.exists) return null;
  try {
    const parsed = JSON.parse(res.text) as InstalledManifest;
    if (parsed && typeof parsed === "object" && parsed.plugins && typeof parsed.plugins === "object") {
      return parsed;
    }
  } catch {
    /* unparseable */
  }
  return null;
}

// Only remove a dir that resolves to within <home>/plugins/. Anything else is
// left alone (the manifest entry is still dropped).
function installPathsFor(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).installPath === "string") {
      out.push((v as Record<string, unknown>).installPath as string);
    }
  }
  return out;
}

export async function removePlugin(key: string, home: string = claudeHome()): Promise<PluginRemoveResult> {
  const manifest = await readManifest(home);
  if (!manifest || !manifest.plugins || !Object.prototype.hasOwnProperty.call(manifest.plugins, key)) {
    return { ok: false, code: "not-found", error: `no installed plugin "${key}"` };
  }
  const pluginsRoot = path.join(home, "plugins") + path.sep;
  const installPaths = installPathsFor(manifest.plugins[key]);

  // Drop the manifest entry and write back (preserving version + sibling keys).
  const nextPlugins = { ...manifest.plugins };
  delete nextPlugins[key];
  await writeJsonAtomic(manifestPath(home), { ...manifest, plugins: nextPlugins });

  // Path-guarded cache-dir cleanup.
  const removedDirs: string[] = [];
  for (const p of installPaths) {
    const resolved = path.resolve(p);
    if (resolved.startsWith(pluginsRoot)) {
      await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
      removedDirs.push(resolved);
    }
  }
  return { ok: true, key, removedDirs };
}
