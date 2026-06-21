import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnTracked } from "./spawn";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { commandExists } from "./preflight";
import { listCompositions, readCompositionWithDerivedTasks, selectedLibraryEntries } from "./compositions";
import { readEagerBootPrefs, runEagerBoot } from "./eager-boot";
import { isOperativeBound, startOwnPortFitting, stopOwnPortFitting, vaultEnvForEntry } from "./own-port-lifecycle";
import { materializeEnv, wipeMaterializedEnv } from "./vault";
import { ROOT_DIR } from "./paths";
import { resolveCapabilities } from "./capabilities";
import type { GarrisonMetadata, LibraryEntry, RunnerState, VerifyResult } from "./types";

const SETUP_DEFAULT_TIMEOUT_MS = 60_000;

interface LogEvent {
  ts: string;
  stream: "runner" | "stdout" | "stderr" | "input";
  message: string;
}

interface GatewayInfo {
  fittingId: string;
  fittingDir: string;
  scriptPath: string;
  host: string;
  port: number;
  baseUrl: string;
  config: Record<string, unknown>;
}

interface RunnerRecord {
  state: RunnerState;
  logs: LogEvent[];
  logBytes: number;
  subscribers: Set<(event: LogEvent) => void>;
  process?: ChildProcessWithoutNullStreams;
  watcher?: FSWatcher;
  restartTimer?: NodeJS.Timeout;
  gateway?: GatewayInfo;
}

interface RunnerRuntime {
  records: Map<string, RunnerRecord>;
  // Startup orphan-sweep memo. Lives on globalThis next to the records map —
  // NOT module-local — because Next.js dev hot reloads re-instantiate this
  // module while globalThis persists. A module-local memo reset on every
  // reload and re-ran the sweep against a live operative's fittings.
  reconciliation?: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonRunner: RunnerRuntime | undefined;
}

const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function runtime(): RunnerRuntime {
  globalThis.__agentGarrisonRunner ??= { records: new Map() };
  return globalThis.__agentGarrisonRunner;
}

export function getRunnerState(compositionId: string): RunnerState {
  // On the first read after a Garrison process starts, the in-memory record
  // map is empty by definition. Any operative-bound own-port Fitting still
  // running on disk is an orphan from the previous process — reconcile it.
  // Fire-and-forget: state reads must stay synchronous, but a sweep finishing
  // a few ticks later is fine for the sidebar Views surface.
  void reconcileOrphanedOwnPortFittings();
  return getRecord(compositionId).state;
}

export function getLogScrollback(compositionId: string): LogEvent[] {
  return [...getRecord(compositionId).logs];
}

export function subscribeLogs(
  compositionId: string,
  subscriber: (event: LogEvent) => void
): () => void {
  const record = getRecord(compositionId);
  record.subscribers.add(subscriber);
  return () => record.subscribers.delete(subscriber);
}

