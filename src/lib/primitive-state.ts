import { claudeHome } from "./claude-home";
import { readGlobalLock } from "./global-composition";
import { readSettingsRaw, type HookGroup } from "./claude-settings-file";
import {
  scanClaudeFiles,
  hashFile,
  readMcpServerNames,
  readInstalledPlugins,
  type FileSurface
} from "./claude-scan";
import { readParkedMcp, readParkedHooks } from "./parked-config";

// The loose / owned / parked classifier.
//
// owned = the primitive is a package-file listed in the global apm.lock.yaml
//         `deployed_files` (APM is managing it).
// loose = on disk under ~/.claude but NOT in the lock (hand-authored or
//         APM-deployed-then-orphaned).
// parked = off-disk, in the Seed store. NOT surfaced here — parked lives in the
//         Seed view, out of Quarters (see D10). computeStateModel only emits
//         loose + owned.
//
// Three surface paths, because the lock only tracks files (verified): file
// surfaces diff disk-vs-lock; hooks read the settings.json `_garrison` ownership
// tag; mcp reads mcp.json (no APM ownership model yet — all loose until the
// provenance ledger lands; SP1).

export type PrimitiveState = "loose" | "owned" | "parked";
export type PrimitiveSurface = FileSurface | "plugin" | "hook" | "mcp";

// HV wave — the presence axis, orthogonal to the APM `state` axis. File surfaces
// are APM-managed (`managedBy: "apm"`, enable/disable = promote/park). The
// config-entry surfaces (hook/mcp/plugin) have no APM lock relationship
// (`managedBy: "presence"`); enable/disable = a real move between the live config
// and the parked store, surfaced as `presence`. The model reads `active ∪ parked`
// for hook/mcp so a disabled entry still shows up (with `presence: "parked"`).
export type PresenceState = "enabled" | "parked";

export interface PrimitiveRecord {
  id: string; // surface-qualified, e.g. "skill:foo", "hook:SessionStart#0", "mcp:context7"
  surface: PrimitiveSurface;
  name: string;
  state: PrimitiveState;
  path?: string; // claudeHome-relative, for file surfaces
  fittingId?: string; // owner when owned (lock dep name / hook owner tag)
  driftedFromLock?: boolean; // file surfaces with a lock hash: on-disk bytes != lock hash
  preview?: string; // hooks: first command (falls back to matcher), as on the Settings page
  managedBy?: "apm" | "presence"; // which lifecycle governs enable/disable
  presence?: PresenceState; // presence-managed surfaces only (hook/mcp/plugin)
}

export interface StateModel {
  records: PrimitiveRecord[];
  counts: Record<PrimitiveState, number>;
  bySurface: Record<PrimitiveSurface, PrimitiveRecord[]>;
}

const SURFACES: PrimitiveSurface[] = ["skill", "command", "rule", "plugin", "hook", "mcp"];

function summarize(records: PrimitiveRecord[]): StateModel {
  const counts: Record<PrimitiveState, number> = { loose: 0, owned: 0, parked: 0 };
  const bySurface = Object.fromEntries(SURFACES.map((s) => [s, [] as PrimitiveRecord[]])) as Record<
    PrimitiveSurface,
    PrimitiveRecord[]
  >;
  for (const r of records) {
    counts[r.state] += 1;
    bySurface[r.surface].push(r);
  }
  return { records, counts, bySurface };
}

