import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { getInternalToken } from "./internal-token";
import { ROOT_DIR } from "./paths";
import { isOwnPortFitting } from "./faculties";
import { readLibrary } from "./library";
import { scopedSecrets } from "./vault";
import { recordVaultAccess } from "./vault-audit";
import type { LibraryEntry } from "./types";

// The lifecycle-managed env keys whose drift triggers a heal. Adding a key here
// makes a runtime change to that env (e.g. the gateway URL changing across an
// `up`) automatically restart any already-running own-port fitting so it sees
// the new value, without the caller having to opt in. Vault secrets are handled
// separately (the SpawnRecord's secretsDelivered bit), so this list is just the
// runner-projected configuration the fitting reads from process.env on boot.
const TRACKED_ENV_KEYS = ["GARRISON_GATEWAY_URL", "GARRISON_COMPOSITION_ID"] as const;

// Runner-projected per-fitting config keys (see ownPortConfigEnv) also drift-
// track: they follow GARRISON_<ID>_<KEY>, so a changed composition config value
// (e.g. the file-browser's root) restarts the fitting on the next `up` instead
// of being silently ignored. Vault secret names never carry this shape in
// practice, and even if one did, a changed secret forcing a restart is correct.
const PROJECTED_CONFIG_ENV_PATTERN = /^GARRISON_[A-Z0-9]+_[A-Z0-9_]+$/;

// Project a fitting's selected composition config into its spawn env. The
// convention fitting servers read is GARRISON_<ID>_<KEY> with the id's
// separators DROPPED (file-browser reads GARRISON_FILEBROWSER_ROOT) and the
// key's separators normalised to "_". Only scalar values (string, number,
// boolean) project; nested objects/arrays are skipped.
export function ownPortConfigEnv(
  fittingId: string,
  config: Record<string, unknown>
): Record<string, string> {
  const id = fittingId.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    const normKey = key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
    env[`GARRISON_${id}_${normKey}`] = String(value);
  }
  return env;
}