export async function up(compositionId: string, options: { devMode?: boolean } = {}): Promise<RunnerState> {
  // Block on any pending reconciliation. If the user hits Run before the
  // fire-and-forget sweep from getRunnerState has finished, awaiting here
  // ensures stale Fittings are SIGTERM'd before we try to spawn fresh ones —
  // otherwise startOwnPortFitting would see a still-alive orphan and skip
  // the spawn, leaving the old bundle serving requests.
  await reconcileOrphanedOwnPortFittings();

  const record = getRecord(compositionId);
  if (record.process) {
    await down(compositionId);
  }
  updateState(compositionId, { status: "starting", devMode: Boolean(options.devMode), lastError: undefined });
  appendLog(compositionId, "runner", `Starting composition ${compositionId}`);

  try {
    await requireCommand(compositionId, "apm");
    const composition = await readCompositionWithDerivedTasks(compositionId);
    // `--force` so apm's "critical hidden characters" warnings on third-party
    // node_modules (zod locales etc.) don't abort install. The composition's
    // own fittings are reviewed via the four-check pipeline; the diagnostic
    // surfaces on transitive deps the user can't realistically audit line-by-
    // line. apm continues to PRINT the warnings, which the user can see in
    // the runner log.
    await runProcess(compositionId, "apm", ["install", "--force"], composition.directory);
    const envPath = await materializeEnv(composition.directory);
    appendLog(compositionId, "runner", `Materialised vault secrets to ${path.relative(ROOT_DIR, envPath)}`);
    await runSetupHooks(compositionId);
    const verifyResults = await verify(compositionId);
    const failed = verifyResults.find((result) => !result.ok);
    if (failed) {
      throw new Error(`Verify failed for ${failed.fittingId}`);
    }
    const promptPath = await assembleSystemPrompt(compositionId);

    const gateway = await resolveGatewayFitting(compositionId);
    let child: ChildProcessWithoutNullStreams;
    if (gateway) {
      await runProcess(
        compositionId,
        "npm",
        ["install", "--no-audit", "--no-fund", "--silent"],
        gateway.fittingDir
      );

      child = await spawnGateway(
        compositionId,
        composition.directory,
        promptPath,
        gateway
      );
      record.gateway = gateway;
    } else {
      await requireCommand(compositionId, "claude");
      child = spawnClaude(compositionId, composition.directory, promptPath);
      record.gateway = undefined;
    }

    record.process = child;
    updateState(compositionId, {
      status: "running",
      devMode: Boolean(options.devMode),
      pid: child.pid,
      startedAt: new Date().toISOString()
    });
    if (options.devMode) {
      await startDevWatcher(compositionId);
    }
    appendLog(compositionId, "runner", `Operative process started${child.pid ? ` with pid ${child.pid}` : ""}`);
    await startOperativeBoundFittings(compositionId);
    // Eager-toggled views also boot with the operative (not just with the
    // server): covers detached-lifecycle fittings and the case where the
    // server-start boot was missed. runEagerBoot skips anything already
    // running, so operative-bound fittings just started above are untouched.
    // Best-effort — a failed eager boot must not fail the operative.
    try {
      const eager = await runEagerBoot();
      if (eager.booted.length > 0 || eager.warmed.length > 0) {
        appendLog(
          compositionId,
          "runner",
          `eager views: booted [${eager.booted.join(", ") || "none"}], warmed [${eager.warmed.join(", ") || "none"}]`
        );
      }
      for (const failure of eager.failed) {
        appendLog(compositionId, "stderr", `eager boot FAILED for ${failure.id}: ${failure.error}`);
      }
    } catch (error) {
      appendLog(
        compositionId,
        "stderr",
        `eager boot failed (operative unaffected): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return getRunnerState(compositionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState(compositionId, { status: "failed", lastError: message });
    appendLog(compositionId, "runner", `Failed: ${message}`);
    throw error;
  }
}

export async function down(compositionId: string): Promise<RunnerState> {
  const record = getRecord(compositionId);
  updateState(compositionId, { status: "stopping" });
  appendLog(compositionId, "runner", `Stopping composition ${compositionId}`);

  if (record.restartTimer) {
    clearTimeout(record.restartTimer);
    record.restartTimer = undefined;
  }
  if (record.watcher) {
    await record.watcher.close();
    record.watcher = undefined;
  }
  await stopOperativeBoundFittings(compositionId);
  if (record.process) {
    await stopChild(record.process);
    record.process = undefined;
  }
  record.gateway = undefined;
  const composition = await readCompositionWithDerivedTasks(compositionId);
  await wipeMaterializedEnv(composition.directory);
  updateState(compositionId, { status: "stopped", pid: undefined, devMode: false });
  appendLog(compositionId, "runner", "Stopped and wiped materialised .env");
  return getRunnerState(compositionId);
}

// Exported for the eager-lifecycle vitest gate (sandbox GARRISON_HOME); the
// app itself only reaches this through getRunnerState/up.
export async function reconcileOrphanedOwnPortFittings(): Promise<void> {
  const rt = runtime();
  if (rt.reconciliation) return rt.reconciliation;
  rt.reconciliation = (async () => {
    try {
      const compositions = await listCompositions();
      // Eager-toggled fittings are NOT orphans: eager boot (Layer 3) owns
      // their lifecycle — they are meant to be "always there" across Garrison
      // restarts, carrying live state (PTY sessions etc.). Reaping them here
      // was exactly the bug that killed eager-booted terminals on the first
      // runner-state read. Trade-off: an eager fitting keeps serving its old
      // bundle across Garrison restarts; toggle eager off (or stop it
      // explicitly) when developing the fitting itself.
      const prefs = await readEagerBootPrefs();
      // Fittings of a composition whose persisted runner record says
      // "running" are NOT orphans either: the records map survives dev-server
      // hot reloads on globalThis even though this module is re-instantiated,
      // so a post-reload sweep (should the memo above ever be cleared) must
      // not reap the live operative's fittings. On a genuinely fresh process
      // the records map is empty, so true orphans from a previous process
      // still get reaped.
      const protectedIds = new Set<string>();
      const sweepable = new Set<string>();
      for (const composition of compositions) {
        const entries = await selectedLibraryEntries(composition.selections);
        const running = rt.records.get(composition.id)?.state.status === "running";
        for (const entry of entries) {
          if (!isOperativeBound(entry)) continue;
          if (running) {
            protectedIds.add(entry.id);
          } else {
            sweepable.add(entry.id);
          }
        }
      }
      for (const fittingId of sweepable) {
        if (protectedIds.has(fittingId)) continue;
        if (prefs.eager[fittingId]) continue;
        const result = await stopOwnPortFitting(fittingId);
        if (result.ok && result.wasRunning) {
          console.log(
            `[runner] reconciled orphan own-port fitting: ${fittingId}` +
              (result.pid ? ` (was pid ${result.pid})` : "")
          );
        }
      }
    } catch (err) {
      console.warn(`[runner] startup reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return rt.reconciliation;
}

async function startOperativeBoundFittings(compositionId: string): Promise<void> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  for (const entry of entries) {
    if (!isOperativeBound(entry)) continue;
    const extraEnv = await vaultEnvForEntry(entry);
    const result = await startOwnPortFitting(entry, extraEnv);
    if (!result.ok) {
      appendLog(compositionId, "stderr", `own-port ${entry.id}: ${result.error}`);
      continue;
    }
    if (result.healed) {
      appendLog(compositionId, "runner", `own-port ${entry.id} restarted to deliver vault secrets${result.pid ? ` (pid ${result.pid})` : ""}`);
    } else if (result.alreadyRunning) {
      appendLog(compositionId, "runner", `own-port ${entry.id} already running; left in place`);
    } else {
      appendLog(compositionId, "runner", `own-port ${entry.id} started${result.pid ? ` (pid ${result.pid})` : ""}`);
    }
  }
}

// Exported for the eager-lifecycle vitest gate; the app reaches this through
// down().
export async function stopOperativeBoundFittings(compositionId: string): Promise<void> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  // Eager-toggled fittings are server-lifecycle, not operative-lifecycle:
  // stopping the operative must not tear down an "always there" view (it
  // would drop live terminal sessions). They stay up; eager boot keeps
  // owning them.
  const prefs = await readEagerBootPrefs();
  for (const entry of entries) {
    if (!isOperativeBound(entry)) continue;
    if (prefs.eager[entry.id]) {
      appendLog(compositionId, "runner", `own-port ${entry.id} left running (eager: always-on)`);
      continue;
    }
    const result = await stopOwnPortFitting(entry.id);
    if (!result.ok) {
      appendLog(compositionId, "stderr", `own-port ${entry.id} stop: ${result.error}`);
      continue;
    }
    if (result.wasRunning) {
      appendLog(compositionId, "runner", `own-port ${entry.id} stopped (pid ${result.pid})`);
    }
  }
}

export interface SetupResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

// Project a fitting's selected config into setup-hook env vars, so a setup.sh
// can read its own config without re-parsing the composition YAML. Convention:
// <FITTING_ID>_<KEY>, both upper-cased with non-alphanumerics → "_". e.g. the
// improver's `cron` → IMPROVER_CRON, `memory_primary` → IMPROVER_MEMORY_PRIMARY;
// vault-git-sync's `cron` → VAULT_GIT_SYNC_CRON. Only scalar values (string,
// number, boolean) are injected; nested objects/arrays are skipped.
export function setupConfigEnv(
  fittingId: string,
  config: Record<string, unknown>
): Record<string, string> {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const prefix = norm(fittingId);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    env[`${prefix}_${norm(key)}`] = String(value);
  }
  return env;
}

