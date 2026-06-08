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

// Typed-controls + raw-passthrough + drift layer over the single writer.
//
// KNOWN_SETTINGS is the hand-maintained descriptor map of OFFICIALLY-DOCUMENTED
// keys (source: https://code.claude.com/docs/en/settings and the published
// schema https://json.schemastore.org/claude-code-settings.json). It is the
// typed-controls layer ONLY — it never gates what may be written. Any key not
// in it (bespoke/experimental, e.g. advisorModel/autoMode on this machine)
// round-trips untouched through the Advanced passthrough.

export type ControlType = "boolean" | "string" | "number" | "enum" | "json";
export type SettingGroup =
  | "model"
  | "behavior"
  | "appearance"
  | "permissions"
  | "env"
  | "cleanup"
  | "advanced";

export interface KnownSetting {
  key: string;
  label: string;
  control: ControlType;
  group: SettingGroup;
  doc: string;
  enumValues?: string[];
  sinceVersion?: string;
}

// Curated high-value documented surface. Extend per Claude-Code version — it is
// intentionally a flat editable constant so a version bump is a one-file diff.
export const KNOWN_SETTINGS: KnownSetting[] = [
  { key: "model", label: "Model", control: "string", group: "model", doc: "Override the default model (e.g. claude-sonnet-4-6)." },
  { key: "outputStyle", label: "Output style", control: "string", group: "model", doc: "Adjust the system prompt style (e.g. Explanatory)." },
  { key: "effortLevel", label: "Effort level", control: "enum", enumValues: ["low", "medium", "high", "xhigh"], group: "model", doc: "Persist the reasoning effort level." },
  { key: "language", label: "Response language", control: "string", group: "behavior", doc: "Preferred response language (e.g. japanese)." },
  { key: "alwaysThinkingEnabled", label: "Always thinking", control: "boolean", group: "behavior", doc: "Enable extended thinking by default." },
  { key: "autoMemoryEnabled", label: "Auto memory", control: "boolean", group: "behavior", doc: "Enable automatic memory capture." },
  { key: "respectGitignore", label: "Respect .gitignore", control: "boolean", group: "behavior", doc: "Respect .gitignore in the file picker." },
  { key: "autoUpdatesChannel", label: "Auto-updates channel", control: "enum", enumValues: ["stable", "latest"], group: "behavior", doc: "Release channel for auto-updates." },
  { key: "editorMode", label: "Editor mode", control: "enum", enumValues: ["normal", "vim"], group: "appearance", doc: "Key binding mode." },
  { key: "tui", label: "Terminal renderer", control: "enum", enumValues: ["default", "fullscreen"], group: "appearance", doc: "Terminal UI renderer." },
  { key: "viewMode", label: "View mode", control: "enum", enumValues: ["default", "verbose", "focus"], group: "appearance", doc: "Default view." },
  { key: "spinnerTipsEnabled", label: "Spinner tips", control: "boolean", group: "appearance", doc: "Show tips while Claude works." },
  { key: "autoScrollEnabled", label: "Auto-scroll", control: "boolean", group: "appearance", doc: "Follow output in fullscreen." },
  { key: "cleanupPeriodDays", label: "Cleanup period (days)", control: "number", group: "cleanup", doc: "Session-file retention in days." },
  { key: "enableAllProjectMcpServers", label: "Auto-approve project MCP servers", control: "boolean", group: "advanced", doc: "Auto-approve servers from a project's .mcp.json." },
  { key: "disableAllHooks", label: "Disable all hooks", control: "boolean", group: "advanced", doc: "Disable all hooks and the status line." },
  { key: "env", label: "Environment variables", control: "json", group: "env", doc: "Environment variables applied to all sessions (object)." },
  { key: "permissions", label: "Permissions", control: "json", group: "permissions", doc: "allow / deny / ask rules + defaultMode (object)." },
  { key: "statusLine", label: "Status line", control: "json", group: "appearance", doc: "Custom status line { type, command } (object)." }
];

const KNOWN_KEYS = new Set(KNOWN_SETTINGS.map((s) => s.key));

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
      "Permissions shown are user-scope (~/.claude/settings.json) only. settings.local.json allow-rules merge into the effective set but are not shown or edited here."
  };
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
