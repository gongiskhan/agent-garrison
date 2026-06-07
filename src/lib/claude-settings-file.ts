import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome } from "./claude-home";

// The SINGLE writer for ~/.claude/settings.json.
//
// Every mutation — the Settings UI and (later) hook-fitting installs — funnels
// through here so there is exactly one place that enforces:
//   - read-fresh -> mutate -> write the whole document (never serialise a stale
//     in-memory copy; Claude Code rewrites this file on /model, permission
//     approvals, etc.),
//   - owner-scoped hook ownership (`_garrison: "fitting:<id>"`), so multiple
//     Garrison hook writers coexist without stripping each other's groups.
//
// Formatting is normalised on write (pretty JSON), exactly as Claude Code does.
// Unknown/bespoke keys survive by VALUE and key-presence, not byte-for-byte.

export type SettingsObject = Record<string, unknown>;

export interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  // Ownership marker. New code uses a string owner ("fitting:<id>"); the legacy
  // session-view writer used the bare `true` (migrated in the hooks slice).
  _garrison?: string | boolean;
  [key: string]: unknown;
}

export interface SettingsReadResult {
  json: SettingsObject;
  bytes: Buffer | null;
  exists: boolean;
}

export function settingsPath(home: string = claudeHome()): string {
  return path.join(home, "settings.json");
}

export function safeParse(text: string): SettingsObject {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SettingsObject;
    }
  } catch {
    // fall through
  }
  return {};
}

export async function readSettingsRaw(
  home: string = claudeHome()
): Promise<SettingsReadResult> {
  const p = settingsPath(home);
  try {
    const bytes = await fs.readFile(p);
    return { json: safeParse(bytes.toString("utf8")), bytes, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { json: {}, bytes: null, exists: false };
    }
    throw error;
  }
}

// Read-fresh, apply the mutator to the parsed document, write the whole thing
// back. Returns the written document. This is the ONLY write path.
export async function writeSettingsMerged(
  mutate: (draft: SettingsObject) => void,
  home: string = claudeHome()
): Promise<SettingsObject> {
  const p = settingsPath(home);
  const { json } = await readSettingsRaw(home);
  mutate(json);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return json;
}

// ---- owner-scoped hook helpers (consumed by the hooks slice) ----

function hooksBlock(draft: SettingsObject): Record<string, HookGroup[]> {
  const existing = draft.hooks;
  if (!existing || typeof existing !== "object") {
    const fresh: Record<string, HookGroup[]> = {};
    draft.hooks = fresh;
    return fresh;
  }
  return existing as Record<string, HookGroup[]>;
}

// Add one owner-tagged hook group to an event, replacing any prior group from
// the SAME owner on that event (idempotent per owner+event).
export function upsertGarrisonHookGroup(
  draft: SettingsObject,
  event: string,
  group: HookGroup,
  owner: string
): void {
  const hooks = hooksBlock(draft);
  const list = (hooks[event] = Array.isArray(hooks[event]) ? hooks[event] : []);
  const kept = list.filter((g) => !(g && g._garrison === owner));
  kept.push({ ...group, _garrison: owner });
  hooks[event] = kept;
}

// Append an owner-tagged group WITHOUT stripping same-owner groups first. Lets
// one owner install multiple groups (possibly on the same event); the installer
// does a single upfront stripGarrisonGroupsForOwner for idempotency.
export function appendGarrisonHookGroup(
  draft: SettingsObject,
  event: string,
  group: HookGroup,
  owner: string
): void {
  const hooks = hooksBlock(draft);
  const list = (hooks[event] = Array.isArray(hooks[event]) ? hooks[event] : []);
  list.push({ ...group, _garrison: owner });
}

// Remove ONLY the groups owned by `owner`, across every event. Never touches
// other owners' groups or untagged hand-authored groups.
export function stripGarrisonGroupsForOwner(
  draft: SettingsObject,
  owner: string
): boolean {
  const existing = draft.hooks;
  if (!existing || typeof existing !== "object") return false;
  const hooks = existing as Record<string, HookGroup[]>;
  let removed = false;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    hooks[event] = list.filter((g) => !(g && g._garrison === owner));
    if (hooks[event].length !== before) removed = true;
  }
  return removed;
}

// Distinct string owners currently present in the hooks block. A bare `true`
// marker (legacy) is reported as "legacy:_garrison".
export function listGarrisonHookOwners(draft: SettingsObject): string[] {
  const existing = draft.hooks;
  if (!existing || typeof existing !== "object") return [];
  const owners = new Set<string>();
  for (const list of Object.values(existing as Record<string, HookGroup[]>)) {
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (!g || g._garrison === undefined) continue;
      owners.add(typeof g._garrison === "string" ? g._garrison : "legacy:_garrison");
    }
  }
  return [...owners].sort();
}