export async function runFittingSetup(
  entry: { id: string; metadata: GarrisonMetadata },
  compositionDir: string,
  config: Record<string, unknown> = {}
): Promise<SetupResult> {
  const setup = entry.metadata.setup;
  if (!setup) {
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }
  const fittingDir = path.join(compositionDir, "apm_modules", "_local", entry.id);
  const result = await runShellCommand(
    fittingDir,
    setup.command,
    setup.timeout_ms ?? SETUP_DEFAULT_TIMEOUT_MS,
    setupConfigEnv(entry.id, config)
  );
  return { ...result, ok: result.exitCode === 0 };
}

async function runSetupHooks(compositionId: string): Promise<void> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  // Flatten the selection map → id-keyed config so each setup hook receives its
  // own composition config projected as env vars (see setupConfigEnv).
  const configById = new Map<string, Record<string, unknown>>();
  for (const items of Object.values(composition.selections)) {
    for (const item of items ?? []) {
      configById.set(item.id, (item.config ?? {}) as Record<string, unknown>);
    }
  }
  for (const entry of entries) {
    const setup = entry.metadata.setup;
    if (!setup) {
      continue;
    }
    appendLog(compositionId, "runner", `setup ${entry.id}: ${setup.command}`);
    const result = await runFittingSetup(entry, composition.directory, configById.get(entry.id) ?? {});
    if (result.stdout) {
      appendLog(compositionId, "stdout", result.stdout);
    }
    if (!result.ok) {
      if (result.stderr) {
        appendLog(compositionId, "stderr", result.stderr);
      }
      const detail = result.error ? `: ${result.error}` : "";
      throw new Error(
        `setup failed for ${entry.id}: exit ${result.exitCode ?? "null"}${detail}`
      );
    }
    appendLog(compositionId, "runner", `${entry.id} setup ok`);
  }
}