export async function computeStateModel(opts: { claudeHome?: string } = {}): Promise<StateModel> {
  const home = opts.claudeHome ?? claudeHome();
  const lock = await readGlobalLock();
  const records: PrimitiveRecord[] = [];

  // ---- file surfaces: diff disk scan against the lock ----
  const scanned = await scanClaudeFiles(home);
  for (const f of scanned) {
    // Defensive de-dup guard: a plugin-bundled skill must not be listed as a
    // standalone skill. In practice plugin skills live under ~/.claude/plugins/
    // and scanClaudeFiles only scans skills|commands|rules, so this never fires —
    // it documents the invariant and guards a future symlink-into-skills/ case.
    if (f.relPath.startsWith("plugins/")) continue;
    const owned = lock.allDeployedFiles.has(f.relPath);
    const ownerDep = owned ? lock.deps.find((d) => d.deployedFiles.includes(f.relPath)) : undefined;
    let driftedFromLock: boolean | undefined;
    if (owned && ownerDep && !f.isDir) {
      const expected = ownerDep.deployedHashes[f.relPath];
      if (expected) {
        driftedFromLock = (await hashFile(f.absPath)) !== expected;
      }
    }
    records.push({
      id: `${f.surface}:${f.name}`,
      surface: f.surface,
      name: f.name,
      state: owned ? "owned" : "loose",
      path: f.relPath,
      fittingId: ownerDep?.name,
      driftedFromLock,
      managedBy: "apm"
    });
  }

  // ---- hooks: active (settings.json) ∪ parked (~/.garrison/parked/hooks.json) ----
  // Active groups carry the settings.json `_garrison` ownership tag; parked
  // groups were disabled (moved off the live config) and still surface so they
  // can be re-enabled. Presence-managed: enable/disable = a move between the two.
  const hookPreview = (group: HookGroup | undefined): string | undefined => {
    const firstCommand = Array.isArray(group?.hooks)
      ? group.hooks.find((h) => h && typeof h.command === "string" && h.command !== "")?.command
      : undefined;
    return firstCommand ?? (typeof group?.matcher === "string" ? group.matcher : undefined);
  };
  const hookName = (event: string, group: HookGroup | undefined): string =>
    group?.matcher ? `${event} (${group.matcher})` : event;
  const hookOwner = (marker: unknown): string | undefined =>
    typeof marker === "string" ? marker : marker !== undefined ? "legacy:_garrison" : undefined;

  const { json } = await readSettingsRaw(home);
  const hooksBlock = (json.hooks ?? {}) as Record<string, HookGroup[]>;
  for (const [event, groups] of Object.entries(hooksBlock)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      const marker = group?._garrison;
      records.push({
        id: `hook:${event}#${index}`,
        surface: "hook",
        name: hookName(event, group),
        state: marker !== undefined ? "owned" : "loose",
        fittingId: hookOwner(marker),
        preview: hookPreview(group),
        managedBy: "presence",
        presence: "enabled"
      });
    });
  }
  // parked hook groups → presence "parked" records (re-enableable from the UI)
  const parkedHooks = await readParkedHooks();
  parkedHooks.forEach((entry, idx) => {
    records.push({
      id: `hook:${entry.event}#parked${idx}`,
      surface: "hook",
      name: hookName(entry.event, entry.group),
      state: "loose",
      fittingId: hookOwner(entry.group?._garrison),
      preview: hookPreview(entry.group),
      managedBy: "presence",
      presence: "parked"
    });
  });

  // ---- mcp: active (~/.claude.json mcpServers) ∪ parked (parked/mcp.json) ----
  // CRITICAL (HV3): a disabled server is physically removed from the live file,
  // so the model MUST also read the parked store — otherwise a disabled MCP
  // vanishes from the UI with no record to re-enable.
  const activeMcp = await readMcpServerNames(home);
  const activeMcpSet = new Set(activeMcp);
  for (const name of activeMcp) {
    records.push({ id: `mcp:${name}`, surface: "mcp", name, state: "loose", managedBy: "presence", presence: "enabled" });
  }
  const parkedMcp = await readParkedMcp();
  for (const name of Object.keys(parkedMcp).sort()) {
    if (activeMcpSet.has(name)) continue; // XOR: active wins; both = drift, surfaced by HV9 invariant
    records.push({ id: `mcp:${name}`, surface: "mcp", name, state: "loose", managedBy: "presence", presence: "parked" });
  }

  // ---- plugins: installed_plugins.json + settings.json enabledPlugins ----
  // Disabled = enabledPlugins[key] === false (absence = enabled-by-default, per
  // Claude Code's native /plugin disable). The plugin stays installed either way,
  // so the install list is already the active ∪ parked union — no separate store.
  const enabledPlugins = (json.enabledPlugins ?? {}) as Record<string, unknown>;
  for (const p of await readInstalledPlugins(home)) {
    const disabled = enabledPlugins[p.key] === false;
    records.push({
      id: `plugin:${p.key}`,
      surface: "plugin",
      name: p.key,
      state: "loose",
      fittingId: p.version ? `v${p.version}` : undefined,
      managedBy: "presence",
      presence: disabled ? "parked" : "enabled"
    });
  }

  return summarize(records);
}
