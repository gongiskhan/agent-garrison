import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ROOT_DIR } from "./paths";
import { isOwnPortFaculty } from "./faculties";
import { readVaultSecrets } from "./vault";
import type { LibraryEntry } from "./types";

// Lifecycle helpers for own-port Fittings (those whose Faculty is in
// OWN_PORT_FACULTIES — Monitor pattern). Garrison reads:
//   - x-garrison.lifecycle: "operative-bound" (default) | "detached"
//   - ~/.garrison/ui-fittings/<id>.json — the status file the Fitting writes
//     on start and removes on SIGTERM. Garrison kills by the PID it finds
//     there; it never grep's `lsof` because the file is the only source that
//     guarantees the PID is one this contract owns.

const STATUS_DIR = path.join(os.homedir(), ".garrison", "ui-fittings");

export function statusFilePath(fittingId: string): string {
  return path.join(STATUS_DIR, `${fittingId}.json`);
}

export function logFilePath(fittingId: string): string {
  return path.join(STATUS_DIR, `${fittingId}.log`);
}

export function isValidFittingId(fittingId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(fittingId);
}

export function isOperativeBound(entry: LibraryEntry): boolean {
  if (!isOwnPortFaculty(entry.faculty)) return false;
  // Default for own-port Fittings is operative-bound; explicit "detached"
  // opts out.
  return entry.metadata.lifecycle !== "detached";
}

// Own-port Fittings are spawned detached with a copy of process.env — they do
// NOT see the materialized .env that the Operative reads. A Fitting that
// declares `consumes: vault` (e.g. deepgram-voice needs DEEPGRAM_API_KEY) gets
// its vault secrets injected into the spawn env here. Gated on the declared
// consumption so we never leak one Fitting's secrets into another that did not
// ask for the vault. Tolerant of a locked vault: returns {} so the manual
// /api/fittings/<id>/start path (no unlock guarantee, unlike `up`) still
// starts the Fitting — minus secrets — instead of crashing.
export async function vaultEnvForEntry(entry: LibraryEntry): Promise<Record<string, string>> {
  const consumesVault = entry.metadata.consumes.some((c) => c.kind === "vault");
  if (!consumesVault) return {};
  try {
    const secrets = await readVaultSecrets();
    return Object.fromEntries(secrets.map((s) => [s.key, s.value]));
  } catch {
    return {};
  }
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  alreadyRunning?: boolean;
  error?: string;
  status?: number;
}

export async function startOwnPortFitting(
  entry: LibraryEntry,
  extraEnv?: Record<string, string>
): Promise<StartResult> {
  if (!isValidFittingId(entry.id)) {
    return { ok: false, error: "invalid fittingId", status: 400 };
  }
  if (!isOwnPortFaculty(entry.faculty)) {
    return { ok: false, error: `fitting ${entry.id} is not an own-port Fitting`, status: 400 };
  }
  if (await isAlreadyRunning(entry.id)) {
    return { ok: true, alreadyRunning: true };
  }
  if (!entry.localPath) {
    return { ok: false, error: `fitting ${entry.id} has no localPath`, status: 400 };
  }
  const fittingDir = path.resolve(ROOT_DIR, entry.localPath);
  if (!fittingDir.startsWith(ROOT_DIR + path.sep)) {
    return { ok: false, error: "fitting path escapes repo root", status: 400 };
  }
  const startScript = path.join(fittingDir, "scripts", "start.mjs");
  if (!existsSync(startScript)) {
    return { ok: false, error: `no start script at ${startScript}`, status: 400 };
  }

  // Redirect stdout/stderr to a per-Fitting log file so failures are visible.
  // Truncated on each start so the file always reflects the most recent
  // attempt; persists after exit so a crash leaves diagnostics behind.
  mkdirSync(STATUS_DIR, { recursive: true });
  const logPath = logFilePath(entry.id);
  const logFd = openSync(logPath, "w");
  writeSync(logFd, `--- ${new Date().toISOString()} starting ${entry.id} ---\n`);

  const child = spawn(process.execPath, [startScript], {
    cwd: fittingDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...(extraEnv ?? {}) }
  });
  child.unref();
  closeSync(logFd);

  if (typeof child.pid !== "number") {
    return { ok: false, error: "spawn failed (no pid)", status: 500 };
  }
  return { ok: true, pid: child.pid };
}

export interface StopResult {
  ok: boolean;
  wasRunning: boolean;
  pid?: number | null;
  error?: string;
  status?: number;
}

export async function stopOwnPortFitting(fittingId: string): Promise<StopResult> {
  if (!isValidFittingId(fittingId)) {
    return { ok: false, wasRunning: false, error: "invalid fittingId", status: 400 };
  }
  const jsonPath = statusFilePath(fittingId);
  if (!existsSync(jsonPath)) {
    return { ok: true, wasRunning: false };
  }

  let pid: number | null = null;
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid === "number") pid = parsed.pid;
  } catch {
    // fall through; we'll still delete the file
  }

  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ESRCH") {
        return { ok: false, wasRunning: true, pid, error: e.message ?? String(err), status: 500 };
      }
    }
  }

  // Best-effort cleanup; the Fitting normally does this itself on SIGTERM.
  try {
    await unlink(jsonPath);
  } catch {
    // ignore
  }

  return { ok: true, wasRunning: pid !== null, pid };
}

async function isAlreadyRunning(fittingId: string): Promise<boolean> {
  const jsonPath = statusFilePath(fittingId);
  if (!existsSync(jsonPath)) return false;
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid !== "number") return false;
    // process.kill(pid, 0) throws if the process is gone.
    try {
      process.kill(parsed.pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