async function compositionNeedsApmInstall(
  compositionDir: string,
  entries: LibraryEntry[]
): Promise<boolean> {
  const localDir = path.join(compositionDir, "apm_modules", "_local");
  if (!existsSync(localDir)) return true;
  for (const entry of entries) {
    if (!existsSync(path.join(localDir, entry.id))) return true;
  }
  return false;
}

export async function verify(compositionId: string): Promise<VerifyResult[]> {
  updateState(compositionId, { status: "verifying" });
  appendLog(compositionId, "runner", "Running fitting verify hooks");
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);

  // Self-heal: on a fresh composition apm_modules/_local may be missing
  // entries and per-fitting setup may never have run, so verify hooks
  // probing for installed deps would fail with cryptic errors like "SDK
  // not installed". Re-run apm install (only when something is missing)
  // and the idempotent setup hooks before the verify loop.
  try {
    if (await compositionNeedsApmInstall(composition.directory, entries)) {
      appendLog(compositionId, "runner", "apm_modules incomplete; running apm install");
      await requireCommand(compositionId, "apm");
      await runProcess(compositionId, "apm", ["install", "--force"], composition.directory);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendLog(compositionId, "stderr", `apm install (pre-verify) failed: ${msg}`);
  }

  // Materialize the vault if unlocked, so verify hooks that read API keys
  // (and setup hooks below) can see them. If the vault is locked, log a
  // clear actionable message rather than silently letting hooks fail.
  try {
    const envPath = await materializeEnv(composition.directory);
    appendLog(
      compositionId,
      "runner",
      `Materialised vault secrets to ${path.relative(ROOT_DIR, envPath)} (verify will source them)`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendLog(compositionId, "stderr", `Vault not materialised: ${msg}`);
    appendLog(
      compositionId,
      "stderr",
      "Verify hooks that need vault-resolved credentials may fail. Unlock the Vault tab and re-verify."
    );
  }

  try {
    await runSetupHooks(compositionId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendLog(compositionId, "stderr", `Setup (pre-verify) failed: ${msg}`);
  }

  const results: VerifyResult[] = [];

  for (const entry of entries) {
    const started = Date.now();
    const verifyInfo = entry.metadata.verify;
    appendLog(compositionId, "runner", `verify ${entry.id}: ${verifyInfo.command}`);
    const result = await runShellCommand(
      composition.directory,
      verifyInfo.command,
      verifyInfo.timeout_ms
    );
    const stdout = result.stdout.trim();
    const ok = result.exitCode === 0 && stdout.includes(verifyInfo.expect);
    results.push({
      fittingId: entry.id,
      faculty: entry.faculty,
      command: verifyInfo.command,
      expect: verifyInfo.expect,
      ok,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      error: result.error
    });
    if (ok) {
      appendLog(compositionId, "runner", `${entry.id} verify passed`);
    } else {
      // Surface WHY: exit code, stderr, and any stdout the user didn't expect.
      // The single most common failure mode is a hook returning useful detail
      // on stderr that we used to swallow.
      appendLog(compositionId, "stderr", `${entry.id} verify failed`);
      const reason = result.error
        ? `error: ${result.error}`
        : `exit ${result.exitCode ?? "null"}, expected stdout to contain "${verifyInfo.expect}"`;
      appendLog(compositionId, "stderr", `  ${entry.id}: ${reason}`);
      const trimmedStderr = result.stderr.trim();
      if (trimmedStderr) {
        for (const line of trimmedStderr.split(/\r?\n/)) {
          appendLog(compositionId, "stderr", `  ${entry.id} stderr | ${line}`);
        }
      }
      const trimmedStdout = result.stdout.trim();
      if (trimmedStdout && !trimmedStdout.includes(verifyInfo.expect)) {
        for (const line of trimmedStdout.split(/\r?\n/)) {
          appendLog(compositionId, "stderr", `  ${entry.id} stdout | ${line}`);
        }
      }
    }
  }

  updateState(compositionId, {
    status: results.some((result) => !result.ok) ? "failed" : "idle",
    verifyResults: results
  });
  return results;
}

export async function dev(compositionId: string): Promise<RunnerState> {
  return up(compositionId, { devMode: true });
}

export function getGatewayBaseUrl(compositionId: string): string | null {
  const record = getRecord(compositionId);
  if (!record.gateway || record.state.status !== "running") {
    return null;
  }
  return record.gateway.baseUrl;
}

async function startDevWatcher(compositionId: string): Promise<void> {
  const record = getRecord(compositionId);
  if (record.watcher) {
    await record.watcher.close();
  }
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  const watchPaths = entries
    .map((entry) => entry.localPath)
    .filter((value): value is string => Boolean(value))
    .map((localPath) => path.join(ROOT_DIR, localPath));
  if (watchPaths.length === 0) {
    appendLog(compositionId, "runner", "Dev mode has no local-path fittings to watch");
    return;
  }
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    ignored: ["**/.git/**", "**/node_modules/**"]
  });
  watcher.on("all", (_event, changedPath) => {
    appendLog(compositionId, "runner", `Detected local fitting change: ${path.relative(ROOT_DIR, changedPath)}`);
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
    }
    record.restartTimer = setTimeout(() => {
      appendLog(compositionId, "runner", "Re-applying local fitting changes");
      up(compositionId, { devMode: true }).catch((error) => {
        appendLog(compositionId, "stderr", error instanceof Error ? error.message : String(error));
      });
    }, 750);
  });
  record.watcher = watcher;
  appendLog(compositionId, "runner", `Dev mode watching ${watchPaths.length} local fitting path(s)`);
}

