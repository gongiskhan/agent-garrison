import { writeSettingsMerged } from "./claude-settings-file";
import { readInstalledPlugins } from "./claude-scan";

// Plugin enable/disable via Claude Code's NATIVE lever: settings.json
// `enabledPlugins` (the same map `/plugin disable` writes). Absence of a key =
// enabled-by-default; `false` = disabled. The plugin stays installed either way,
// so there is no parked store — the install list is already the union (a disabled
// plugin still appears, with presence:"parked"). Disable sets `false`; enable
// DELETES the key (returns to enabled-by-default, keeping the map lean).

export interface PluginToggleResult {
  ok: boolean;
  key?: string;
  code?: "not-found" | "invalid";
  error?: string;
}

function enabledPluginsMap(draft: Record<string, unknown>): Record<string, unknown> {
  const ep = draft.enabledPlugins;
  if (ep && typeof ep === "object" && !Array.isArray(ep)) return ep as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  draft.enabledPlugins = fresh;
  return fresh;
}

export async function disablePlugin(key: string): Promise<PluginToggleResult> {
  if (!key) return { ok: false, code: "invalid", error: "plugin key is required" };
  const installed = await readInstalledPlugins();
  if (!installed.some((p) => p.key === key)) {
    return { ok: false, code: "not-found", error: `no installed plugin "${key}"` };
  }
  await writeSettingsMerged((draft) => {
    enabledPluginsMap(draft)[key] = false;
  });
  return { ok: true, key };
}

export async function enablePlugin(key: string): Promise<PluginToggleResult> {
  if (!key) return { ok: false, code: "invalid", error: "plugin key is required" };
  await writeSettingsMerged((draft) => {
    delete enabledPluginsMap(draft)[key];
  });
  return { ok: true, key };
}
