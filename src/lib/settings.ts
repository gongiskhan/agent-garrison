import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome, garrisonDir } from "./claude-home";
import {
  readSettingsRaw,
  writeSettingsMerged,
  listGarrisonHookOwners,
  type SettingsObject,
  type HookGroup
} from "./claude-settings-file";
import { KNOWN_SETTINGS, KNOWN_KEYS, type KnownSetting } from "./settings-catalog";
import { scanClaudeFiles, readMcpServerNames } from "./claude-scan";

// Typed-controls + raw-passthrough + drift layer over the single writer.
//
// The descriptor map now lives in settings-catalog.ts and covers EVERY key of
// the official settings.json schema (synced against the vendored copy by
// tests/settings-catalog.test.ts). It is the typed-controls layer ONLY — it
// never gates what may be written. Any key not in it (bespoke/experimental,
// e.g. advisorModel on this machine) round-trips untouched through the
// Advanced passthrough.

export {
  KNOWN_SETTINGS,
  GROUP_ORDER,
  PERMISSION_RULE_PATTERN,
  PERMISSION_TOOL_PREFIXES,
  HOOK_EVENT_NAMES
} from "./settings-catalog";
export type {
  KnownSetting,
  FieldDesc,
  ControlType,
  SettingGroup,
  SettingGroupId
} from "./settings-catalog";

export interface KnownSettingView extends KnownSetting {
  value: unknown;
  present: boolean;
}

export interface UnknownSettingView {
  key: string;
  value: unknown;
}

export interface HookGroupView {
  event: string;
  owner: string; // "fitting:<id>", "legacy:_garrison", or "hand-authored"
  matcher: string;
  commands: string[];
}

export interface SettingsView {
  exists: boolean;
  known: KnownSettingView[];
  unknown: UnknownSettingView[];
  hooks: HookGroupView[];
  hookOwners: string[];
  drift: { changedExternally: boolean; lastSeenAt: string | null };
  // user scope only this pass; settings.local.json / project scope merge in but
  // are not shown/edited yet.
  scope: "user";
  permissionsScopeNote: string;
  // Datalist feeds for map-key / list-row editors (skillOverrides,
  // enabled/disabledMcpjsonServers). Best-effort: scan failures yield [].
  suggestions: { skills: string[]; mcpServers: string[] };
}

function lastSeenPath(): string {
  return path.join(garrisonDir(), "claude-settings.last-seen.json");
}

interface LastSeen {
  at: string;
  settings: SettingsObject;
}

async function readLastSeen(): Promise<LastSeen | null> {
  try {
    const raw = await fs.readFile(lastSeenPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.settings) return parsed as LastSeen;
  } catch {
    // none yet
  }
  return null;
}

async function writeLastSeen(settings: SettingsObject): Promise<string> {
  const at = new Date().toISOString();
  const dir = garrisonDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(lastSeenPath(), `${JSON.stringify({ at, settings }, null, 2)}\n`, "utf8");
  return at;
}

// Deep value-equality (drift compares VALUES, not bytes: Claude Code reformats
// settings.json with identical values, which must NOT read as external drift).
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function hookViews(json: SettingsObject): HookGroupView[] {
  const block = json.hooks;
  if (!block || typeof block !== "object") return [];
  const out: HookGroupView[] = [];
  for (const [event, list] of Object.entries(block as Record<string, HookGroup[]>)) {
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (!g || typeof g !== "object") continue;
      const owner =
        typeof g._garrison === "string"
          ? g._garrison
          : g._garrison === true
          ? "legacy:_garrison"
          : "hand-authored";
      out.push({
        event,
        owner,
        matcher: typeof g.matcher === "string" ? g.matcher : "",
        commands: Array.isArray(g.hooks)
          ? g.hooks.map((h) => (h && typeof h.command === "string" ? h.command : "")).filter(Boolean)
          : []
      });
    }
  }
  return out;
}

async function readSuggestions(home: string): Promise<{ skills: string[]; mcpServers: string[] }> {
  const [skills, mcpServers] = await Promise.all([
    scanClaudeFiles(home)
      .then((files) => files.filter((f) => f.surface === "skill").map((f) => f.name))
      .catch(() => [] as string[]),
    readMcpServerNames(home).catch(() => [] as string[])
  ]);
  return { skills, mcpServers };
}

export async function readSettingsView(home: string = claudeHome()): Promise<SettingsView> {
  const { json, exists } = await readSettingsRaw(home);

  let lastSeen = await readLastSeen();
  let changedExternally = false;
  if (!lastSeen) {
    // First open: establish the baseline so later external edits are detectable.
    const at = await writeLastSeen(json);
    lastSeen = { at, settings: json };
  } else {
    changedExternally = !deepEqual(json, lastSeen.settings);
  }

  const known: KnownSettingView[] = KNOWN_SETTINGS.map((d) => ({
    ...d,
    value: json[d.key],
    present: Object.prototype.hasOwnProperty.call(json, d.key)
  }));
  const unknown: UnknownSettingView[] = Object.keys(json)
    .filter((k) => !KNOWN_KEYS.has(k) && k !== "hooks")
    .sort()
    .map((k) => ({ key: k, value: json[k] }));

  return {
    exists,
    known,
    unknown,
    hooks: hookViews(json),
    hookOwners: listGarrisonHookOwners(json),
    drift: { changedExternally, lastSeenAt: lastSeen.at },
    scope: "user",
    permissionsScopeNote:
      "Permissions shown are user-scope (~/.claude/settings.json) only. settings.local.json allow-rules merge into the effective set but are not shown or edited here.",
    suggestions: await readSuggestions(home)
  };
}

// "Reload from disk": the user accepts the external change. Advance the
// last-seen baseline to the current on-disk values so the drift banner clears,
// then return the fresh view. Plain readSettingsView intentionally does NOT
// advance the baseline (so it keeps surfacing drift until the user explicitly
// reloads) — which is why a plain GET reload left the banner stuck.
export async function reloadSettingsView(home: string = claudeHome()): Promise<SettingsView> {
  const { json } = await readSettingsRaw(home);
  await writeLastSeen(json);
  return readSettingsView(home);
}

// Apply only the changed keys onto the fresh on-disk document (never a blind
// whole-object overwrite), then refresh the drift baseline so Garrison's own
// write does not read as external drift next open.
export async function writeSettingsPatch(
  patch: SettingsObject,
  home: string = claudeHome()
): Promise<SettingsView> {
  const written = await writeSettingsMerged((draft) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete draft[key];
      } else {
        draft[key] = value;
      }
    }
  }, home);
  await writeLastSeen(written);
  return readSettingsView(home);
}

// Read-only drift check: compares the current on-disk settings against the last
// baseline Garrison wrote, WITHOUT establishing a baseline (unlike
// readSettingsView, which writes a last-seen on first open). Safe to poll for a
// live drift banner. Echo-suppressed: Garrison's own saves refresh the baseline
// (writeSettingsPatch -> writeLastSeen), so a self-write reads as deepEqual.
export async function computeSettingsDrift(
  home: string = claudeHome()
): Promise<{ changedExternally: boolean; lastSeenAt: string | null }> {
  const lastSeen = await readLastSeen();
  if (!lastSeen) return { changedExternally: false, lastSeenAt: null };
  const { json } = await readSettingsRaw(home);
  return { changedExternally: !deepEqual(json, lastSeen.settings), lastSeenAt: lastSeen.at };
}

export const __test = { deepEqual, lastSeenPath };