// Stable fingerprint of the lifecycle-managed env in extraEnv: the fixed
// tracked keys plus any projected config keys present. Unrelated keys never
// participate, so adding one to extraEnv never forces a restart. Missing
// tracked keys count as the literal string "<absent>" (NOT "" - an empty
// string is a value the user might intentionally set). The fingerprint is
// sha256 of `key=value` lines with the projected keys sorted, so two runs with
// the same env hash identically regardless of how the runner ordered the keys.
export function envFingerprintForExtraEnv(extraEnv: Record<string, string> | undefined): string {
  const hash = createHash("sha256");
  for (const key of TRACKED_ENV_KEYS) {
    const value = extraEnv && key in extraEnv ? extraEnv[key] : "<absent>";
    hash.update(`${key}=${value}\n`);
  }
  const projected = Object.keys(extraEnv ?? {})
    .filter(
      (key) =>
        PROJECTED_CONFIG_ENV_PATTERN.test(key) &&
        !(TRACKED_ENV_KEYS as readonly string[]).includes(key)
    )
    .sort();
  for (const key of projected) {
    hash.update(`${key}=${extraEnv![key]}\n`);
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

// Every fitting id with a spawn record on disk - Garrison's own kill ledger:
// everything it ever spawned and has not confirmed dead. The startup orphan
// sweep enumerates from here (not just current composition selections) so a
// deselected fitting or a clobbered status slot still gets reaped.
export async function listSpawnRecordIds(): Promise<string[]> {
  try {
    const names = await readdir(spawnRecordDir());
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => isValidFittingId(id));
  } catch {
    return [];
  }
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
  const scope = entry.metadata.secret_scope;
  if (!scope || scope.length === 0) {
    // Fail-closed (A2): per-connector scoping requires an explicit secret_scope.
    // A vault consumer that declares none receives NO secrets — never the whole
    // vault. Audited so the denied (unscoped) delivery is visible.
    console.warn(
      `[garrison] ${entry.id} consumes vault but declares no x-garrison.secret_scope; delivering no secrets.`
    );
    await recordVaultAccess({ connector: entry.id, secrets: [], action: "denied", outcome: "denied", detail: "no-secret-scope" });
    return {};
  }
  try {
    // Deliver ONLY the secrets the Fitting declared in its scope.
    const secrets = await scopedSecrets(scope);
    await recordVaultAccess({ connector: entry.id, secrets: secrets.map((s) => s.key), action: "deliver", outcome: "ok" });
    return Object.fromEntries(secrets.map((s) => [s.key, s.value]));
  } catch {
    return {};
  }
}

// Config keys NEVER projected as a bare runtime env var: PORT/HOST collide with
// names half the ecosystem reads, and gateway_url is delivered canonically as
// GARRISON_GATEWAY_URL — projecting an (often empty) apm.yml value would clobber it.
const OWN_PORT_CONFIG_ENV_SKIP = new Set(["port", "bind_host", "host", "gateway_url"]);

// Project an own-port Fitting's SELECTED config into the runtime spawn env under
// bare UPPER_SNAKE names (whisper_lang → WHISPER_LANG, kokoro_voice → KOKORO_VOICE),
// which is what the Fitting servers actually read. Without this the apm.yml config
// is decorative at runtime — the process runs on its server.mjs defaults, which is
// why pinning the STT language (whisper_lang) never took effect. Empty strings are
// skipped so an unset apm.yml value can't override a sensible default; objects and
// the collision-prone keys above are skipped too.
//
// NOTE: none of these keys are in TRACKED_ENV_KEYS, so adding this env to a spawn
// changes the delivered config but NOT the env-drift fingerprint — a caller can
// safely project config without perturbing the heal/restart decision.
export function ownPortConfigEnv(config: Record<string, unknown>): Record<string, string> {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    if (OWN_PORT_CONFIG_ENV_SKIP.has(key)) continue;
    const str = String(value);
    if (str === "") continue;
    env[norm(key)] = str;
  }
  return env;
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

// Pid-reuse guard for acting on a SPAWN RECORD's pid (the status file is the
// fitting's own writing and keeps its historical trust). On Linux /proc/<pid>
// is created at process start, so a process born meaningfully AFTER the record
// was written cannot be the recorded one - killing it would hit an unrelated
// process (the post-reboot stale-record case). Where /proc is unavailable the
// record is trusted, matching the status-file behaviour.
async function pidMatchesRecord(pid: number, startedAt: string): Promise<boolean> {
  const recorded = Date.parse(startedAt);
  if (!Number.isFinite(recorded)) return true;
  try {
    const st = await stat(`/proc/${pid}`);
    const born = st.mtimeMs || st.ctimeMs;
    if (!born) return true;
    return born <= recorded + 60_000;
  } catch {
    return true;
  }
}

// SIGTERM the pid, wait for it to exit, escalate to SIGKILL if it lingers.
// Returns whether the process is confirmed gone; callers must keep tracking
// files (and refuse to respawn) on false - a live process must never become an
// untracked one.
async function terminateWithEscalation(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  let exited = await waitForExit(pid);
  if (!exited) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // died between the timeout and the escalation
    }
    exited = await waitForExit(pid, 1500);
  }
  return exited;
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
  // Opt-in: restart a running fitting whose recorded env fingerprint differs
  // from this call's extraEnv. Only callers that KNOW the full desired env
  // (the runner's up path) may set it - a narrower caller (vault heal, manual
  // start) healing on drift would strip the gateway URL / composition id from
  // a correctly-spawned fitting.
  healOnEnvDrift?: boolean;
}

