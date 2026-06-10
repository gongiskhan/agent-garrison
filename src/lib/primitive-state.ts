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

export interface PrimitiveRecord {
  id: string; // surface-qualified, e.g. "skill:foo", "hook:SessionStart#0", "mcp:context7"
  surface: PrimitiveSurface;
  name: string;
  state: PrimitiveState;
  path?: string; // claudeHome-relative, for file surfaces
  fittingId?: string; // owner when owned (lock dep name / hook owner tag)
  driftedFromLock?: boolean; // file surfaces with a lock hash: on-disk bytes != lock hash
  preview?: string; // hooks: first command (falls back to matcher), as on the Settings page
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
      driftedFromLock
    });
  }

  // ---- hooks: settings.json _garrison ownership tag ----
  const { json } = await readSettingsRaw(home);
  const hooksBlock = (json.hooks ?? {}) as Record<string, HookGroup[]>;
  for (const [event, groups] of Object.entries(hooksBlock)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      const marker = group?._garrison;
      const owned = marker !== undefined;
      const firstCommand = Array.isArray(group?.hooks)
        ? group.hooks.find((h) => h && typeof h.command === "string" && h.command !== "")?.command
        : undefined;
      records.push({
        id: `hook:${event}#${index}`,
        surface: "hook",
        name: group?.matcher ? `${event} (${group.matcher})` : event,
        state: owned ? "owned" : "loose",
        fittingId: typeof marker === "string" ? marker : owned ? "legacy:_garrison" : undefined,
        preview: firstCommand ?? (typeof group?.matcher === "string" ? group.matcher : undefined)
      });
    });
  }

  // ---- mcp: mcp.json servers (no APM ownership model yet -> all loose; SP1) ----
  for (const name of await readMcpServerNames(home)) {
    records.push({ id: `mcp:${name}`, surface: "mcp", name, state: "loose" });
  }

  // ---- plugins: installed_plugins.json (Claude-Code-managed -> loose; SP6) ----
  for (const p of await readInstalledPlugins(home)) {
    records.push({
      id: `plugin:${p.key}`,
      surface: "plugin",
      name: p.key,
      state: "loose",
      fittingId: p.version ? `v${p.version}` : undefined
    });
  }

  return summarize(records);
}
