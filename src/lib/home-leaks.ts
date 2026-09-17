import fs from "node:fs/promises";
import path from "node:path";
import { garrisonDir, provenanceLedgerPath, userProvenanceLedgerPath } from "./claude-home";
import { readGlobalLock, userComposition } from "./global-composition";
import { HomeQuarantine, contentHash, confinedHomePath, fileHash, hashMatches, isPreserved, ownerId, preservedHomeItems, readJsonObject, statOrNull } from "./home-quarantine";
import { canonicalValue, hookOwner, quarantineMcp, readMcpServers, readSharedState, userRuntimeHome, userHookFile, valueHash, type HomeProvenance, type SharedSet } from "./home-ownership";
import { sharedRuntimes, type SharedRuntime } from "./types";

export interface HomeLeak {
  runtime: SharedRuntime;
  kind: "skill" | "hook" | "mcp" | "rule" | "command" | "agent" | "file";
  ref: string;
  name: string;
  reason: "garrison-owned-not-shared" | "legacy-name" | "legacy-hook-command";
}
export interface HomeLeakReport { ok: boolean; checkedAt: string; leaks: HomeLeak[]; sharedOwners: string[]; }
export const legacyHookCommand = /garrison-goal-|\/skills\/garrison\/hooks\/|autothing|stretch-claude/;
export const hookFile = userHookFile;
export function isLegacyHomeHook(command: string): boolean {
  if (legacyHookCommand.test(command)) return true;
  const script = path.join(garrisonDir(), "shells", "agent-event-hook.sh");
  return command.startsWith(script + " ") && /^(agent-start|agent-stop|session-start|session-end) (claude|codex|gemini)$/.test(command.slice(script.length + 1));
}
function kindFor(ref: string): HomeLeak["kind"] {
  return ({ skills: "skill", commands: "command", agents: "agent", rules: "rule" } as const)[ref.split("/")[0] as "skills"] ?? "file";
}
async function names(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function checkHomeLeaks(options: { shared?: SharedSet } = {}): Promise<HomeLeakReport> {
  const shared = options.shared ?? (await readSharedState()).byRuntime;
  const [globalLock, userLock, globalLedger, userLedger, protectedItems] = await Promise.all([
    readGlobalLock(), userComposition().readLock(), readJsonObject<HomeProvenance>(provenanceLedgerPath()),
    readJsonObject<HomeProvenance>(userProvenanceLedgerPath()), preservedHomeItems()
  ]);
  const leaks: HomeLeak[] = [];
  const add = (leak: HomeLeak) => {
    if (!leaks.some(item => item.runtime === leak.runtime && item.kind === leak.kind && item.ref === leak.ref)) leaks.push(leak);
  };
  for (const runtime of sharedRuntimes) {
    const home = userRuntimeHome(runtime);
    const owners = new Set(shared[runtime]);
    const modified: string[] = [];
    if (runtime === "claude-code") {
      for (const dep of globalLock.deps) {
        if (owners.has(dep.name)) continue;
        for (const [ref, expected] of Object.entries(dep.deployedHashes)) {
          if (isPreserved(protectedItems, runtime, ref)) continue;
          const actual = await fileHash(home, ref);
          if (actual && !hashMatches(actual, expected)) modified.push(ref);
          if (hashMatches(actual, expected) && !userLock.deps.some(item => owners.has(item.name) && item.deployedFiles.some(f => f === ref || ref.startsWith(`${f}/`)))) {
            add({ runtime, kind: kindFor(ref), ref, name: path.basename(path.basename(ref) === "SKILL.md" ? path.dirname(ref) : ref), reason: "garrison-owned-not-shared" });
          }
        }
      }
    }
    for (const category of ["skills", "commands", "agents"] as const) {
      for (const name of await names(path.join(home, category))) {
        const ref = `${category}/${name}`;
        if (!/^(garrison|autothing)/.test(name) || isPreserved(protectedItems, runtime, ref) || modified.some(item => item === ref || item.startsWith(`${ref}/`))) continue;
        const owned = runtime === "claude-code" && userLock.deps.some(dep => owners.has(dep.name) && dep.deployedFiles.some(file => file === ref || file.startsWith(`${ref}/`)));
        if (!owned) add({ runtime, kind: kindFor(ref), ref, name, reason: "legacy-name" });
      }
    }
    const config = await readJsonObject<{ hooks?: Record<string, Array<{ _garrison?: unknown; hooks?: Array<{ command?: string }> }>> }>(hookFile(runtime));
    for (const [event, groups] of Object.entries(config.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, index) => {
        const owner = hookOwner(runtime, event, group, { ...globalLedger, ...userLedger });
        if (owner && owners.has(owner)) return;
        const legacy = group?.hooks?.some(hook => isLegacyHomeHook(hook.command ?? ""));
        if (owner || legacy) add({ runtime, kind: "hook", ref: `${event}#${index}`, name: owner ?? event, reason: owner ? "garrison-owned-not-shared" : "legacy-hook-command" });
      });
    }
    const servers = await readMcpServers(runtime);
    for (const [id, entry] of Object.entries({ ...globalLedger, ...userLedger })) {
      if ((entry.runtime ?? "claude-code") !== runtime || !entry.fittingId || owners.has(ownerId(entry.fittingId) ?? entry.fittingId)) continue;
      if (entry.surface === "mcp" || entry.kind === "mcp" || id.startsWith("mcp:")) {
        const ref = entry.ref ?? id.replace(/^mcp:/, "");
        if (ref in servers && (!entry.lastWrittenHash || [valueHash(servers[ref]), contentHash(JSON.stringify(servers[ref]))].includes(entry.lastWrittenHash.replace(/^sha256:/, "")))) add({ runtime, kind: "mcp", ref, name: ref, reason: "garrison-owned-not-shared" });
      } else if (entry.ref && (entry.kind === "file" || entry.kind === "rule") && !isPreserved(protectedItems, runtime, entry.ref)) {
        if (hashMatches(await fileHash(home, entry.ref), entry.lastWrittenHash)) add({ runtime, kind: kindFor(entry.ref), ref: entry.ref, name: path.basename(entry.ref), reason: "garrison-owned-not-shared" });
      }
    }
  }
  return { ok: leaks.length === 0, checkedAt: new Date().toISOString(), leaks, sharedOwners: [...new Set(Object.values(shared).flat())].sort() };
}

