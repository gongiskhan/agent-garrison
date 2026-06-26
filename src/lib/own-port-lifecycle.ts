import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { ROOT_DIR } from "./paths";
import { isOwnPortFitting } from "./faculties";
import { readLibrary } from "./library";
import { readVaultSecrets } from "./vault";
import type { LibraryEntry } from "./types";

// The lifecycle-managed env keys whose drift triggers a heal. Adding a key here
// makes a runtime change to that env (e.g. the gateway URL changing across an
// `up`) automatically restart any already-running own-port fitting so it sees
// the new value, without the caller having to opt in. Vault secrets are handled
// separately (the SpawnRecord's secretsDelivered bit), so this list is just the
// runner-projected configuration the fitting reads from process.env on boot.
const TRACKED_ENV_KEYS = ["GARRISON_GATEWAY_URL", "GARRISON_COMPOSITION_ID"] as const;

// Stable fingerprint of the tracked env keys in extraEnv. Only the tracked keys
// participate, so adding an unrelated key to extraEnv never forces a restart.
// Missing keys count as the literal string "<absent>" (NOT "" — an empty string
// is a value the user might intentionally set). The fingerprint is sha256 of
// `key=value` lines so two runs with the same tracked env hash identically
// regardless of how the runner ordered the keys.
export function envFingerprintForExtraEnv(extraEnv: Record<string, string> | undefined): string {
  const hash = createHash("sha256");
  for (const key of TRACKED_ENV_KEYS) {
    const value = extraEnv && key in extraEnv ? extraEnv[key] : "<absent>";
    hash.update(`${key}=${value}\n`);
  }
  return hash.digest("hex");
}

// Lifecycle helpers for own-port Fittings (detected per-Fitting via the
// `own_port` metadata flag — Monitor pattern). Garrison reads:
//   - x-garrison.lifecycle: "operative-bound" (default) | "detached"
//   - ~/.garrison/ui-fittings/<id>.json — the status file the Fitting writes
//     on start and removes on SIGTERM. Garrison kills by the PID it finds
//     there; it never grep's `lsof` because the file is the only source that
//     guarantees the PID is one this contract owns.
//   - ~/.garrison/ui-fittings/spawn/<id>.json — the GARRISON-side spawn record
//     written on every successful spawn here. It carries secretsDelivered:
//     whether the spawn env actually contained vault secrets (always true for
//     Fittings that do not consume vault). A vault-consuming Fitting started
//     by a process that could not read the vault (locked vault, or the
//     detached eager-boot child) runs keyless; when startOwnPortFitting later
//     sees it running, has a non-empty vault env, and the record says secrets
//     were NOT delivered (a missing record counts as not-delivered, as does a
//     record whose pid is not the live status-file pid — a process restarted
//     outside Garrison says nothing about ITS env), it HEALS: stops the
//     keyless process and respawns with the secrets. The record
//     lives in a SUBDIRECTORY so the flat *.json status-file enumeration
//     (/api/fittings/views) can never mistake it for a fitting status file.
//
// Resolved per-call through garrisonDir() (GARRISON_HOME-aware) so tests and
// the e2e sandbox can never SIGTERM the user's real fittings.

function statusDir(): string {
  return path.join(garrisonDir(), "ui-fittings");
}

function spawnRecordDir(): string {
  return path.join(statusDir(), "spawn");
}

export function spawnRecordPath(fittingId: string): string {
  return path.join(spawnRecordDir(), `${fittingId}.json`);
}

export function statusFilePath(fittingId: string): string {
  return path.join(statusDir(), `${fittingId}.json`);
}

export function logFilePath(fittingId: string): string {
  return path.join(statusDir(), `${fittingId}.log`);
}

export function isValidFittingId(fittingId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(fittingId);
}

// Per-fitting promise-chain lock: start/stop for the SAME fitting id must
// serialize, or concurrent callers (vault-unlock fire-and-forget heal, runner
// up, in-up eager boot, manual /start) can double-spawn one fitting or
// SIGTERM a freshly-healed child. Kept on globalThis so Next.js dev
// hot-reload cannot fork the chain (same pattern as the runner's record map).
// Scope: IN-PROCESS only. The server-start eager boot runs in a detached tsx
// child with its own lock map; cross-process dedup is best-effort via the
// spawn record (boot window below), and the runner's up-time heal repairs any
// keyless outcome the child leaves behind.
const fittingLocks: Map<string, Promise<void>> = ((
  globalThis as { __garrisonOwnPortLocks?: Map<string, Promise<void>> }
).__garrisonOwnPortLocks ??= new Map());

