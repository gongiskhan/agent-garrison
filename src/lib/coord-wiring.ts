import fs from "node:fs";
import path from "node:path";
import { claudeHome, claudeJsonPath, garrisonDir } from "./claude-home";

// Clean-removal wiring for the coordination Fittings (coord-beads / coord-agentmail
// / coord-mcp). These install STANDING user-scope config (a SessionStart hook, an
// http/stdio MCP server registration) that must persist across operative `down`
// so a DIRECT `claude` run in any repo keeps coordination — but must be removed
// cleanly and completely when the Fitting is DESELECTED.
//
// Mechanism: `runner.up()` calls reconcileCoordTeardown with the currently-selected
// fitting ids. A small per-composition ledger records which coord fittings were
// selected last time; any that are no longer selected get their owner-tagged hook
// group(s) stripped and their MCP server registration(s) removed. This runs ONLY
// on `up` (a select/deselect edit + run), never on `down`, so standing config is
// preserved while the operative is stopped. Scoped strictly to the known coord
// owners, so it can never touch another fitting's or a hand-authored config.
//
// Codex #3 discipline: a corrupt settings.json / claude.json is NEVER clobbered —
// removal aborts on that surface and leaves the live bytes untouched.

export interface CoordOwnerSpec {
  // Owner tag of the SessionStart/UserPromptSubmit hook group this fitting installs.
  hookOwner?: string;
  // MCP server name(s) this fitting registers in ~/.claude.json.
  mcpNames: string[];
}

export const COORD_OWNERS: Record<string, CoordOwnerSpec> = {
  "coord-beads": { hookOwner: "fitting:coord-beads", mcpNames: [] },
  "coord-agentmail": { mcpNames: ["coord-agentmail"] },
  "coord-mcp": { hookOwner: "fitting:coord-mcp", mcpNames: ["coord-mcp"] }
};

export function coordLedgerPath(): string {
  return path.join(garrisonDir(), "coord-lifecycle.json");
}

function parseObjOrNull(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

interface HookGroup {
  _garrison?: string | boolean;
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

// Strip every hook group tagged `_garrison === owner` across all events.
// Returns { removed, aborted } — aborted=true means the file was corrupt and was
// left untouched (never clobbered).
export function stripOwnerHookGroups(
  settingsPath: string,
  owner: string
): { removed: number; aborted: boolean } {
  if (!fs.existsSync(settingsPath)) return { removed: 0, aborted: false };
  const parsed = parseObjOrNull(fs.readFileSync(settingsPath, "utf8"));
  if (parsed === null) return { removed: 0, aborted: true };
  const hooks = parsed.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks || typeof hooks !== "object") return { removed: 0, aborted: false };
  let removed = 0;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    hooks[event] = list.filter((g) => !(g && g._garrison === owner));
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete parsed.hooks;
  if (removed > 0) fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2));
  return { removed, aborted: false };
}

// Remove a named MCP server from ~/.claude.json's mcpServers map. Returns
// { removed, aborted } — aborted=true means the file was corrupt and untouched.
export function removeMcpByName(cjPath: string, name: string): { removed: boolean; aborted: boolean } {
  if (!fs.existsSync(cjPath)) return { removed: false, aborted: false };
  const parsed = parseObjOrNull(fs.readFileSync(cjPath, "utf8"));
  if (parsed === null) return { removed: false, aborted: true };
  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object" || !(name in servers)) return { removed: false, aborted: false };
  delete servers[name];
  fs.writeFileSync(cjPath, JSON.stringify(parsed, null, 2));
  return { removed: true, aborted: false };
}

type Ledger = Record<string, string[]>;

function readLedger(p: string): Ledger {
  if (!fs.existsSync(p)) return {};
  const parsed = parseObjOrNull(fs.readFileSync(p, "utf8"));
  if (parsed === null) return {};
  const out: Ledger = {};
  for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
  return out;
}

function writeLedger(p: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
}

export interface CoordTeardownResult {
  removed: string[]; // coord fitting ids whose config was torn down
  strippedHooks: Record<string, number>;
  removedMcp: Record<string, string[]>;
  aborted: string[]; // surfaces left untouched because the live file was corrupt
}

// The reconcile run on `up`. Idempotent.
export function reconcileCoordTeardown(opts: {
  compositionId: string;
  selectedFittingIds: string[];
  settingsPath?: string;
  claudeJsonPath?: string;
  ledgerPath?: string;
}): CoordTeardownResult {
  const ledgerPath = opts.ledgerPath ?? coordLedgerPath();
  const settingsPath = opts.settingsPath ?? path.join(claudeHome(), "settings.json");
  const cjPath = opts.claudeJsonPath ?? claudeJsonPath();

  const ledger = readLedger(ledgerPath);
  const prev = ledger[opts.compositionId] ?? [];
  const selectedCoord = opts.selectedFittingIds.filter((id) => id in COORD_OWNERS);
  const removed = prev.filter((id) => !selectedCoord.includes(id));

  const result: CoordTeardownResult = { removed, strippedHooks: {}, removedMcp: {}, aborted: [] };
  // Deselected fittings whose cleanup ABORTED (corrupt live file) must be kept in
  // the ledger so they are retried on the next `up` once the file is repaired —
  // otherwise dropping them would silently leave their config installed forever.
  const retain: string[] = [];
  for (const id of removed) {
    const spec = COORD_OWNERS[id];
    if (!spec) continue;
    let abortedThis = false;
    if (spec.hookOwner) {
      const r = stripOwnerHookGroups(settingsPath, spec.hookOwner);
      result.strippedHooks[id] = r.removed;
      if (r.aborted) {
        result.aborted.push(`hooks:${id}`);
        abortedThis = true;
      }
    }
    const removedNames: string[] = [];
    for (const name of spec.mcpNames) {
      const r = removeMcpByName(cjPath, name);
      if (r.removed) removedNames.push(name);
      if (r.aborted) {
        result.aborted.push(`mcp:${id}:${name}`);
        abortedThis = true;
      }
    }
    result.removedMcp[id] = removedNames;
    if (abortedThis) retain.push(id);
  }

  // Ledger = currently-selected coord fittings PLUS any deselected ones whose
  // cleanup aborted (retry next `up`).
  ledger[opts.compositionId] = [...new Set([...selectedCoord, ...retain])];
  writeLedger(ledgerPath, ledger);
  return result;
}
