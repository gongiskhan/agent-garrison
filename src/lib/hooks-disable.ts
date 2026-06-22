import { readSettingsRaw, writeSettingsMerged, type HookGroup } from "./claude-settings-file";
import { readParkedHooks, writeParkedHooks } from "./parked-config";

// Hook GROUP enable/disable = a real PARK move (HV5). Disable removes the group
// from settings.json hooks[event][index] and records it verbatim — INCLUDING any
// `_garrison` owner tag — in ~/.garrison/parked/hooks.json. Enable restores it
// unchanged. primitive-state reads active ∪ parked so a disabled group still
// surfaces (presence:"parked") and the loop round-trips from the UI. All settings
// writes funnel through the single merge-writer (preserves unknown keys); the
// parked store is a Garrison file, never a non-standard key inside settings.json.

export interface HookToggleResult {
  ok: boolean;
  id?: string;
  code?: "not-found" | "invalid";
  error?: string;
}

export async function disableHookGroup(event: string, index: number): Promise<HookToggleResult> {
  const { json } = await readSettingsRaw();
  const block = (json.hooks ?? {}) as Record<string, HookGroup[]>;
  const list = Array.isArray(block[event]) ? block[event] : undefined;
  if (!list || index < 0 || index >= list.length) {
    return { ok: false, code: "not-found", error: `no hook group at ${event}#${index}` };
  }
  const group = list[index];
  // Park FIRST (durable copy), then remove from settings (crash-safe ordering: a
  // crash leaves the group BOTH parked and active = drift, never lost). If the
  // settings write THROWS, roll the park back so we don't leave a phantom parked
  // duplicate of a still-active group.
  const parked = await readParkedHooks();
  await writeParkedHooks([...parked, { event, group }]);
  try {
    await writeSettingsMerged((draft) => {
      const b = (draft.hooks ?? {}) as Record<string, HookGroup[]>;
      const l = Array.isArray(b[event]) ? [...b[event]] : [];
      // Remove the EXACT captured group regardless of index drift: try the index,
      // else find an identical group; idempotent if it was already removed.
      const want = JSON.stringify(group);
      const at = index < l.length && JSON.stringify(l[index]) === want ? index : l.findIndex((g) => JSON.stringify(g) === want);
      if (at >= 0) l.splice(at, 1);
      b[event] = l;
      draft.hooks = b;
    });
  } catch (e) {
    await writeParkedHooks(parked); // settings unchanged → roll back to active-only
    return { ok: false, code: "invalid", error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, id: `hook:${event}#${index}` };
}

// Enable a parked group by its index in the parked array (the primitive-state
// record id is `hook:<event>#parked<idx>`). Restore to settings FIRST (durable),
// then drop from the parked store.
export async function enableHookGroup(parkedIndex: number): Promise<HookToggleResult> {
  const parked = await readParkedHooks();
  if (parkedIndex < 0 || parkedIndex >= parked.length) {
    return { ok: false, code: "not-found", error: `no parked hook at index ${parkedIndex}` };
  }
  const entry = parked[parkedIndex];
  await writeSettingsMerged((draft) => {
    const b = (draft.hooks ?? {}) as Record<string, HookGroup[]>;
    const l = Array.isArray(b[entry.event]) ? [...b[entry.event]] : [];
    l.push(entry.group);
    b[entry.event] = l;
    draft.hooks = b;
  });
  await writeParkedHooks(parked.filter((_, i) => i !== parkedIndex));
  return { ok: true, id: `hook:${entry.event}` };
}

// Uninstall purge: when a fitting is uninstalled, drop any PARKED groups it owns
// (matching the `_garrison` owner tag) so a re-install doesn't resurrect a stale
// disabled copy. Complements stripGarrisonGroupsForOwner (which purges the ACTIVE
// settings.json groups). Returns the number of parked groups removed.
export async function purgeParkedHooksForOwner(owner: string): Promise<number> {
  const parked = await readParkedHooks();
  const kept = parked.filter((e) => {
    const marker = e.group?._garrison;
    const o = typeof marker === "string" ? marker : marker !== undefined ? "legacy:_garrison" : undefined;
    return o !== owner;
  });
  if (kept.length !== parked.length) await writeParkedHooks(kept);
  return parked.length - kept.length;
}