export async function startOwnPortFitting(
  entry: LibraryEntry,
  extraEnv?: Record<string, string>,
  options: StartOptions = {}
): Promise<StartResult> {
  if (!isValidFittingId(entry.id)) {
    return { ok: false, error: "invalid fittingId", status: 400 };
  }
  // Fittings that call token-gated backend routes (the automations engine's
  // vision/connector calls, drill) read ~/.garrison/internal-token directly at
  // call time and send "" when it is absent - a guaranteed 403. The backend is
  // the token's only minter (create-on-first-use), and nothing else guarantees
  // a first use before a consumer boots on a fresh machine, so mint it here.
  await getInternalToken();
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
  if (bootingWithoutStatus && record !== null) livePid = record.pid;
  if (options.onlyIfRunning && livePid === null) {
    // The vault-heal pass must never cold-boot OR kill anything not running;
    // any stale record is left for the next real start/sweep to reconcile.
    return { ok: true, notRunning: true };
  }
  if (livePid === null && record !== null) {
    if (isProcessAlive(record.pid) && (await pidMatchesRecord(record.pid, record.startedAt))) {
      // The recorded process is still alive with no status file (clobbered
      // slot, fitting that never wrote one). Cold-spawning over it would
      // orphan a live process on its port - kill it first, and refuse to
      // double-spawn if it will not die.
      const exited = await terminateWithEscalation(record.pid);
      if (!exited) {
        return {
          ok: false,
          error: `recorded pid ${record.pid} survived SIGTERM and SIGKILL; refusing to double-spawn`,
          status: 500
        };
      }
    }
    // Stale record with no live recorded process: leftover from an exit that
    // bypassed stopOwnPortFitting (crash, reboot) or the kill above. Remove it
    // so it cannot vouch for a reused pid or mask a future keyless run.
    try {
      await unlink(spawnRecordPath(entry.id));
    } catch {
      // ignore
    }
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
    // different GARRISON_GATEWAY_URL / GARRISON_COMPOSITION_ID / projected
    // config than we want now, restart it so it picks up the fresh value.
    // Opt-in per call (healOnEnvDrift): only the runner's up path knows the
    // full desired env - a narrower caller acting on drift would strip it.
    // Same recorded-pid gate as the vault check - a process restarted outside
    // Garrison says nothing about ITS env, so we don't act on its drift. A
    // record with no envFingerprint (legacy) matches anything (no spurious
    // heal); the respawn writes one.
    if (!heal && options.healOnEnvDrift && record?.pid === livePid && record.envFingerprint) {
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
  const jsonPath = statusFilePath(fittingId);
  const record = await readSpawnRecord(fittingId);

  let pid: number | null = null;
  if (existsSync(jsonPath)) {
    try {
      const raw = await readFile(jsonPath, "utf8");
      const parsed = JSON.parse(raw) as { pid?: number };
      if (typeof parsed.pid === "number") pid = parsed.pid;
    } catch {
      // unreadable status file; fall through to the spawn record
    }
  }
  // No usable status file: fall back to Garrison's own spawn record so a stop
  // can never leave the recorded process alive but untracked (boot window,
  // clobbered status slot, fitting that never wrote its file). Guarded against
  // OS pid reuse - a record from before a reboot must not kill a stranger.
  if (pid === null && record !== null) {
    if (isProcessAlive(record.pid) && (await pidMatchesRecord(record.pid, record.startedAt))) {
      pid = record.pid;
    }
  }

  if (pid === null || !isProcessAlive(pid)) {
    // Nothing alive - safe to clear the tracking files. An external exit must
    // not leave a stale secretsDelivered:true record that masks a future
    // keyless run.
    try {
      await unlink(spawnRecordPath(fittingId));
    } catch {
      // ignore
    }
    try {
      await unlink(jsonPath);
    } catch {
      // ignore
    }
    return { ok: true, wasRunning: false, pid };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ESRCH") {
      return { ok: false, wasRunning: true, pid, error: e.message ?? String(err), status: 500 };
    }
  }
  let exited = await waitForExit(pid);
  if (!exited) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // died between the timeout and the escalation
    }
    exited = await waitForExit(pid, 1500);
  }
  if (!exited) {
    // The process would not die. KEEP the tracking files - deleting them here
    // would convert a live process into an untracked one, exactly the orphan
    // generator this path exists to close.
    return {
      ok: false,
      wasRunning: true,
      pid,
      error: `pid ${pid} survived SIGTERM and SIGKILL; keeping status file and spawn record`,
      status: 500
    };
  }

  // Confirmed exit - the tracking files may go. The Fitting normally removes
  // its own status file on SIGTERM; this is the crash-safe backstop.
  try {
    await unlink(spawnRecordPath(fittingId));
  } catch {
    // ignore
  }
  try {
    await unlink(jsonPath);
  } catch {
    // ignore
  }
  return { ok: true, wasRunning: true, pid };
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
