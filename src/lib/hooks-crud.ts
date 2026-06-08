import { claudeHome } from "./claude-home";
import {
  readSettingsRaw,
  writeSettingsMerged,
  type HookGroup,
  type HookEntry,
  type SettingsObject
} from "./claude-settings-file";

// CRUD for HAND-AUTHORED (untagged) settings.json hook groups — the user's own
// hooks, managed from the Quarters Hooks UI.
//
// CRITICAL distinction from claude-settings-file's owner-scoped helpers
// (upsert/append/stripGarrisonHookGroup): those stamp a `_garrison: "fitting:<id>"`
// marker so fitting installs coexist. These DO NOT — a hand-authored hook must
// stay untagged, or the state model would misclassify the user's hook as
// fitting-owned. And these REFUSE to touch any `_garrison`-tagged group: those
// are fitting-managed and read-only here (uninstall the fitting to remove).

export interface HookCrudResult {
  ok: boolean;
  id?: string;
  code?: "not-found" | "owned" | "invalid";
  error?: string;
}

export interface HandHookInput {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

// Claude Code hook event names are PascalCase identifiers (SessionStart,
// PreToolUse, …). We don't hardcode the set (it evolves) — just shape-check.
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function isOwned(g: HookGroup | undefined): boolean {
  return !!g && g._garrison !== undefined;
}

function hooksOf(obj: SettingsObject): Record<string, HookGroup[]> {
  return (obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {}) as Record<string, HookGroup[]>;
}

function groupAt(obj: SettingsObject, event: string, index: number): HookGroup | undefined {
  const list = hooksOf(obj)[event];
  return Array.isArray(list) ? list[index] : undefined;
}

function buildEntry(input: HandHookInput): HookEntry {
  const entry: HookEntry = { type: "command", command: input.command.trim() };
  if (input.timeout !== undefined) entry.timeout = input.timeout;
  return entry;
}

export async function createHandHook(input: HandHookInput, home: string = claudeHome()): Promise<HookCrudResult> {
  if (!input.event || !EVENT_RE.test(input.event)) {
    return { ok: false, code: "invalid", error: "event is required (e.g. SessionStart, PreToolUse, Stop)" };
  }
  if (!input.command || !input.command.trim()) {
    return { ok: false, code: "invalid", error: "command is required" };
  }
  let index = -1;
  await writeSettingsMerged((draft) => {
    const hooks = (draft.hooks && typeof draft.hooks === "object" ? draft.hooks : (draft.hooks = {})) as Record<
      string,
      HookGroup[]
    >;
    const list = (hooks[input.event] = Array.isArray(hooks[input.event]) ? hooks[input.event] : []);
    const group: HookGroup = { hooks: [buildEntry(input)] };
    if (input.matcher && input.matcher.trim()) group.matcher = input.matcher.trim();
    list.push(group); // NO _garrison tag — this is hand-authored
    index = list.length - 1;
  }, home);
  return { ok: true, id: `hook:${input.event}#${index}` };
}

export async function updateHandHook(
  event: string,
  index: number,
  input: HandHookInput,
  home: string = claudeHome()
): Promise<HookCrudResult> {
  if (!input.command || !input.command.trim()) {
    return { ok: false, code: "invalid", error: "command is required" };
  }
  const { json } = await readSettingsRaw(home);
  const existing = groupAt(json, event, index);
  if (!existing) return { ok: false, code: "not-found", error: `no hook group ${event}#${index}` };
  if (isOwned(existing)) {
    return { ok: false, code: "owned", error: "fitting-owned hook — manage it via the fitting, not here" };
  }
  await writeSettingsMerged((draft) => {
    const grp = groupAt(draft, event, index);
    if (!grp || isOwned(grp)) return;
    const rest = Array.isArray(grp.hooks) ? grp.hooks.slice(1) : [];
    grp.hooks = [buildEntry(input), ...rest];
    if (input.matcher && input.matcher.trim()) grp.matcher = input.matcher.trim();
    else delete grp.matcher;
  }, home);
  return { ok: true, id: `hook:${event}#${index}` };
}

export async function deleteHandHook(event: string, index: number, home: string = claudeHome()): Promise<HookCrudResult> {
  const { json } = await readSettingsRaw(home);
  const existing = groupAt(json, event, index);
  if (!existing) return { ok: false, code: "not-found", error: `no hook group ${event}#${index}` };
  if (isOwned(existing)) {
    return { ok: false, code: "owned", error: "fitting-owned hook — uninstall the fitting to remove it" };
  }
  await writeSettingsMerged((draft) => {
    const hooks = hooksOf(draft);
    if (!Array.isArray(hooks[event])) return;
    hooks[event] = hooks[event].filter((_, i) => i !== index);
    if (hooks[event].length === 0) delete hooks[event]; // keep settings.json tidy
  }, home);
  return { ok: true, id: `hook:${event}#${index}` };
}

// Detail for one hook group, for the editor prefill.
export async function getHandHookDetail(
  event: string,
  index: number,
  home: string = claudeHome()
): Promise<{ event: string; index: number; group: HookGroup | null }> {
  const { json } = await readSettingsRaw(home);
  return { event, index, group: groupAt(json, event, index) ?? null };
}
