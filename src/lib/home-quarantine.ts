import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { garrisonDir, resolvedHome, userCompositionDir } from "./claude-home";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write";
import type { SharedRuntime } from "./types";

export function contentHash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function ownerId(marker: unknown): string | null {
  return typeof marker === "string" ? marker.replace(/^fitting:/, "") : marker === true ? "legacy:_garrison" : null;
}
export async function statOrNull(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Malformed ownership or config data is a stop, never an empty document. */
export async function readJsonObject<T extends object = Record<string, unknown>>(file: string): Promise<T> {
  let text: string;
  try { text = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as T; throw error; }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected an object in ${file}`);
  return value as T;
}
/** Confine the parent, without following a leaf symlink that will be moved. */
export function confinedHomePath(home: string, ref: string): string {
  if (!ref || path.isAbsolute(ref) || ref.includes("\\") || ref.split("/").some(p => p === ".." || p === "." || !p)) {
    throw new Error(`Unsafe home-relative path: ${ref}`);
  }
  const root = resolvedHome(home);
  const file = path.join(root, ref);
  const parent = resolvedHome(path.dirname(file));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error(`Home path escapes through a symlink: ${ref}`);
  return file;
}
export async function fileHash(home: string, ref: string): Promise<string | null> {
  const file = confinedHomePath(home, ref);
  const st = await statOrNull(file);
  return st?.isFile() ? contentHash(await fs.readFile(file)) : null;
}
export function hashMatches(actual: string | null, expected: string | undefined): boolean {
  return actual !== null && expected !== undefined && actual === expected.replace(/^sha256:/, "");
}

export interface PreservedHomeItem { runtime: SharedRuntime; ref: string; hash: string | null; at: string; reason: string; }
export async function preservedHomeItems(): Promise<PreservedHomeItem[]> {
  const data = await readJsonObject<{ items?: PreservedHomeItem[] }>(path.join(userCompositionDir(), "preserved.json"));
  return data.items ?? [];
}
export function isPreserved(items: PreservedHomeItem[], runtime: SharedRuntime, ref: string): boolean {
  return items.some(item => item.runtime === runtime && (item.ref === ref || item.ref.startsWith(`${ref}/`) || ref.startsWith(`${item.ref}/`)));
}
export async function preserveModified(runtime: SharedRuntime, home: string, ref: string, reason = "changed since Garrison installed it") {
  const items = await preservedHomeItems();
  if (items.some(item => item.runtime === runtime && item.ref === ref)) return;
  items.push({ runtime, ref, hash: await fileHash(home, ref), reason, at: new Date().toISOString() });
  await writeJsonAtomic(path.join(userCompositionDir(), "preserved.json"), { version: 1, items });
}

export interface RemovedHomeValue { runtime: SharedRuntime; kind: "hook" | "mcp" | "rule"; ref: string; source: string; value: unknown; }
export class HomeQuarantine {
  readonly dir: string;
  readonly moved: string[] = [];
  readonly leftModified: string[] = [];
  readonly removed: RemovedHomeValue[] = [];
  constructor(dir = path.join(garrisonDir(), "quarantine", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`)) {
    this.dir = dir;
  }
  static async open(dir?: string): Promise<HomeQuarantine> {
    const q = new HomeQuarantine(dir);
    const journal = await readJsonObject<{ items?: Array<{ ref: string; target: string }> }>(path.join(q.dir, "moves.json"));
    for (const item of journal.items ?? []) if (await statOrNull(item.target)) q.moved.push(item.ref);
    const removed = await readJsonObject<{ items?: RemovedHomeValue[] }>(path.join(q.dir, "removed.json"));
    q.removed.push(...(removed.items ?? []));
    return q;
  }
  async retain(runtime: SharedRuntime, home: string, ref: string) {
    await preserveModified(runtime, home, ref);
    if (!this.leftModified.includes(ref)) this.leftModified.push(ref);
  }
  async move(runtime: SharedRuntime, home: string, ref: string, expectedHash?: string): Promise<boolean> {
    const source = confinedHomePath(home, ref);
    const st = await statOrNull(source);
    if (!st) return false;
    if (isPreserved(await preservedHomeItems(), runtime, ref)) { await this.retain(runtime, home, ref); return false; }
    if (expectedHash !== undefined && !hashMatches(await fileHash(home, ref), expectedHash)) {
      await this.retain(runtime, home, ref);
      return false;
    }
    const target = path.join(this.dir, runtime, ref);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (await statOrNull(target)) throw new Error(`Quarantine destination already exists: ${target}`);
    // Rename preserves bytes and a leaf symlink. Cross-device failure stops;
    // there is deliberately no copy-and-delete fallback in a user's home.
    const journalFile = path.join(this.dir, "moves.json");
    const journal = await readJsonObject<{ items?: Array<{ ref: string; target: string }> }>(journalFile);
    const item = { ref: `${runtime}/${ref}`, target };
    await writeJsonAtomic(journalFile, { version: 1, items: [...(journal.items ?? []), item] }, { mode: 0o600 });
    await fs.rename(source, target);
    this.moved.push(item.ref);
    return true;
  }
  async record(entry: RemovedHomeValue): Promise<void> {
    const file = path.join(this.dir, "removed.json");
    const existing = await readJsonObject<{ version?: number; items?: RemovedHomeValue[] }>(file);
    const items = [...(existing.items ?? []), entry];
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(file, { version: 1, items }, { mode: 0o600 });
    this.removed.push(entry);
  }
  /** Record every original value durably before the compare-and-swap removal. */
  async editJson(file: string, entries: RemovedHomeValue[], mutate: (draft: Record<string, any>) => void): Promise<void> {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Quarantine refuses a symlinked config file: ${file}`);
    const bytes = await fs.readFile(file, "utf8");
    const draft = JSON.parse(bytes);
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error(`Expected an object in ${file}`);
    for (const entry of entries) await this.record(entry);
    mutate(draft);
    await writeFileAtomic(file, `${JSON.stringify(draft, null, 2)}\n`, { cas: { priorContent: bytes } });
  }
}