function withFittingLock<T>(fittingId: string, task: () => Promise<T>): Promise<T> {
  const prior = fittingLocks.get(fittingId) ?? Promise.resolve();
  const run = prior.then(task);
  // The stored chain link swallows the outcome so one caller's rejection can
  // never resurface as an unhandled rejection under the next caller's await.
  fittingLocks.set(
    fittingId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

export function isOperativeBound(entry: LibraryEntry): boolean {
  if (!isOwnPortFitting(entry)) return false;
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
  healed?: boolean;
  // What triggered the heal — "vault" (keyless process gained secrets) or
  // "env-drift" (a tracked env value changed; the gateway URL is the canonical
  // case). Only set when healed is true; lets the runner log the right
  // explanation.
  healReason?: "vault" | "env-drift";
  // Set when onlyIfRunning was requested and the fitting was not running.
  notRunning?: boolean;
  error?: string;
  status?: number;
}

export interface SpawnRecord {
  fittingId: string;
  pid: number;
  startedAt: string;
  secretsDelivered: boolean;
  // sha256 of the tracked env keys (envFingerprintForExtraEnv). A subsequent
  // start with a different fingerprint triggers a heal (kill + respawn) so the
  // fitting picks up the new value — e.g. a Kanban board left running across a
  // gateway restart, where GARRISON_GATEWAY_URL drifted, gets restarted with
  // the fresh URL on the next `up`. Missing on records written by an earlier
  // version (no field) — treated as a wildcard match so the field's absence
  // never spuriously heals; the next spawn writes the real fingerprint.
  envFingerprint?: string;
}

function entryConsumesVault(entry: LibraryEntry): boolean {
  return entry.metadata.consumes.some((c) => c.kind === "vault");
}

async function readSpawnRecord(fittingId: string): Promise<SpawnRecord | null> {
  try {
    const raw = await readFile(spawnRecordPath(fittingId), "utf8");
    const parsed = JSON.parse(raw) as Partial<SpawnRecord>;
    if (typeof parsed.pid !== "number") return null;
    return {
      fittingId,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      secretsDelivered: parsed.secretsDelivered === true,
      envFingerprint: typeof parsed.envFingerprint === "string" ? parsed.envFingerprint : undefined
    };
  } catch {
    // Missing or corrupt record reads as "secrets not delivered" — pre-fix
    // spawns have no record, and that is exactly the population to heal.
    return null;
  }
}

function writeSpawnRecord(record: SpawnRecord): void {
  mkdirSync(spawnRecordDir(), { recursive: true });
  writeFileSync(spawnRecordPath(record.fittingId), JSON.stringify(record, null, 2));
}

function isProcessAlive(pid: number): boolean {
  // process.kill(pid, 0) throws if the process is gone.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The heal path SIGTERMs the old process, then must wait for it to actually
// exit before respawning: the old process owns the port and (on SIGTERM)
// removes the status file — spawning early would race both. Returns whether
// the process is actually gone; callers must not respawn on false.
async function waitForExit(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

// How long a spawn record with no status file is trusted as "still booting".
// Fitting servers write their status file within milliseconds of listening;
// beyond this window a live recorded pid is almost certainly OS pid reuse
// (e.g. after a machine reboot left the record behind), and acting on it
// would kill an unrelated process or refuse a legitimate start.
const BOOT_WINDOW_MS = 30_000;

export interface StartOptions {
  // When set, do nothing unless the fitting is already running — used by the
  // vault-unlock heal pass, which must never cold-boot a stopped fitting.
  // Checked under the per-fitting lock so a concurrent down/sweep cannot
  // stop the fitting between the caller's check and the spawn.
  onlyIfRunning?: boolean;
}

export async function startOwnPortFitting(
  entry: LibraryEntry,
  extraEnv?: Record<string, string>,
  options: StartOptions = {}
): Promise<StartResult> {
  if (!isValidFittingId(entry.id)) {
    return { ok: false, error: "invalid fittingId", status: 400 };
  }
  return withFittingLock(entry.id, () => startOwnPortFittingLocked(entry, extraEnv, options));
}

async function startOwnPortFittingLocked(
  entry: LibraryEntry,
  extraEnv?: Record<string, string>,
  options: StartOptions = {}
): Promise<StartResult> {
  if (!isOwnPortFitting(entry)) {
    return { ok: false, error: `fitting ${entry.id} is not an own-port Fitting`, status: 400 };
  }
  const consumesVault = entryConsumesVault(entry);
  const hasExtraEnv = extraEnv !== undefined && Object.keys(extraEnv).length > 0;
  const record = await readSpawnRecord(entry.id);
  let livePid = await runningStatusPid(entry.id);
  // Boot window: a child Garrison spawned that has not yet written its status
  // file. The spawn record is Garrison's own, so a live recorded pid counts
  // as running — otherwise two serialized callers double-spawn against one
  // port. Trusted only while the record is fresh (see BOOT_WINDOW_MS).
  const recordAgeMs = record !== null ? Date.now() - Date.parse(record.startedAt) : Infinity;
  const recordFresh = Number.isFinite(recordAgeMs) && recordAgeMs >= 0 && recordAgeMs <= BOOT_WINDOW_MS;
  const bootingWithoutStatus =
    livePid === null && record !== null && recordFresh && isProcessAlive(record.pid);
  if (livePid === null && record !== null && !bootingWithoutStatus) {
    // Stale record with no status file: leftover from an exit that bypassed
    // stopOwnPortFitting (crash, reboot). Remove it so it cannot vouch for a
    // reused pid or mask a future keyless run.
    try {
      await unlink(spawnRecordPath(entry.id));
    } catch {
      // ignore
    }
  }
  if (bootingWithoutStatus && record !== null) livePid = record.pid;
  if (options.onlyIfRunning && livePid === null) {
    return { ok: true, notRunning: true };
  }
  let heal = false;
  let healReason: "vault" | "env-drift" | null = null;
  if (livePid !== null) {
    // secretsDelivered is only believed when the recorded pid IS the live
    // process — a process restarted outside Garrison inherits a stale record
    // that says nothing about ITS env.
    const delivered = record?.secretsDelivered === true && record.pid === livePid;
    if (consumesVault && hasExtraEnv && !delivered) {
      heal = true;
      healReason = "vault";
    }
    // Tracked-env drift: if the running fitting was last spawned with a
    // different GARRISON_GATEWAY_URL / GARRISON_COMPOSITION_ID than we want now,
    // restart it so it picks up the fresh value. Same recorded-pid gate as the
    // vault check — a process restarted outside Garrison says nothing about
    // ITS env, so we don't act on its drift. A record with no envFingerprint
    // (legacy) matches anything (no spurious heal); the respawn writes one.
    if (!heal && record?.pid === livePid && record.envFingerprint) {
      const desired = envFingerprintForExtraEnv(extraEnv);
      if (record.envFingerprint !== desired) {
        heal = true;
        healReason = "env-drift";
      }
    }
    if (!heal) {
      return { ok: true, alreadyRunning: true };
    }
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

  if (heal && livePid !== null) {
    if (bootingWithoutStatus) {
      // No status file to stop through yet; the recorded pid is ours to kill.
      try {
        process.kill(livePid, "SIGTERM");
      } catch {
        // already gone
      }
    } else {
      const stopped = await stopOwnPortFittingLocked(entry.id);
      if (!stopped.ok) {
        return { ok: false, error: `heal stop failed: ${stopped.error}`, status: 500 };
      }
    }
    let exited = await waitForExit(livePid);
    if (!exited) {
      // SIGTERM trapped or shutdown hung — escalate, or the respawn binds
      // against a still-held port and the new record lies about delivery.
      try {
        process.kill(livePid, "SIGKILL");
      } catch {
        // died between the timeout and the escalation
      }
      exited = await waitForExit(livePid, 1500);
    }
    if (!exited) {
      return {
        ok: false,
        error: `heal failed: pid ${livePid} survived SIGTERM and SIGKILL; refusing to respawn`,
        status: 500
      };
    }
  }

  // Redirect stdout/stderr to a per-Fitting log file so failures are visible.
  // Truncated on each start so the file always reflects the most recent
  // attempt; persists after exit so a crash leaves diagnostics behind.
  mkdirSync(statusDir(), { recursive: true });
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
  writeSpawnRecord({
    fittingId: entry.id,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    // True whenever this spawn could not have run keyless: either the Fitting
    // never asked for the vault, or the secrets are in its env right now.
    // After a heal this is always true, so the heal can never loop.
    secretsDelivered: !consumesVault || hasExtraEnv,
    envFingerprint: envFingerprintForExtraEnv(extraEnv)
  });
  if (heal) {
    return { ok: true, pid: child.pid, healed: true, healReason: healReason ?? "vault" };
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
  return withFittingLock(fittingId, () => stopOwnPortFittingLocked(fittingId));
}

async function stopOwnPortFittingLocked(fittingId: string): Promise<StopResult> {
  // The spawn record dies with every stop, even when the status file is
  // already gone — an external exit must not leave a stale
  // secretsDelivered:true record that masks a future keyless run.
  try {
    await unlink(spawnRecordPath(fittingId));
  } catch {
    // ignore
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

// Stop-then-start under a single lock so the fresh process never races the old
// one off the port. The wait-for-exit (with SIGKILL escalation) mirrors the
// vault-heal path: respawning before the old process releases its port is the
// EADDRINUSE footgun this exists to avoid. Used by the manual Restart control
// to reload an own-port Fitting's code without cycling the whole operative —
// the only reload path for eager (always-on) Fittings, which survive `down`.
export async function restartOwnPortFitting(
  entry: LibraryEntry,
  extraEnv?: Record<string, string>
): Promise<StartResult> {
  if (!isValidFittingId(entry.id)) {
    return { ok: false, error: "invalid fittingId", status: 400 };
  }
  return withFittingLock(entry.id, async () => {
    const stopped = await stopOwnPortFittingLocked(entry.id);
    if (!stopped.ok) {
      return { ok: false, error: `restart stop failed: ${stopped.error}`, status: stopped.status ?? 500 };
    }
    if (stopped.pid != null) {
      let exited = await waitForExit(stopped.pid);
      if (!exited) {
        try { process.kill(stopped.pid, "SIGKILL"); } catch { /* already gone */ }
        exited = await waitForExit(stopped.pid, 1500);
      }
      if (!exited) {
        return {
          ok: false,
          error: `restart failed: pid ${stopped.pid} survived SIGTERM and SIGKILL; refusing to respawn`,
          status: 500
        };
      }
    }
    return startOwnPortFittingLocked(entry, extraEnv);
  });
}

export interface HealSummary {
  healed: string[];
  skipped: string[];
  failed: Array<{ id: string; error: string }>;
}

// Re-delivers vault secrets to own-port Fittings that are RUNNING keyless —
// called fire-and-forget after a successful vault unlock. The running check
// happens inside startOwnPortFitting under the per-fitting lock
// (onlyIfRunning), so a down/sweep racing the unlock cannot stop a fitting
// between an outside check and the spawn: unlocking the vault must never boot
// something that was not running. The actual keyless-or-not decision is
// startOwnPortFitting's heal branch (spawn record + non-empty env). Start
// failures land in `failed` — the keyless process may be dead by then, so
// burying them as skips would hide a fitting the unlock just broke.
export async function healVaultConsumingFittings(
  options: { library?: LibraryEntry[] } = {}
): Promise<HealSummary> {
  const summary: HealSummary = { healed: [], skipped: [], failed: [] };
  const library = options.library ?? (await readLibrary());
  for (const entry of library) {
    if (!isOwnPortFitting(entry)) continue;
    if (!entryConsumesVault(entry)) continue;
    const result = await startOwnPortFitting(entry, await vaultEnvForEntry(entry), {
      onlyIfRunning: true
    });
    if (result.notRunning) {
      summary.skipped.push(entry.id);
    } else if (result.ok && result.healed) {
      summary.healed.push(entry.id);
      console.log(
        `[garrison] vault-heal: restarted ${entry.id} with vault secrets${result.pid ? ` (pid ${result.pid})` : ""}`
      );
    } else if (!result.ok) {
      const error = result.error ?? "start failed";
      summary.failed.push({ id: entry.id, error });
      console.warn(`[garrison] vault-heal: ${entry.id} failed: ${error}`);
    } else {
      summary.skipped.push(entry.id);
    }
  }
  return summary;
}

// Pid from the fitting's live status file: null when the file is missing,
// unparseable, or names a dead process.
async function runningStatusPid(fittingId: string): Promise<number | null> {
  const jsonPath = statusFilePath(fittingId);
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid !== "number") return null;
    return isProcessAlive(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}