async function assembleSystemPrompt(compositionId: string): Promise<string> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  const orchestratorRaw = await readPromptForFaculty(entries, "orchestrator");
  const fallbackOrchestrator = await fs.readFile(
    path.join(composition.directory, ".garrison", "prompts", "orchestrator.md"),
    "utf8"
  );
  // Identity/soul prompt comes from the composition default file (.garrison/
  // prompts/soul.md). Since the spawn path was retired, there is no separate
  // soul Faculty; identity folds into the assembled prompt ahead of behavior.
  const fallbackSoul = await fs.readFile(
    path.join(composition.directory, ".garrison", "prompts", "soul.md"),
    "utf8"
  );
  const orchestratorSource = orchestratorRaw ?? fallbackOrchestrator;
  // Loud, not silent: provider for_consumers reaches the Operative ONLY
  // through the {{capabilities}} placeholder, and prompt rewrites have
  // shipped without it before (the 2026-06 Quarters pivot's routing prompt).
  // We warn rather than auto-append the block so prompt authors keep control
  // of where it lands.
  const placeholderWarning = capabilitiesPlaceholderWarning(orchestratorSource);
  if (placeholderWarning) {
    appendLog(compositionId, "stderr", placeholderWarning);
  }
  const orchestrator = substituteCapabilitiesPlaceholder(orchestratorSource, entries);
  // BRIEF v4 MR1b: inject the compiled Model Router policy via {{routing}}.
  // No-op when the orchestrator prompt has no placeholder (e.g. the live
  // garrison-orchestrator), so the default composition is untouched.
  const routingSection = await resolveRoutingSection(composition.directory);
  if (orchestrator.includes("{{routing}}") && routingSection == null) {
    appendLog(compositionId, "stderr", MISSING_ROUTING_CONFIG_WARNING);
  }
  const orchestratorRouted = substituteRoutingPlaceholder(orchestrator, routingSection);
  // Identity first, Orchestrator (behavior) second — identity lands before the
  // long behavior section buries it.
  const prompt = [fallbackSoul, "", orchestratorRouted].join("\n");
  const promptPath = path.join(composition.directory, ".garrison", "assembled-system-prompt.md");
  await fs.writeFile(promptPath, prompt, "utf8");
  appendLog(compositionId, "runner", `Assembled system prompt at ${path.relative(ROOT_DIR, promptPath)}`);
  return promptPath;
}

export function substituteCapabilitiesPlaceholder(
  prompt: string,
  entries: LibraryEntry[]
): string {
  // Function replacement: the block embeds fitting-authored for_consumers
  // markdown verbatim, and a string second argument would expand $-patterns
  // ($&, $', $$) found in it as replacement directives.
  const block = renderCapabilitiesBlock(entries);
  return prompt.replace(/{{capabilities}}/g, () => block);
}

export const MISSING_CAPABILITIES_PLACEHOLDER_WARNING =
  "WARNING: orchestrator prompt has no {{capabilities}} placeholder — provider for_consumers will NOT reach the Operative";