/** The server computes the list afresh; a client never supplies removable paths. */
export async function quarantineHomeLeaks(options: { shared?: SharedSet; quarantine?: HomeQuarantine; onlyKinds?: HomeLeak["kind"][]; only?: Pick<HomeLeak, "runtime" | "kind" | "ref"> } = {}) {
  const q = options.quarantine ?? new HomeQuarantine();
  const before = await checkHomeLeaks(options);
  const ledger = { ...await readJsonObject<HomeProvenance>(provenanceLedgerPath()), ...await readJsonObject<HomeProvenance>(userProvenanceLedgerPath()) };
  for (const runtime of sharedRuntimes) {
    const selected = before.leaks.filter(leak => leak.runtime === runtime && (!options.onlyKinds || options.onlyKinds.includes(leak.kind)) && (!options.only || (leak.runtime === options.only.runtime && leak.kind === options.only.kind && leak.ref === options.only.ref)));
    const hooks = selected.filter(leak => leak.kind === "hook");
    if (hooks.length) {
      const source = hookFile(runtime);
      const config = await readJsonObject<{ hooks: Record<string, unknown[]> }>(source);
      const values = hooks.map(leak => {
        const separator = leak.ref.lastIndexOf("#");
        const event = leak.ref.slice(0, separator); const index = Number(leak.ref.slice(separator + 1));
        return { event, index, value: config.hooks[event][index], leak };
      });
      await q.editJson(source, values.map(item => ({ runtime, kind: "hook", ref: item.leak.ref, source, value: item.value })), draft => {
        for (const item of values) if (canonicalValue(draft.hooks?.[item.event]?.[item.index]) !== canonicalValue(item.value)) throw new Error("Hook config changed during quarantine; retry");
        for (const event of new Set(values.map(item => item.event))) {
          const indices = new Set(values.filter(item => item.event === event).map(item => item.index));
          draft.hooks[event] = draft.hooks[event].flatMap((value: { _garrison?: unknown; hooks?: Array<{ command?: string }> }, index: number) => {
            if (!indices.has(index)) return [value];
            // A legacy command can share a group with a user's own hook. Only
            // owner-tagged groups belong wholly to the fitting.
            if (!hookOwner(runtime, event, value, ledger)) {
              const kept = (value.hooks ?? []).filter(hook => !isLegacyHomeHook(hook.command ?? ""));
              if (kept.length) return [{ ...value, hooks: kept }];
            }
            return [];
          });
        }
      });
    }
    for (const leak of selected.filter(item => item.kind === "mcp")) {
      const entry = Object.entries(ledger).find(([id, item]) => (item.runtime ?? "claude-code") === runtime && (item.ref ?? id.replace(/^mcp:/, "")) === leak.ref)?.[1];
      await quarantineMcp(q, runtime, leak.ref, entry?.lastWrittenHash);
    }
    // Recheck owned descendants before a directory move; a changed child
    // protects its parent even if it changed after the initial report.
    const lock = await readGlobalLock();
    if (runtime === "claude-code") for (const dep of lock.deps) for (const [ref, expected] of Object.entries(dep.deployedHashes)) {
      const actual = await fileHash(userRuntimeHome(runtime), ref);
      if (actual && !hashMatches(actual, expected)) await q.retain(runtime, userRuntimeHome(runtime), ref);
    }
    for (const leak of selected.filter(item => !["hook", "mcp"].includes(item.kind)).sort((a, b) => a.ref.length - b.ref.length)) {
      const home = userRuntimeHome(runtime);
      const file = confinedHomePath(home, leak.ref);
      if (!await statOrNull(file)) continue;
      const hash = runtime === "claude-code" ? lock.deps.map(dep => dep.deployedHashes[leak.ref]).find(Boolean) : undefined;
      await q.move(runtime, home, leak.ref, hash);
    }
  }
  const report = await checkHomeLeaks(options);
  const homesFile = path.join(garrisonDir(), "homes.json");
  if (await statOrNull(homesFile)) {
    const { writeJsonAtomic } = await import("./atomic-write");
    const homes = await readJsonObject<{ report?: Record<string, unknown> }>(homesFile);
    homes.report = { ...homes.report, leaks: report.leaks.length };
    await writeJsonAtomic(homesFile, homes);
  }
  return { report, quarantineDir: q.dir, moved: q.moved.length, leftModified: q.leftModified, hooksStripped: q.removed.filter(item => item.kind === "hook").length, mcpRemoved: q.removed.filter(item => item.kind === "mcp").length };
}
