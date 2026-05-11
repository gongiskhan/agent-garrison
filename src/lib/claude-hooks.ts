import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

// Sequoias-derived. Non-destructive merge of Garrison hooks into
// ~/.claude/settings.json. Marks groups with `_garrison: true` for
// idempotent uninstall.

const HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "PostToolUse"
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

interface MatcherGroup {
  matcher?: string;
  hooks?: Array<{ type: string; command: string; timeout?: number }>;
  _garrison?: boolean;
  [key: string]: unknown;
}

interface SettingsJson {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

export function defaultClaudeSettingsPath(): string {
  return path.join(homedir(), ".claude", "settings.json");
}

export function defaultSnapshotPath(): string {
  return path.join(homedir(), ".garrison", "hooks-snapshot.bytes");
}

export function defaultSnapshotMetaPath(): string {
  return path.join(homedir(), ".garrison", "hooks-snapshot.meta.json");
}

export interface InstallHooksOptions {
  hookUrl: string;
  settingsPath?: string;
  snapshotPath?: string;
  snapshotMetaPath?: string;
}

export async function installHooks(opts: InstallHooksOptions): Promise<void> {
  const settingsPath = opts.settingsPath ?? defaultClaudeSettingsPath();
  const snapshotPath = opts.snapshotPath ?? defaultSnapshotPath();
  const snapshotMetaPath = opts.snapshotMetaPath ?? defaultSnapshotMetaPath();

  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });

  const existedBefore = fs.existsSync(settingsPath);
  let originalBytes: Buffer | null = null;

  if (existedBefore) {
    originalBytes = await fsp.readFile(settingsPath);
    const parsed = safeParse(originalBytes.toString("utf8"));
    const hadOrphans = stripGarrisonGroups(parsed);
    if (hadOrphans) {
      const cleaned = JSON.stringify(parsed, null, 2);
      await fsp.writeFile(settingsPath, cleaned);
      originalBytes = Buffer.from(cleaned);
    }
  }

  await fsp.writeFile(
    snapshotMetaPath,
    JSON.stringify({ existedBefore, settingsPath }, null, 2)
  );
  if (originalBytes) {
    await fsp.writeFile(snapshotPath, originalBytes);
  } else if (fs.existsSync(snapshotPath)) {
    await fsp.unlink(snapshotPath);
  }

  const current: SettingsJson =
    existedBefore && originalBytes
      ? safeParse(originalBytes.toString("utf8"))
      : ({} as SettingsJson);
  current.hooks = current.hooks || {};

  for (const event of HOOK_EVENTS) {
    const cmd = buildHookCommand(event, opts.hookUrl);
    const list = (current.hooks[event] = current.hooks[event] || []);
    list.push({
      _garrison: true,
      matcher: "",
      hooks: [{ type: "command", command: cmd, timeout: 5 }]
    });
  }

  await fsp.writeFile(settingsPath, JSON.stringify(current, null, 2));
}

export interface RestoreHooksOptions {
  snapshotPath?: string;
  snapshotMetaPath?: string;
}

export async function restoreHooks(opts: RestoreHooksOptions = {}): Promise<void> {
  const snapshotPath = opts.snapshotPath ?? defaultSnapshotPath();
  const snapshotMetaPath = opts.snapshotMetaPath ?? defaultSnapshotMetaPath();
  if (!fs.existsSync(snapshotMetaPath)) return;
  let meta: { existedBefore: boolean; settingsPath: string } | null = null;
  try {
    meta = JSON.parse(await fsp.readFile(snapshotMetaPath, "utf8"));
  } catch {
    return;
  }
  if (!meta) return;

  try {
    if (meta.existedBefore) {
      const snapshot = await fsp.readFile(snapshotPath);
      await fsp.writeFile(meta.settingsPath, snapshot);
    } else {
      try {
        await fsp.unlink(meta.settingsPath);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await fsp.unlink(snapshotMetaPath);
    } catch {
      // ignore
    }
    try {
      await fsp.unlink(snapshotPath);
    } catch {
      // ignore
    }
  }
}

export function hooksAreInstalled(
  settingsPath: string = defaultClaudeSettingsPath()
): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  let parsed: SettingsJson;
  try {
    parsed = safeParse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return false;
  }
  for (const list of Object.values(parsed.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    if (list.some((g) => g && (g as MatcherGroup)._garrison)) return true;
  }
  return false;
}

function buildHookCommand(event: HookEvent, hookUrl: string): string {
  const escapedEvent = event.replace(/"/g, '\\"');
  return [
    "curl -s -X POST",
    hookUrl,
    "-H 'Content-Type: application/json'",
    `-d "{\\"event\\":\\"${escapedEvent}\\",\\"cwd\\":\\"$CLAUDE_PROJECT_DIR\\"}"`,
    "> /dev/null 2>&1 || true"
  ].join(" ");
}

function safeParse(text: string): SettingsJson {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as SettingsJson;
  } catch {
    // ignore
  }
  return {} as SettingsJson;
}

function stripGarrisonGroups(parsed: SettingsJson): boolean {
  if (!parsed.hooks) return false;
  let removed = false;
  for (const [event, list] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    parsed.hooks[event] = list.filter(
      (g) => !(g && (g as MatcherGroup)._garrison)
    );
    if (parsed.hooks[event].length !== before) removed = true;
  }
  return removed;
}