export function capabilitiesPlaceholderWarning(prompt: string): string | null {
  return prompt.includes("{{capabilities}}") ? null : MISSING_CAPABILITIES_PLACEHOLDER_WARNING;
}

// ── Model Router routing section (BRIEF v4 MR1b) ─────────────────────────────
// The Model Router fitting owns routing.json (composition-scoped). At assembly
// the runner compiles the active Profile into a routing.md section and injects
// it via the {{routing}} placeholder. The compiler is the fitting's pure,
// dependency-free routing-core.mjs (single source of truth, also imported by
// the bare-node own-port view and vitest). We dynamic-import it by file URL at
// runtime so it is never pulled into the Next webpack bundle.
const ROUTING_CORE_PATH = path.join(ROOT_DIR, "fittings/seed/model-router/lib/routing-core.mjs");
const SEED_ROUTING_PATH = path.join(ROOT_DIR, "fittings/seed/model-router/config/routing.seed.json");

export const MISSING_ROUTING_CONFIG_WARNING =
  "WARNING: orchestrator prompt has a {{routing}} placeholder but no valid routing.json was found — the routing section will be empty";

// Pure: replace {{routing}} with the compiled section (or strip it cleanly when
// unavailable, so the placeholder never leaks into the assembled prompt).
export function substituteRoutingPlaceholder(prompt: string, section: string | null): string {
  if (!prompt.includes("{{routing}}")) return prompt;
  const block = section ?? "";
  return prompt.replace(/{{routing}}/g, () => block);
}

// Resolve + compile the routing section for a composition. Prefers a
// composition-scoped <dir>/.garrison/routing.json (written by the fitting's
// view PUT /routing), falling back to the model-router seed config. Returns
// null (and the caller warns) when no valid config is found.
export async function resolveRoutingSection(compositionDir: string): Promise<string | null> {
  const scoped = path.join(compositionDir, ".garrison", "routing.json");
  let raw: string | null = null;
  try {
    raw = await fs.readFile(scoped, "utf8");
  } catch {
    try {
      raw = await fs.readFile(SEED_ROUTING_PATH, "utf8");
    } catch {
      return null;
    }
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    const mod = (await import(pathToFileURL(ROUTING_CORE_PATH).href)) as {
      compileRouting: (c: unknown, p?: string | null) => string;
      validateRoutingConfig: (c: unknown) => string[];
    };
    const errors = mod.validateRoutingConfig(config);
    if (errors.length) return null;
    const activeProfile = (config as { activeProfile?: string }).activeProfile ?? null;
    return mod.compileRouting(config, activeProfile);
  } catch {
    return null;
  }
}

export function renderCapabilitiesBlock(entries: LibraryEntry[]): string {
  const inputs = entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }));
  const result = resolveCapabilities(inputs);
  const providerEntries: Array<{
    kind: string;
    name: string;
    summary: string;
    forConsumers?: string;
  }> = [];
  for (const entry of entries) {
    const summary = entry.metadata.summary?.trim() || entry.summary || entry.id;
    const forConsumers = entry.metadata.for_consumers?.trim() || undefined;
    for (const provision of entry.metadata.provides) {
      providerEntries.push({
        kind: provision.kind,
        name: provision.name,
        summary,
        forConsumers
      });
    }
  }
  if (!result.ok) {
    if (providerEntries.length === 0) {
      return "_no Faculties currently installed in this Composition._";
    }
  }
  if (providerEntries.length === 0) {
    return "_no Faculties currently installed in this Composition._";
  }
  providerEntries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });
  // If any provider ships a for_consumers block we render multi-line entries
  // separated by blank lines so the indented bodies don't run together. When
  // every provider falls back to summary we keep the legacy single-line form.
  const anyForConsumers = providerEntries.some((entry) => entry.forConsumers);
  const separator = anyForConsumers ? "\n\n" : "\n";
  return providerEntries
    .map((entry) => {
      const header = `- ${entry.kind}:${entry.name} — ${entry.summary}`;
      if (!entry.forConsumers) {
        return header;
      }
      const indented = entry.forConsumers
        .split(/\r?\n/)
        .map((line) => (line.length > 0 ? `  ${line}` : line))
        .join("\n");
      return `${header}\n${indented}`;
    })
    .join(separator);
}

async function readPromptForFaculty(
  entries: LibraryEntry[],
  faculty: "orchestrator"
): Promise<string | undefined> {
  const entry = entries.find((candidate) => candidate.faculty === faculty);
  if (!entry?.localPath) {
    return undefined;
  }
  const promptDir = path.join(ROOT_DIR, entry.localPath, ".apm", "prompts");
  try {
    const files = await fs.readdir(promptDir);
    const promptFile = files.find((file) => file.endsWith(".prompt.md"));
    if (!promptFile) {
      return undefined;
    }
    return fs.readFile(path.join(promptDir, promptFile), "utf8");
  } catch {
    return undefined;
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function resolveGatewayFitting(
  compositionId: string
): Promise<GatewayInfo | null> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const gatewaySelections = composition.selections.gateway ?? [];
  if (gatewaySelections.length === 0) {
    return null;
  }
  const entries = await selectedLibraryEntries(composition.selections);

  for (const selection of gatewaySelections) {
    const entry = entries.find((candidate) => candidate.id === selection.id);
    if (!entry) continue;

    const fittingDir = path.join(
      composition.directory,
      "apm_modules",
      "_local",
      entry.id
    );
    const scriptPath = path.join(fittingDir, "scripts", "gateway.mjs");

    try {
      await fs.access(scriptPath);
    } catch {
      continue;
    }

    const config = (selection.config ?? {}) as Record<string, unknown>;
    const host = String(config.bind_host ?? "127.0.0.1");
    const port = Number(config.port ?? 4777);

    return {
      fittingId: entry.id,
      fittingDir,
      scriptPath,
      host,
      port,
      baseUrl: `http://${host}:${port}`,
      config
    };
  }

  return null;
}

async function spawnGateway(
  compositionId: string,
  cwd: string,
  promptPath: string,
  gateway: GatewayInfo,
  extraEnv?: Record<string, string>
): Promise<ChildProcessWithoutNullStreams> {
  appendLog(
    compositionId,
    "runner",
    `Starting gateway fitting ${gateway.fittingId} on ${gateway.baseUrl}${extraEnv ? " (orchestrator mode)" : ""}`
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_GARRISON_COMPOSITION: compositionId,
    GARRISON_GATEWAY_HOST: gateway.host,
    GARRISON_GATEWAY_PORT: String(gateway.port),
    GARRISON_SYSTEM_PROMPT_PATH: promptPath,
    GARRISON_COMPOSITION_DIR: cwd,
    GARRISON_PERMISSION_MODE:
      (gateway.config.permission_mode as string | undefined) ?? "bypassPermissions",
    GARRISON_MODEL: (gateway.config.model as string | undefined) ?? "opus",
    ...(extraEnv ?? {})
  };

  const { child } = spawnTracked(
    "node",
    [gateway.scriptPath],
    { cwd, env },
    {
      spawnSite: "runner:spawnGateway",
      description: `${gateway.fittingId} on ${gateway.baseUrl}`
    }
  );

  child.stdout.on("data", (chunk) => appendLog(compositionId, "stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(compositionId, "stderr", chunk.toString()));
  child.on("exit", (code, signal) => {
    const record = getRecord(compositionId);
    record.process = undefined;
    appendLog(
      compositionId,
      "runner",
      `Gateway process exited code=${code ?? "null"} signal=${signal ?? "null"}`
    );
    if (record.state.status === "running") {
      updateState(compositionId, {
        status: code === 0 ? "stopped" : "failed",
        pid: undefined
      });
    }
  });
  child.on("error", (error) => {
    appendLog(compositionId, "stderr", error.message);
    updateState(compositionId, { status: "failed", lastError: error.message });
  });

  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway exited before becoming ready (code=${child.exitCode})`);
    }
    try {
      const response = await fetch(`${gateway.baseUrl}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await delay(250);
  }

  if (!ready) {
    throw new Error(`Gateway did not become ready within 10s on ${gateway.baseUrl}`);
  }

  appendLog(compositionId, "runner", `Gateway ready on ${gateway.baseUrl}`);
  return child;
}

function spawnClaude(compositionId: string, cwd: string, promptPath: string): ChildProcessWithoutNullStreams {
  const compositionName = `garrison-${compositionId}`;
  const scriptPath = path.join(ROOT_DIR, "scripts", "pty-operative.mjs");
  const args = [scriptPath];
  appendLog(
    compositionId,
    "runner",
    `Fallback: node ${path.relative(ROOT_DIR, scriptPath)} (${compositionName}, no gateway fitting selected)`
  );
  const { child } = spawnTracked(
    process.execPath,
    args,
    {
      cwd,
      env: {
        ...process.env,
        AGENT_GARRISON_COMPOSITION: compositionId,
        GARRISON_SYSTEM_PROMPT_PATH: promptPath,
        GARRISON_MODEL: "opus",
        GARRISON_PERMISSION_MODE: "bypassPermissions"
      }
    },
    { spawnSite: "runner:spawnClaude", description: `fallback claude (${compositionName})` }
  );

  child.stdout.on("data", (chunk) => appendLog(compositionId, "stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(compositionId, "stderr", chunk.toString()));
  child.on("exit", (code, signal) => {
    const record = getRecord(compositionId);
    record.process = undefined;
    appendLog(
      compositionId,
      "runner",
      `Claude process exited code=${code ?? "null"} signal=${signal ?? "null"}`
    );
    if (record.state.status === "running") {
      updateState(compositionId, {
        status: code === 0 ? "stopped" : "failed",
        pid: undefined
      });
    }
  });
  child.on("error", (error) => {
    appendLog(compositionId, "stderr", error.message);
    updateState(compositionId, { status: "failed", lastError: error.message });
  });

  return child;
}

async function requireCommand(compositionId: string, command: string): Promise<void> {
  if (!(await commandExists(command))) {
    throw new Error(`${command} is not installed or not on PATH`);
  }
  appendLog(compositionId, "runner", `preflight ok: ${command}`);
}

async function runProcess(
  compositionId: string,
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  appendLog(compositionId, "runner", `${command} ${args.join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const { child } = spawnTracked(
      command,
      args,
      { cwd, env: process.env },
      {
        spawnSite: "runner:runProcess",
        description: `${command} ${args.join(" ")}`
      }
    );
    child.stdout.on("data", (chunk) => appendLog(compositionId, "stdout", chunk.toString()));
    child.stderr.on("data", (chunk) => appendLog(compositionId, "stderr", chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function parseDotenv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadDotenvFromCwd(cwd: string): Record<string, string> {
  // Walk up from cwd looking for a `.env`. Setup hooks run in
  // apm_modules/_local/<id>/, but materializeEnv writes to the
  // composition root — so the env file the setup needs is several
  // levels above cwd. Walk up to 5 levels. Stop early at the repo
  // root (marked by package.json) to avoid leaking unrelated env
  // files from $HOME.
  try {
    const fsSync = require("node:fs") as typeof import("node:fs");
    let dir = cwd;
    for (let i = 0; i < 5; i++) {
      const envFile = path.join(dir, ".env");
      if (fsSync.existsSync(envFile)) {
        return parseDotenv(fsSync.readFileSync(envFile, "utf8"));
      }
      // Stop if we reach a package.json — we hit the repo root and
      // walking above it would pick up arbitrary user env files.
      if (fsSync.existsSync(path.join(dir, "package.json"))) {
        return {};
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return {};
  } catch {
    return {};
  }
}

async function runShellCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  // Note: listens on `close` rather than `exit` so stdio is fully drained
  // before resolving — `exit` can fire while data buffers still hold output.
  // Also merges any .env in cwd into the subprocess env so verify/setup hooks
  // see vault-resolved credentials without each Fitting needing to source it.
  // extraEnv (the fitting's projected config) wins over dotenv/process so a
  // composition's explicit config value is authoritative.
  return new Promise((resolve) => {
    const dotenvVars = loadDotenvFromCwd(cwd);
    const { child } = spawnTracked(
      command,
      {
        cwd,
        env: { ...process.env, ...dotenvVars, ...extraEnv },
        shell: true
      },
      { spawnSite: "runner:runShellCommand", description: command.slice(0, 80) }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ stdout, stderr, exitCode: null, error: "verify timed out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function getRecord(compositionId: string): RunnerRecord {
  const records = runtime().records;
  let record = records.get(compositionId);
  if (!record) {
    record = {
      state: {
        compositionId,
        status: "idle",
        devMode: false,
        verifyResults: []
      },
      logs: [],
      logBytes: 0,
      subscribers: new Set()
    };
    records.set(compositionId, record);
  }
  return record;
}

function updateState(compositionId: string, update: Partial<RunnerState>): void {
  const record = getRecord(compositionId);
  record.state = { ...record.state, ...update, compositionId };
}

function appendLog(compositionId: string, stream: LogEvent["stream"], message: string): void {
  const record = getRecord(compositionId);
  for (const line of message.split(/\r?\n/).filter((value) => value.length > 0)) {
    const event: LogEvent = { ts: new Date().toISOString(), stream, message: line };
    record.logs.push(event);
    record.logBytes += Buffer.byteLength(line);
    while (record.logs.length > MAX_LOG_LINES || record.logBytes > MAX_LOG_BYTES) {
      const removed = record.logs.shift();
      if (!removed) {
        break;
      }
      record.logBytes -= Buffer.byteLength(removed.message);
    }
    for (const subscriber of record.subscribers) {
      subscriber(event);
    }
  }
}
