import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnTracked } from "./spawn";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { commandExists } from "./preflight";
import { listCompositions, readCompositionWithDerivedTasks, selectedLibraryEntries, type CompositionV4 } from "./compositions";
import {
  listSpawnRecordIds,
  ownPortConfigEnv,
  startOwnPortFitting,
  stopOwnPortFitting,
  vaultEnvForEntry
} from "./own-port-lifecycle";
import { isOwnPortFitting } from "./faculties";
import { readLibrary } from "./library";
import { deriveViewProvisions } from "./view-instances";
import { wipeMaterializedEnv } from "./vault";
import { syncCompositionFromState, materializeEnvViaAuthority } from "./composition-sync";
import { compositionFingerprint, readLastUp, writeLastUp } from "./up-fingerprint";
import {
  DEFAULT_PRIMARY_RUNTIME,
  resolvePrimaryRuntime,
  buildPrimaryRuntimeEnv,
  deriveRuntimeTargets,
  mergeRuntimeTargets,
  type RouterTarget,
  type RuntimeEntry
} from "./runtime-selection";
import { ROOT_DIR } from "./paths";
import {
  PRIMARY_CONTEXT_FILES,
  projectPrimaryContext,
  writeAssembledOrchestratorPrompt
} from "./orchestrator-projection";
import {
  clearKanbanResolvedModel,
  computeKanbanResolvedModel,
  writeKanbanResolvedModel,
  type KanbanResolvedModel
} from "./kanban-model";
import { garrisonDir } from "./claude-home";
import { stateEnvForProjection } from "./state-client";
import { appPort, applyPortOffsetToConfig, BASE_GATEWAY_PORT, profilePort } from "./instance-profile";
import {
  claimCompositionForLaunch,
  isCompositionClaimCurrent,
  releaseComposition,
  releaseCompositionClaim,
  type CompositionLaunchClaim
} from "./composition-owner";
import {
  accountTokenForSpawn,
  listAccounts,
  resolvePrimaryRuntimeAccount,
  resolveRuntimeAccountEnv,
  setAccountNeedsRelogin,
  type RuntimeAccountRequest
} from "./accounts";
import {
  accountVaultKey,
  PLATFORM_SPECS,
  type AccountPlatform
} from "./account-env";
import {
  PaymasterHoldError,
  candidatesFrom,
  ensurePaymasterHeartbeat,
  formatDecisionLines,
  readUsageCache,
  refreshUsage,
  resolveAutoAccount,
  resolvePaymaster
} from "./paymaster";
import { writeFileAtomic } from "./atomic-write";
import { appendRunEvidence } from "./run-evidence";
import { resolveCapabilities } from "./capabilities";
import { reconcileCoordTeardown } from "./coord-wiring";
import {
  ensureCompositionRoutingPolicy,
  readRoutingPolicySource,
  resolvePrimaryFromPolicy
} from "./routing-primary";
import type { FittingSelectionMap, GarrisonMetadata, LibraryEntry, RunnerState, VerifyResult } from "./types";

export { resolvePrimaryFromPolicy } from "./routing-primary";

const SETUP_DEFAULT_TIMEOUT_MS = 60_000;

// Decide whether up() projects the composition's resolved model to the Kanban
// board, and with what log line (S4a codex finding). A model with an empty
// kanbanLists (no selected duties / a malformed duty graph) is NOT a projection —
// writing it would stamp an empty model.json and log a misleading "projected 0
// phase list(s)". So skip the write and log the honest reason; only a non-empty
// resolved duty model projects. Pure — no disk, so it is unit-testable.
export function kanbanProjectionPlan(kmodel: KanbanResolvedModel): { write: boolean; log: string } {
  if (kmodel.kanbanLists.length === 0) {
    return {
      write: false,
      log: "kanban model: no resolved duty model (no selected duties) — board keeps its default pipeline; projection skipped"
    };
  }
  return {
    write: true,
    log: `kanban model: projected ${kmodel.kanbanLists.length} phase list(s) → ${kmodel.kanbanLists.join(", ")}`
  };
}

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
  // Serialize lifecycle mutations for one composition inside this server
  // process. Without this, two Run/restart requests can interleave PID-file
  // publication, account attribution, and catch cleanup against one record.
  operationTail?: Promise<void>;
  // RUNTIME-ACCOUNTS-V1 D5: the account the running operative is pinned to,
  // so an auth failure in the log stream can flag it needs-relogin (once).
  activeAccount?: string;
  // The account name alone is not enough to interpret provider failures. In
  // particular, only an Anthropic account can be probed or rotated by the
  // Paymaster; a GLM/OpenAI/etc. account must stay on its own provider rail.
  activeAccountPlatform?: AccountPlatform;
  authFailureFlagged?: boolean;
  // PAYMASTER D10: a mid-run usage-limit hit is surfaced once (sticky session,
  // no migration) with the resolver's current best alternative pre-computed.
  limitFlagged?: boolean;
  // After a limit trigger that a live probe DISPROVED (session output merely
  // mentioning limit phrases), suppress re-checking until this timestamp so a
  // chatty log cannot spam probes - while a real hit later still surfaces.
  limitCooldownUntil?: number;
}

interface RunnerRuntime {
  records: Map<string, RunnerRecord>;
  // Startup orphan-sweep memo. Lives on globalThis next to the records map —
  // NOT module-local — because Next.js dev hot reloads re-instantiate this
  // module while globalThis persists. A module-local memo reset on every
  // reload and re-ran the sweep against a live operative's fittings.
  reconciliation?: Promise<void>;
}

export type PrimaryAccountRoute =
  | { kind: "anthropic-plan" }
  | { kind: "strict"; platform: AccountPlatform; allowAuthFile: boolean }
  | { kind: "ignored"; reason: string }
  | { kind: "unsupported"; reason: string };

/**
 * Map the primary ENGINE + provider onto exactly one credential rail. Provider
 * ids are not account platforms: `zai-glm` is an Anthropic-compatible endpoint,
 * while `glm` is the OpenAI-shaped self-hosted slot. Keeping that distinction
 * explicit prevents a stale pin or an alias from selecting the wrong vault key.
 */
export function primaryAccountRoute(
  engine: string,
  providerId: string,
  providerKind?: string
): PrimaryAccountRoute {
  if (engine === "claude-code" || engine === "agent-sdk") {
    if (providerId === "anthropic-plan" || providerKind === "anthropic-plan") {
      return { kind: "anthropic-plan" };
    }
    return {
      kind: "ignored",
      reason: `provider "${providerId}" uses its provider vault credential, not an Anthropic account pin`
    };
  }
  if (engine === "codex") {
    return { kind: "strict", platform: "openai", allowAuthFile: true };
  }
  if (engine === "gemini") {
    return { kind: "strict", platform: "google", allowAuthFile: true };
  }
  if (engine === "openrouter") {
    return { kind: "strict", platform: "openrouter", allowAuthFile: false };
  }
  if (engine === "huggingface") {
    return { kind: "strict", platform: "huggingface", allowAuthFile: false };
  }
  if (engine === "openai-agents") {
    if (providerId === "glm") {
      return { kind: "strict", platform: "glm", allowAuthFile: false };
    }
    if (providerId === "openai" || providerId === "openai-compat") {
      return { kind: "strict", platform: "openai", allowAuthFile: false };
    }
    // The ChatGPT subscription is authenticated by the SAME auth-file credential
    // the codex engine uses (the runtime resolves and refreshes it out of the
    // account home this pin materializes), so it is the one openai-agents provider
    // that must accept an auth-file account. Mirrors runtimeAccountContract's
    // client-side entry - the two are asserted against each other in tests.
    if (providerId === "chatgpt-subscription") {
      return { kind: "strict", platform: "openai", allowAuthFile: true };
    }
    if (providerId === "ollama-local") {
      return {
        kind: "unsupported",
        reason: "provider \"ollama-local\" is keyless and cannot use a named account"
      };
    }
    return {
      kind: "unsupported",
      reason: `provider "${providerId}" has no declared named-account platform`
    };
  }
  return {
    kind: "unsupported",
    reason: `engine "${engine}" has no declared primary-account platform`
  };
}

function defaultProviderForPrimaryEngine(engine: string): string {
  if (engine === "claude-code") return "anthropic-plan";
  if (engine === "agent-sdk" || engine === "openai-agents") return "ollama-local";
  return "";
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonRunner: RunnerRuntime | undefined;
}

const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_BUFFERED_LOG_LINE_BYTES = 1024 * 1024;

export interface LogLineBuffer {
  pending: string;
}

/**
 * Turn arbitrary pipe chunks into complete lines. Child-process data events do
 * not preserve write boundaries, so parsing each chunk as JSON can miss a real
 * structured provider failure split across two events. The one-line cap keeps a
 * broken/no-newline child from growing runner memory without bound.
 */
export function splitBufferedLogChunk(
  buffer: LogLineBuffer,
  chunk: string,
  flush = false
): string[] {
  const parts = `${buffer.pending}${chunk}`.split(/\r?\n/);
  buffer.pending = parts.pop() ?? "";
  if (
    flush ||
    Buffer.byteLength(buffer.pending) > MAX_BUFFERED_LOG_LINE_BYTES
  ) {
    if (buffer.pending) parts.push(buffer.pending);
    buffer.pending = "";
  }
  return parts.filter((line) => line.length > 0);
}

function runtime(): RunnerRuntime {
  globalThis.__agentGarrisonRunner ??= { records: new Map() };
  return globalThis.__agentGarrisonRunner;
}

export async function withRunnerOperation<T>(
  compositionId: string,
  operation: () => Promise<T>
): Promise<T> {
  const record = getRecord(compositionId);
  const prior = record.operationTail ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The tail represents completion of this operation's gate, independent of
  // whether the operation itself succeeds. Later lifecycle calls wait for it.
  const tail = prior.catch(() => undefined).then(() => gate);
  record.operationTail = tail;
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (record.operationTail === tail) record.operationTail = undefined;
  }
}

function assertOwnedLiveProcess(
  record: RunnerRecord,
  child: ChildProcessWithoutNullStreams,
  stage: string,
  requireRunning = false
): void {
  if (
    record.process !== child ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.killed ||
    (requireRunning && record.state.status !== "running")
  ) {
    throw new Error(`Operative process exited or lost ownership during ${stage}`);
  }
}

function clearAccountAttribution(record: RunnerRecord): void {
  record.activeAccount = undefined;
  record.activeAccountPlatform = undefined;
  record.authFailureFlagged = false;
  record.limitFlagged = false;
  record.limitCooldownUntil = undefined;
}

function armAccountAttribution(
  record: RunnerRecord,
  account: string | undefined,
  platform: AccountPlatform | undefined
): void {
  clearAccountAttribution(record);
  record.activeAccount = account;
  record.activeAccountPlatform = platform;
}

export interface FailedLaunchClaimState extends CompositionLaunchClaim {
  compositionDir: string;
  envMaterialized: boolean;
}

/**
 * Remove failed-start state only for a fresh, exact claim with no possibly-live
 * child/fitting/watch resource. This seam is exported so the ownership + secret
 * cleanup contract can be regression-tested without launching a real runtime.
 */
export async function cleanupFailedLaunchClaim(
  claim: FailedLaunchClaimState | undefined,
  hasPossiblyLiveResources: boolean
): Promise<string[]> {
  if (!claim?.acquiredFresh || hasPossiblyLiveResources) return [];
  const errors: string[] = [];
  try {
    if (!(await isCompositionClaimCurrent(claim.compositionDir, claim.owner))) {
      return [];
    }
    if (claim.envMaterialized) {
      await wipeMaterializedEnv(claim.compositionDir, { strict: true });
    }
    const released = await releaseCompositionClaim(claim.compositionDir, claim.owner);
    if (!released) {
      errors.push("composition ownership changed during failed-start cleanup; newer owner preserved");
    }
  } catch (error) {
    errors.push(`composition claim: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/** A non-Claude primary is hosted only by the composed HTTP gateway adapter. */
export function assertPrimaryGatewayCompatibility(
  engine: string,
  hasGateway: boolean
): void {
  if (engine !== "claude-code" && !hasGateway) {
    throw new Error(
      `primary engine "${engine}" requires a composed HTTP gateway; the no-gateway fallback can host only claude-code.`
    );
  }
}

export function getRunnerState(compositionId: string): RunnerState {
  // On the first read after a Garrison process starts, the in-memory record
  // map is empty by definition. Any operative-bound own-port Fitting still
  // running on disk is an orphan from the previous process — reconcile it.
  // Fire-and-forget: state reads must stay synchronous, but a sweep finishing
  // a few ticks later is fine for the sidebar Fittings surface.
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

export async function up(
  compositionId: string,
  options: { devMode?: boolean; full?: boolean } = {}
): Promise<RunnerState> {
  return withRunnerOperation(compositionId, () => upUnlocked(compositionId, options));
}

async function upUnlocked(
  compositionId: string,
  options: { devMode?: boolean; full?: boolean } = {}
): Promise<RunnerState> {
  // Block on any pending reconciliation. If the user hits Run before the
  // fire-and-forget sweep from getRunnerState has finished, awaiting here
  // ensures stale Fittings are SIGTERM'd before we try to spawn fresh ones —
  // otherwise startOwnPortFitting would see a still-alive orphan and skip
  // the spawn, leaving the old bundle serving requests.
  await reconcileOrphanedOwnPortFittings();

  const record = getRecord(compositionId);
  if (record.process) {
    await downUnlocked(compositionId);
  }
  // A failed/hot-reloaded prior up can leave account attribution on the record
  // even though no process is live. Setup/verify output for the next launch must
  // never flag that stale identity.
  clearAccountAttribution(record);
  updateState(compositionId, { status: "starting", devMode: Boolean(options.devMode), lastError: undefined });
  appendLog(compositionId, "runner", `Starting composition ${compositionId}`);
  let launchedChild: ChildProcessWithoutNullStreams | undefined;
  let launchedGateway: GatewayInfo | undefined;
  let launchAttempted = false;
  let launchClaim: FailedLaunchClaimState | undefined;

  try {
    await requireCommand(compositionId, "apm");
    const composition = await readCompositionWithDerivedTasks(compositionId);
    // Claim the composition's working tree for THIS instance before anything
    // destructive touches it. prod/dev/codex share one checkout, so an `up`
    // from a second instance would run apm install + every setup hook inside
    // the tree the first instance's operative is executing from, and would
    // overwrite its materialized .env secrets from a different vault.
    // Same-profile re-entry (restart, redeploy) just refreshes the record.
    launchClaim = {
      ...(await claimCompositionForLaunch(composition.directory, compositionId)),
      compositionDir: composition.directory,
      envMaterialized: false
    };
    // MESH (S10): materialise the composition's SHARED files from the state
    // service before anything reads them — the DB is the source of truth, this
    // tree is one node's copy. Hash-compared writes keep dev()'s watcher calm,
    // and a refreshed manifest breaks the fast-path fingerprint naturally. An
    // ENROLLED node that cannot reach the service fails the launch (no
    // offline fork of shared state); an unenrolled box behaves as ever.
    {
      const sync = await syncCompositionFromState(compositionId, composition.directory);
      if (sync.source === "seeded-to-service") {
        appendLog(compositionId, "runner", "composition seeded to the state service (first contact)");
      } else if (sync.refreshedFiles.length) {
        appendLog(
          compositionId,
          "runner",
          `composition refreshed from the state service: ${sync.refreshedFiles.join(", ")}`
        );
      }
    }
    // A composition-owned committed routing seed becomes local policy only at
    // this mutating launch seam. GET/Muster reads can preview the seed without
    // writing into a shared checkout; the claim above serializes the one-time
    // materialization against other Garrison instances.
    await ensureCompositionRoutingPolicy(composition.directory);
    // Run evidence (WS4 / D6): record which composition started + a content hash
    // of its apm.yml, written EARLY (before the heavy install/verify/spawn steps)
    // so the record lands even if a later step fails. Best-effort - a failed
    // evidence write must never abort a launch.
    try {
      const evidence = await appendRunEvidence({
        compositionDir: composition.directory,
        compositionId: composition.id,
        manifestPath: composition.manifestPath
      });
      appendLog(
        compositionId,
        "runner",
        `run-evidence: recorded ${evidence.compositionId} apm.yml sha256 ${evidence.apmYmlSha256.slice(0, 12)}`
      );
    } catch (err) {
      appendLog(
        compositionId,
        "stderr",
        `run-evidence write skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // `--force` so apm's "critical hidden characters" warnings on third-party
    // node_modules (zod locales etc.) don't abort install. The composition's
    // own fittings are reviewed via the four-check pipeline; the diagnostic
    // surfaces on transitive deps the user can't realistically audit line-by-
    // line. apm continues to PRINT the warnings, which the user can see in
    // the runner log.
    // Fast path (Garrison-improvements card, item 3): when the composition is
    // byte-identical to the last successfully VERIFIED up, the expensive steps
    // (apm install, setup hooks, verify hooks) are provably redundant and are
    // skipped. Any change — manifest, overlay, lockfile, any fitting source
    // file — takes the full path. `Run with full verify` forces it.
    const upFingerprint = await compositionFingerprint(composition.directory);
    const lastUp = options.full || options.devMode ? null : await readLastUp(composition.directory);
    const fastPath = Boolean(lastUp?.ok && lastUp.fingerprint === upFingerprint);
    if (fastPath) {
      appendLog(
        compositionId,
        "runner",
        `fast path: composition unchanged since last verified up (${upFingerprint.slice(0, 12)}) — install/setup/verify skipped`
      );
    } else {
      await runProcess(compositionId, "apm", ["install", "--force"], composition.directory);
    }
    const { envPath, source: envSource } = await materializeEnvViaAuthority(
      composition.directory,
      compositionId
    );
    launchClaim.envMaterialized = true;
    appendLog(
      compositionId,
      "runner",
      `Materialised secrets to ${path.relative(ROOT_DIR, envPath)} (${envSource === "authority" ? "mesh secret authority" : "local vault"})`
    );
    const soulEntries = await selectedLibraryEntries(composition.selections);
    // Project before fitting setup: kanban-loop's setup hook seeds/reconciles the
    // board from this manifest. Writing it afterwards left a live launch one
    // composition behind until the next restart.
    try {
      const kmodel = computeKanbanResolvedModel(composition, soulEntries);
      const plan = kanbanProjectionPlan(kmodel);
      if (plan.write) {
        await writeKanbanResolvedModel(composition, soulEntries);
      } else {
        // The model file is global. Leaving it in place here would route this
        // composition through the previous active composition's exact v4 cells.
        await clearKanbanResolvedModel();
      }
      appendLog(compositionId, "runner", plan.log);
    } catch (err) {
      // Fail closed: a malformed/new composition may use the board's default
      // pipeline, but it must never inherit an earlier composition's routes.
      try {
        await clearKanbanResolvedModel();
      } catch (clearErr) {
        appendLog(
          compositionId,
          "stderr",
          `stale kanban model cleanup failed: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`
        );
      }
      appendLog(compositionId, "stderr", `kanban model projection skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Coordination fittings install STANDING user-scope config (a SessionStart
    // hook, an MCP registration). When one is DESELECTED, strip its owner-tagged
    // config cleanly + completely — reconciled here on `up`, never on `down`
    // (standing config must survive operative stop so a direct `claude` run in
    // any repo keeps coordination). Scoped to known coord owners; best-effort.
    try {
      const selectedIds = Object.values(composition.selections)
        .flatMap((items) => (Array.isArray(items) ? items : []))
        .map((it) => it.id);
      const teardown = reconcileCoordTeardown({ compositionId, selectedFittingIds: selectedIds });
      if (teardown.removed.length > 0) {
        appendLog(compositionId, "runner", `coord teardown: removed user-scope config for ${teardown.removed.join(", ")}`);
      }
      // agent_mail lifecycle: like every own-port fitting it now starts with
      // the operative (startOperativeBoundFittings) and stops at down. When
      // DESELECTED, stop the server here — clean stop on deactivation.
      // Best-effort; never fails the operative.
      if (teardown.removed.includes("coord-agentmail")) {
        await stopOwnPortFitting("coord-agentmail");
        appendLog(compositionId, "runner", "coord: stopped coord-agentmail (deselected)");
      }
    } catch (e) {
      appendLog(compositionId, "runner", `coord teardown reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    let verifyResults: VerifyResult[];
    if (fastPath) {
      verifyResults = (lastUp?.verifyResults as VerifyResult[] | undefined) ?? [];
      updateState(compositionId, { verifyResults });
    } else {
      await runSetupHooks(compositionId);
      verifyResults = await verify(compositionId);
      const failed = verifyResults.find((result) => !result.ok);
      if (failed) {
        throw new Error(`Verify failed for ${failed.fittingId}`);
      }
    }
    const promptPath = await assembleSystemPrompt(compositionId);

    // Resolve the PRIMARY runtime — the Runtime-Faculty fitting that hosts the
    // orchestrator loop. Defaults to claude-code-runtime; its model + provider
    // (ollama/deepseek/zai base-url swap) are threaded into the orchestrator
    // spawn. A non-claude-code engine as primary is not yet hosted as the
    // interactive orchestrator — fail loud rather than silently run claude-code.
    // P3/D4: primary_runtime lives in the POLICY file (routing.json). The
    // legacy composition globalConfig key is honored as a fallback with a
    // deprecation warning; when both are set and differ, the policy wins —
    // loudly, never silently. The DEFAULT id keeps default semantics (a
    // composition without the claude-code fitting still synthesizes the
    // claude-code engine); any OTHER explicit id must be composed or up()
    // fails loud in resolvePrimaryRuntime.
    const policyPrimary = await resolvePrimaryFromPolicy(composition.directory);
    const legacyPrimary = (composition.globalConfig.primary_runtime ?? "").trim() || null;
    if (policyPrimary && legacyPrimary && policyPrimary !== legacyPrimary) {
      appendLog(
        compositionId,
        "stderr",
        `primary_runtime conflict: policy file says "${policyPrimary}", composition global_config says "${legacyPrimary}" — the POLICY FILE wins. Remove global_config.primary_runtime (deprecated since RUNTIMES-V1).`
      );
    } else if (!policyPrimary && legacyPrimary) {
      appendLog(
        compositionId,
        "stderr",
        `global_config.primary_runtime is deprecated — set primaryRuntime from the Muster Fittings tab (policy file) instead. Honoring "${legacyPrimary}" for this launch.`
      );
    }
    const effectivePrimary = policyPrimary ?? legacyPrimary ?? undefined;
    // The DEFAULT id keeps default semantics from EITHER source (policy or
    // legacy key): claude-code is synthesizable without its fitting, so naming
    // the default must never fail a composition that doesn't compose it.
    const runtimeEntries = buildRuntimeEntries(soulEntries, composition.selections);
    const primaryRuntime = resolvePrimaryRuntime({
      primaryRuntimeId: effectivePrimary === DEFAULT_PRIMARY_RUNTIME ? undefined : effectivePrimary,
      runtimeEntries
    });
    // P4 (GARRISON-RUNTIMES-V1): a non-claude primary is HOSTED now — the
    // gateway pool warms the named engine's RuntimeAdapter as the operative
    // session (GARRISON_PRIMARY_ENGINE, set by buildPrimaryRuntimeEnv below).
    // The historical hard throw is gone; the switch is logged loudly so a
    // primary flip never happens silently.
    if (primaryRuntime.engine !== "claude-code") {
      appendLog(
        compositionId,
        "runner",
        `PRIMARY RUNTIME SWITCH: the operative session will be hosted by the "${primaryRuntime.engine}" engine ` +
          `(fitting ${primaryRuntime.runtimeId}) via its RuntimeAdapter — an experiment path (D8): surfaces that ` +
          `assume Claude Code (Quarters deep tier, plans, session transcripts) degrade gracefully.`
      );
    }
    const primaryEntry = soulEntries.find((entry) => entry.id === primaryRuntime.runtimeId);
    const primaryVaultEnv = primaryEntry ? await vaultEnvForEntry(primaryEntry) : {};
    // Providers are policy data (P2): the launch env resolves provider specs
    // from the policy's providers section, never a code constant.
    const providersList = await resolveProvidersList(composition.directory, (message) =>
      appendLog(compositionId, "stderr", message)
    );
    // RUNTIME-ACCOUNTS-V1: the account token is NOT in the fitting's
    // secret_scope (account names are dynamic), so it is delivered explicitly
    // here — audit-recorded like every other vault read — and merged into the
    // lookup that buildPrimaryRuntimeEnv resolves ANTHROPIC_ACCOUNT__* through.
    let primaryAccount = String(primaryRuntime.config.account ?? "").trim();
    const primaryProviderId = String(
      primaryRuntime.config.provider ?? defaultProviderForPrimaryEngine(primaryRuntime.engine)
    ).trim();
    const providerKind = providersList.find((p) => p && p.id === primaryProviderId)?.kind;
    const accountRoute = primaryAccountRoute(
      primaryRuntime.engine,
      primaryProviderId,
      providerKind
    );
    const primaryOnPlan = accountRoute.kind === "anthropic-plan";
    // PAYMASTER D7/D8/D9: `auto` resolves to a concrete account HERE, before
    // the pure env builder - resolver inputs and pick always logged (hard
    // constraint). A hold (no eligible account) fails the up loudly with every
    // account's numbers instead of burning a scorched window; zero registered
    // accounts fall back to the machine login so fresh installs keep working.
    let effectivePrimaryRuntime: typeof primaryRuntime = {
      ...primaryRuntime,
      config: {
        ...primaryRuntime.config,
        ...(primaryProviderId && primaryRuntime.config.provider == null
          ? { provider: primaryProviderId }
          : {})
      }
    };
    if (primaryAccount === "auto" && primaryOnPlan) {
      try {
        const resolution = await resolveAutoAccount();
        if (resolution.mode === "machine-login") {
          appendLog(
            compositionId,
            "runner",
            "Paymaster: account is Auto but no accounts are registered - launching on the machine's own login."
          );
          primaryAccount = "";
        } else {
          appendLog(compositionId, "runner", "Paymaster auto-selection inputs:");
          for (const line of formatDecisionLines(resolution.decision)) {
            appendLog(compositionId, "runner", `  ${line}`);
          }
          appendLog(compositionId, "runner", `Paymaster picked account "${resolution.name}".`);
          primaryAccount = resolution.name;
        }
      } catch (error) {
        if (error instanceof PaymasterHoldError) {
          appendLog(compositionId, "stderr", error.message);
        }
        throw error;
      }
      effectivePrimaryRuntime = {
        ...effectivePrimaryRuntime,
        config: { ...effectivePrimaryRuntime.config, account: primaryAccount }
      };
    }
    // The heartbeat is process-global and idempotent. It keeps the Accounts
    // surface current even when this particular operative is not on Anthropic;
    // refreshUsage itself filters to Anthropic accounts.
    void ensurePaymasterHeartbeat().catch(() => undefined);
    const accountEnv: Record<string, string> = {};
    if (primaryAccount && primaryOnPlan) {
      accountEnv[accountVaultKey(primaryAccount)] = await accountTokenForSpawn(
        primaryAccount,
        primaryRuntime.runtimeId
      );
    }
    // A non-Anthropic PRIMARY account must be resolved BEFORE the provider env:
    // buildPrimaryRuntimeEnv asks for the provider's vault key (GLM_API_KEY for
    // GLM), while named accounts are sealed under ACCOUNT__<PLATFORM>__<name>.
    // Resolve + audit the named token now and present its platform env as the
    // provider's secret lookup. This also makes the primary strict: it can never
    // silently fall back to a literal key or a secondary account after the user
    // explicitly selected a name.
    let namedPrimaryAccount: Awaited<ReturnType<typeof resolvePrimaryRuntimeAccount>> | null = null;
    if (primaryAccount && !primaryOnPlan) {
      if (accountRoute.kind === "strict") {
        namedPrimaryAccount = await resolvePrimaryRuntimeAccount(
          primaryAccount,
          primaryRuntime.runtimeId,
          accountRoute.platform,
          { allowAuthFile: accountRoute.allowAuthFile }
        );
        // buildPrimaryRuntimeEnv's account field is the Anthropic-plan pin. A
        // native/provider account is injected separately below and must never
        // be reinterpreted as ANTHROPIC_ACCOUNT__<name> by its default branch.
        effectivePrimaryRuntime = {
          ...effectivePrimaryRuntime,
          config: { ...effectivePrimaryRuntime.config, account: "" }
        };
      } else if (accountRoute.kind === "ignored") {
        appendLog(
          compositionId,
          "stderr",
          `Runtime account "${primaryAccount}" is configured but ${accountRoute.reason}; account ignored for this launch.`
        );
      } else {
        throw new Error(
          `primary runtime ${primaryRuntime.runtimeId} cannot use account "${primaryAccount}": ${accountRoute.reason}. Clear the account selector or choose a compatible provider.`
        );
      }
    }
    const { env: primaryEnv, providerLaunch: primaryProviderLaunch, account: pinnedAccount } =
      buildPrimaryRuntimeEnv(
        effectivePrimaryRuntime,
        // A selected named account is an exclusive source. Falling through to a
        // generic vault key would silently launch under a different identity.
        (key) => namedPrimaryAccount
          ? namedPrimaryAccount.env[key]
          : primaryVaultEnv[key] ?? accountEnv[key],
        providersList,
        // The primary Fitting's own declaration of HOW a provider override is
        // applied. Without it, an OpenAI-shape engine would have its base URL
        // written to ANTHROPIC_BASE_URL — which it never reads — and its endpoint
        // would stay untrusted, so its key would be silently withheld.
        primaryEntry?.metadata.provider_mechanism
      );
    // Keep attribution local through setup. Only arm the record immediately
    // before the operative/gateway spawn, so an npm/preflight 401 can never be
    // mistaken for a provider rejection under this account.
    const activeAccount = pinnedAccount ?? namedPrimaryAccount?.name;
    const activeAccountPlatform = resolveActiveAccountPlatform(
      pinnedAccount,
      namedPrimaryAccount?.platform
    );
    // RUNTIME-ACCOUNTS-V2: secondary bridges still inherit process.env, so each
    // selected account is resolved against the platform implied by that
    // runtime+provider. Fail on wrong-platform pins, missing credentials, or
    // process-wide key/home collisions; silently flattening them can launch a
    // delegate under the wrong identity.
    const secondaryAccountRequests: RuntimeAccountRequest[] = [];
    for (const entry of runtimeEntries.filter((item) => item.id !== primaryRuntime.runtimeId)) {
      const account = String(entry.config?.account ?? "").trim();
      if (!account) continue;
      const engine =
        entry.provides.find((provision) => provision.kind === "runtime")?.name ?? entry.id;
      const providerId = String(
        entry.config?.provider ?? defaultProviderForPrimaryEngine(engine)
      ).trim();
      const kind = providersList.find((provider) => provider?.id === providerId)?.kind;
      const route = primaryAccountRoute(engine, providerId, kind);
      if (route.kind === "strict") {
        secondaryAccountRequests.push({
          id: entry.id,
          account,
          expectedPlatform: route.platform,
          allowAuthFile: route.allowAuthFile
        });
      } else if (route.kind === "anthropic-plan") {
        // Claude/Agent-SDK target launchers resolve their per-target account in
        // their own isolated spawn env; do not flatten it into the operative.
        continue;
      } else if (route.kind === "ignored") {
        appendLog(
          compositionId,
          "stderr",
          `Runtime account "${account}" on ${entry.id} is not process-injected: ${route.reason}.`
        );
      } else {
        throw new Error(
          `runtime ${entry.id} cannot use account "${account}": ${route.reason}. Clear the account selector or choose a compatible provider.`
        );
      }
    }
    const runtimeAccountEnv = await resolveRuntimeAccountEnv(
      secondaryAccountRequests,
      {
        log: (message) => appendLog(compositionId, "runner", message),
        reservedEnv: { ...(namedPrimaryAccount?.env ?? {}), ...primaryEnv },
        reservedPlatforms:
          accountRoute.kind === "strict"
            ? [{
                platform: accountRoute.platform,
                account: namedPrimaryAccount?.name,
                owner: `primary runtime ${primaryRuntime.runtimeId}`
              }]
            : []
      }
    );
    if (pinnedAccount) {
      appendLog(
        compositionId,
        "runner",
        `Primary runtime ${primaryRuntime.runtimeId} pinned to Anthropic account "${pinnedAccount}"`
      );
    } else if (namedPrimaryAccount) {
      appendLog(
        compositionId,
        "runner",
        `Primary runtime ${primaryRuntime.runtimeId} pinned to ${namedPrimaryAccount.platform} account "${namedPrimaryAccount.name}"`
      );
    }
    if (primaryProviderLaunch) {
      appendLog(
        compositionId,
        "runner",
        `Primary runtime ${primaryRuntime.runtimeId} on provider ${primaryEnv.GARRISON_PROVIDER} (${primaryEnv.ANTHROPIC_BASE_URL})`
      );
    }

    // P8/D7: per-primary orchestrator prompt delivery. claude-code keeps the
    // existing append-system-prompt path (untouched); agent-sdk consumes the
    // prompt through the SDK systemPrompt mechanism at the gateway warm seam;
    // a codex/gemini/cursor primary gets the assembled prompt PROJECTED to its
    // native context-file convention, with the authority warning PRINTED, not
    // hidden. The engine list is PRIMARY_CONTEXT_FILES itself, so registering a
    // new context-file convention there is the only edit an engine needs.
    if (Object.hasOwn(PRIMARY_CONTEXT_FILES, primaryRuntime.engine)) {
      const assembled = await fs.readFile(promptPath, "utf8");
      const projection = await projectPrimaryContext({
        engine: primaryRuntime.engine,
        instructions: assembled,
        targetDir: composition.directory
      });
      if (projection.projected) {
        appendLog(compositionId, "runner", `Projected orchestrator prompt to ${projection.file}`);
      }
      // The warning prints on BOTH paths: the authority caveat when projected,
      // and the PROJECTION REFUSED explanation when a hand-authored context
      // file blocked it — a refused projection must never be silent, because
      // the primary would run WITHOUT the orchestrator prompt.
      if (projection.warning) {
        appendLog(compositionId, "stderr", projection.warning);
      }
    }

    const gateway = await resolveGatewayFitting(compositionId);
    assertPrimaryGatewayCompatibility(primaryRuntime.engine, Boolean(gateway));
    let child: ChildProcessWithoutNullStreams;
    if (gateway) {
      await runProcess(
        compositionId,
        "npm",
        ["install", "--no-audit", "--no-fund", "--silent"],
        gateway.fittingDir
      );

      armAccountAttribution(record, activeAccount, activeAccountPlatform);
      launchAttempted = true;
      launchedGateway = gateway;
      child = await spawnGateway(
        compositionId,
        composition.directory,
        promptPath,
        gateway,
        {
          ...runtimeAccountEnv,
          ...(namedPrimaryAccount?.env ?? {}),
          ...primaryEnv,
          ...(primaryProviderLaunch ? { GARRISON_PROVIDER_LAUNCH: "1" } : {})
        }
      );
      launchedChild = child;
    } else {
      await requireCommand(compositionId, "claude");
      armAccountAttribution(record, activeAccount, activeAccountPlatform);
      launchAttempted = true;
      child = spawnClaude(
        compositionId,
        composition.directory,
        promptPath,
        { ...runtimeAccountEnv, ...(namedPrimaryAccount?.env ?? {}), ...primaryEnv },
        primaryProviderLaunch
      );
      launchedChild = child;
    }

    // Both spawn paths claim the record and install their lifecycle listeners
    // synchronously, before returning. Never turn a dead/replaced child into a
    // running record merely because its spawn function once returned it.
    assertOwnedLiveProcess(record, child, "startup");
    updateState(compositionId, {
      status: "running",
      devMode: Boolean(options.devMode),
      pid: child.pid,
      startedAt: new Date().toISOString(),
      // Record what this launch actually ran under, so a later config edit can be
      // shown as PENDING rather than silently having no effect.
      launchedAccounts: {
        ...(activeAccount ? { [primaryRuntime.runtimeId]: activeAccount } : {}),
        ...Object.fromEntries(
          secondaryAccountRequests
            .filter((request) => request.account)
            .map((request) => [request.id, String(request.account)])
        )
      }
    });
    if (options.devMode) {
      await startDevWatcher(compositionId);
      assertOwnedLiveProcess(record, child, "dev watcher startup", true);
    }
    appendLog(compositionId, "runner", `Operative process started${child.pid ? ` with pid ${child.pid}` : ""}`);
    await startOperativeBoundFittings(compositionId);
    assertOwnedLiveProcess(record, child, "operative-bound fitting startup", true);
    // Record the verified state for the next up's fast-path decision. On the
    // fast path the fingerprint is unchanged by definition, but the timestamp
    // refresh is still useful evidence of the last successful launch.
    await writeLastUp(composition.directory, {
      fingerprint: upFingerprint,
      at: new Date().toISOString(),
      ok: true,
      verifyResults
    });
    return getRunnerState(compositionId);
  } catch (error) {
    // A failure after a child became ready (for example the dev watcher or an
    // operative-bound fitting failing to start) must not leave that child
    // serving while the runner advertises a failed state. Only stop the child
    // this invocation actually launched; a late failure must never kill a
    // successor that has since claimed the record.
    const cleanupErrors: string[] = [];
    const cleanupChild = launchedChild ?? (launchAttempted ? record.process : undefined);
    let childStillOwned = false;
    if (launchAttempted) {
      if (record.restartTimer) {
        clearTimeout(record.restartTimer);
        record.restartTimer = undefined;
      }
      if (record.watcher) {
        const watcher = record.watcher;
        record.watcher = undefined;
        try {
          await watcher.close();
        } catch (watcherError) {
          cleanupErrors.push(
            `dev watcher: ${watcherError instanceof Error ? watcherError.message : String(watcherError)}`
          );
        }
      }
      if (launchedChild || cleanupChild) {
        try {
          await stopOperativeBoundFittings(compositionId, { strict: true });
        } catch (fittingError) {
          cleanupErrors.push(
            `operative-bound fittings: ${fittingError instanceof Error ? fittingError.message : String(fittingError)}`
          );
        }
      }
      if (cleanupChild && record.process === cleanupChild) {
        try {
          await stopChild(cleanupChild);
        } catch (stopError) {
          cleanupErrors.push(
            `operative process ${cleanupChild.pid ?? "unknown"}: ${stopError instanceof Error ? stopError.message : String(stopError)}`
          );
        }
      }
      childStillOwned = Boolean(cleanupChild && record.process === cleanupChild);
      if (!childStillOwned && cleanupChild) {
        if (record.process === cleanupChild) record.process = undefined;
        if (launchedGateway && cleanupChild.pid) {
          try {
            await clearGatewayPidRecordForPid(
              compositionId,
              launchedGateway.port,
              cleanupChild.pid
            );
          } catch (pidCleanupError) {
            cleanupErrors.push(
              `gateway PID record: ${pidCleanupError instanceof Error ? pidCleanupError.message : String(pidCleanupError)}`
            );
          }
        }
        if (record.gateway === launchedGateway) record.gateway = undefined;
      }
    }
    // A pre-spawn account/provider/verify failure occurs after the tree claim and
    // often after `.env` materialization. Clean both only when THIS invocation
    // acquired an otherwise-unowned tree and no launched resource may still be
    // using it. A rejected claim or same-profile re-entry preserves the prior
    // owner's state, and the exact claim token prevents deleting a successor.
    cleanupErrors.push(
      ...(await cleanupFailedLaunchClaim(
        launchClaim,
        childStillOwned || cleanupErrors.length > 0
      ))
    );
    const message = error instanceof Error ? error.message : String(error);
    const finalMessage = cleanupErrors.length > 0
      ? `${message} Cleanup incomplete: ${cleanupErrors.join("; ")}`
      : message;
    if (!childStillOwned) clearAccountAttribution(record);
    updateState(compositionId, {
      status: "failed",
      lastError: finalMessage,
      pid: childStillOwned ? cleanupChild?.pid : undefined
    });
    appendLog(compositionId, "runner", `Failed: ${finalMessage}`);
    throw cleanupErrors.length > 0 ? new Error(finalMessage) : error;
  }
}

export async function down(compositionId: string): Promise<RunnerState> {
  return withRunnerOperation(compositionId, () => downUnlocked(compositionId));
}

async function downUnlocked(compositionId: string): Promise<RunnerState> {
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
  clearAccountAttribution(record);
  // A gateway from a previous server process is not in record.process - the
  // on-disk pid record is the only handle a fresh server has on it. The port
  // comes from the live record when we have one, else from the composition's
  // gateway config - the same resolution spawnGateway would use.
  const gatewayPort = record.gateway?.port ?? (await resolveGatewayFitting(compositionId))?.port;
  if (gatewayPort !== undefined) await reapRecordedGateway(compositionId, gatewayPort);
  record.gateway = undefined;
  const composition = await readCompositionWithDerivedTasks(compositionId);
  await wipeMaterializedEnv(composition.directory);
  // Clear the orchestrator session marker so the next `up` boots fresh. A
  // persisted id whose claude conversation is gone makes the orchestrator-mode
  // gateway hang on `--resume` ("message never registered"), and that boot path
  // has no auto-heal yet. Fresh-on-restart trades cross-restart memory for
  // reliability; within-session multi-turn memory is unaffected.
  await fs.rm(path.join(composition.directory, ".garrison", "orchestrator-session-id"), {
    force: true
  });
  // Hand the working tree back so another instance may take it. Only the
  // owning profile's release does anything, so this can never give away a
  // tree that is still live under a different instance.
  await releaseComposition(composition.directory);
  updateState(compositionId, { status: "stopped", pid: undefined, devMode: false });
  appendLog(compositionId, "runner", "Stopped and wiped materialised .env");
  return getRunnerState(compositionId);
}

// Exported for the fitting-lifecycle vitest gate (sandbox GARRISON_HOME); the
// app itself only reaches this through getRunnerState/up.
export async function reconcileOrphanedOwnPortFittings(): Promise<void> {
  const rt = runtime();
  if (rt.reconciliation) return rt.reconciliation;
  rt.reconciliation = (async () => {
    try {
      const compositions = await listCompositions();
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
          if (!isOwnPortFitting(entry)) continue;
          if (running) {
            protectedIds.add(entry.id);
          } else {
            sweepable.add(entry.id);
          }
        }
      }
      // The spawn records are Garrison's own kill ledger - everything it ever
      // spawned and has not confirmed dead. Sweeping from them (not just the
      // current selections) reaps DESELECTED fittings and clobbered status
      // slots that would otherwise squat their ports forever. A fitting no
      // longer in the library can never be managed again, so its record is
      // sweepable too.
      const libraryById = new Map((await readLibrary()).map((entry) => [entry.id, entry]));
      for (const fittingId of await listSpawnRecordIds()) {
        const entry = libraryById.get(fittingId);
        if (entry && !isOwnPortFitting(entry)) continue;
        sweepable.add(fittingId);
      }
      for (const fittingId of sweepable) {
        if (protectedIds.has(fittingId)) continue;
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

// The URL of THIS garrison app (the Next server the runner lives in). Own-port
// fittings call back into it (automations vision, drill curation, drillJudge)
// and their hardcoded fallbacks are per-instance wrong by construction — the
// main instance runs on 7777, the codex instance on 27777, and a fitting
// spawned without the projection posts its internal-token calls at the OTHER
// instance, which rejects them with 403. The projection keeps every fitting
// talking to ITS OWN instance.
// Port resolution is profile-first: GARRISON_APP_PORT (the launcher's explicit
// value) → PORT (what `next dev -p` sets) → the profile's app port. The old
// `|| 3000` fallback was wrong for every profile — 3000 is an unrelated app on
// this box — and would have handed fittings a callback URL nothing answers.
function garrisonSelfBaseUrl(): string {
  const port =
    process.env.GARRISON_APP_PORT?.trim() ||
    process.env.PORT?.trim() ||
    String(appPort());
  return process.env.GARRISON_SELF_BASE_URL || `http://127.0.0.1:${port}`;
}

// The live gateway base URL of the first RUNNING composition. Internal app
// routes (automations vision, drill curation) post model turns here; their
// old hardcoded 24777 fallback is per-instance wrong by construction (main
// gateway=4777, codex=24777) and silently handed turns to the OTHER
// instance's operative. Env override first (tests pin it), then the live
// runner record; null when nothing is running (callers keep their fallback).
export function activeGatewayBaseUrl(): string | null {
  if (process.env.GARRISON_GATEWAY_URL) return process.env.GARRISON_GATEWAY_URL;
  for (const record of runtime().records.values()) {
    if (record.state.status === "running" && record.gateway?.baseUrl) {
      return record.gateway.baseUrl;
    }
  }
  return null;
}

export async function startOperativeBoundFittings(
  compositionId: string
): Promise<Map<string, Record<string, string>>> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  // The live gateway URL (set after the gateway started above). Injected into every
  // operative-bound own-port fitting so a runner-managed boot can REACH the gateway —
  // e.g. the Kanban board dispatches an agent-list card's run through GARRISON_GATEWAY_URL;
  // without this it logs "Start on agent lists is disabled" and the run loop is dead.
  const gatewayBaseUrl = getRecord(compositionId).gateway?.baseUrl;
  // Selection config per fitting id, projected into the spawn env (see
  // ownPortConfigEnv) so servers read their composition config - e.g. the
  // file-browser's `root` lands as GARRISON_FILEBROWSER_ROOT instead of the
  // apm.yml value being decorative, and local-voice's
  // whisper_lang/whisper_model/kokoro_voice reach the process instead of it
  // silently running on server.mjs defaults.
  const configById = new Map<string, Record<string, unknown>>();
  for (const items of Object.values(composition.selections)) {
    for (const item of items ?? []) {
      // Ports shift into THIS profile's range before projection, so the single
      // committed port map serves prod (+1000), dev (0) and codex (+20000)
      // without three drifting copies of apm.yml.
      configById.set(
        item.id,
        applyPortOffsetToConfig((item.config ?? {}) as Record<string, unknown>)
      );
    }
  }
  // Returned for tests and callers that need the exact per-fitting env this
  // up() projected (a different env elsewhere would drift the fingerprint and
  // double-drive a fitting through a needless heal-restart).
  const envByFitting = new Map<string, Record<string, string>>();
  for (const entry of entries) {
    if (!isOwnPortFitting(entry)) continue;
    // Project the ACTIVE composition id into every operative-bound own-port fitting so a
    // runner-managed boot (the normal path) carries it — the Dev Env reads
    // GARRISON_COMPOSITION_ID and forwards it to /api/orchestrator/place, so placement
    // resolves THIS composition's live modes/routing rather than always "default".
    const extraEnv = {
      ...(await vaultEnvForEntry(entry)),
      ...ownPortConfigEnv(entry.id, configById.get(entry.id) ?? {}),
      GARRISON_COMPOSITION_ID: compositionId,
      // Project the composition's absolute dir too (the same value spawnGateway
      // hands the gateway as GARRISON_COMPOSITION_DIR): the orchestrator own-port
      // server keys routing.json off it. Without it that server falls back to
      // ~/.garrison/orchestrator/routing.json while the gateway/runner read the
      // composition's .garrison/routing.json — a config split-brain.
      GARRISON_COMPOSITION_DIR: composition.directory,
      GARRISON_BASE_URL: garrisonSelfBaseUrl(),
      // The same shell-app base URL under the name the board's list-management
      // proxy reads (kanban-loop POST /lists -> ${GARRISON_APP_URL}/api/muster/
      // duty). GARRISON_BASE_URL predates it; both are this instance's app.
      GARRISON_APP_URL: garrisonSelfBaseUrl(),
      // Mesh state service credentials — part of the env fingerprint, so a
      // token rotation heals running fittings on the next up().
      ...stateEnvForProjection(),
      ...(gatewayBaseUrl ? { GARRISON_GATEWAY_URL: gatewayBaseUrl } : {})
    };
    envByFitting.set(entry.id, extraEnv);
    // Every own-port fitting boots with the operative and stops with it at
    // down() — fittings share the operative's lifecycle, always.
    const result = await startOwnPortFitting(entry, extraEnv, { healOnEnvDrift: true });
    if (!result.ok) {
      appendLog(compositionId, "stderr", `own-port ${entry.id}: ${result.error}`);
      continue;
    }
    if (result.healed) {
      const reason = result.healReason === "env-drift"
        ? "to pick up a changed env value (gateway URL / composition id / config)"
        : "to deliver vault secrets";
      appendLog(compositionId, "runner", `own-port ${entry.id} restarted ${reason}${result.pid ? ` (pid ${result.pid})` : ""}`);
    } else if (result.alreadyRunning) {
      appendLog(compositionId, "runner", `own-port ${entry.id} already running; left in place`);
    } else {
      appendLog(compositionId, "runner", `own-port ${entry.id} started${result.pid ? ` (pid ${result.pid})` : ""}`);
    }
  }
  return envByFitting;
}

// The runner-projected env for ONE fitting of a RUNNING composition — exactly
// what startOperativeBoundFittings would hand it at up (vault secrets,
// selection config, GARRISON_COMPOSITION_ID, live GARRISON_GATEWAY_URL). The
// manual start/restart routes use this so a recovery start still reaches the
// live gateway instead of booting gatewayless. Returns null when no running
// composition selects the fitting (callers fall back to plain vault env).
export async function operativeEnvForFitting(fittingId: string): Promise<Record<string, string> | null> {
  for (const [compositionId, record] of runtime().records) {
    if (record.state.status !== "running") continue;
    const composition = await readCompositionWithDerivedTasks(compositionId);
    const entries = await selectedLibraryEntries(composition.selections);
    const entry = entries.find((e) => e.id === fittingId);
    if (!entry || !isOwnPortFitting(entry)) continue;
    let config: Record<string, unknown> = {};
    for (const items of Object.values(composition.selections)) {
      const item = (items ?? []).find((i) => i.id === fittingId);
      if (item) {
        // Same profile shift as the up() path — a manual start must bind the
        // same port up() would have, or the fingerprint drifts and the
        // fitting heal-restarts on every up.
        config = applyPortOffsetToConfig((item.config ?? {}) as Record<string, unknown>);
      }
    }
    const gatewayBaseUrl = record.gateway?.baseUrl;
    return {
      ...(await vaultEnvForEntry(entry)),
      ...ownPortConfigEnv(entry.id, config),
      GARRISON_COMPOSITION_ID: compositionId,
      // Same composition-dir projection as the up() path (see
      // startOperativeBoundFittings) so an on-demand Views start keys its
      // routing.json off the composition, not ~/.garrison/orchestrator.
      GARRISON_COMPOSITION_DIR: composition.directory,
      GARRISON_BASE_URL: garrisonSelfBaseUrl(),
      // Same alias as the up() path (see startOperativeBoundFittings) so a
      // manual Views start/restart projects the identical env fingerprint.
      GARRISON_APP_URL: garrisonSelfBaseUrl(),
      ...stateEnvForProjection(),
      ...(gatewayBaseUrl ? { GARRISON_GATEWAY_URL: gatewayBaseUrl } : {})
    };
  }
  return null;
}

// Exported for the fitting-lifecycle vitest gate; the app reaches this through
// down(). Every own-port fitting stops with the operative — fittings share the
// operative's lifecycle, always.
export async function stopOperativeBoundFittings(
  compositionId: string,
  options: { strict?: boolean } = {}
): Promise<void> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  const failures: string[] = [];
  for (const entry of entries) {
    if (!isOwnPortFitting(entry)) continue;
    const result = await stopOwnPortFitting(entry.id);
    if (!result.ok) {
      appendLog(compositionId, "stderr", `own-port ${entry.id} stop: ${result.error}`);
      failures.push(`${entry.id}: ${result.error ?? "termination was not confirmed"}`);
      continue;
    }
    if (result.wasRunning) {
      appendLog(compositionId, "runner", `own-port ${entry.id} stopped (pid ${result.pid})`);
    }
  }
  if (options.strict && failures.length > 0) {
    throw new Error(`own-port cleanup incomplete (${failures.join("; ")})`);
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

// ownPortConfigEnv now lives in own-port-lifecycle.ts (next to vaultEnvForEntry
// and the spawn logic); re-exported here so existing importers (and tests) that
// reach for it via @/lib/runner keep resolving.
export { ownPortConfigEnv } from "./own-port-lifecycle";
// The instance identity every setup/verify hook needs and none of them can
// derive. The launcher exports GARRISON_HOME and friends but NOT the gateway
// address, so a hook reaching for GARRISON_GATEWAY_PORT found nothing and fell
// back to a baked literal — and every baked literal in this repo named the
// CODEX gateway (24777), so on dev and prod alike the hook silently talked to
// (or waited on) the wrong instance. Same failure class as the kanban tick's
// old `http://127.0.0.1:4777` fallback. Resolved from the composition's own
// gateway config with the profile shift applied, i.e. exactly the address
// spawnGateway will bind, and available before the gateway is up because it is
// only a config read.
async function gatewayHookEnv(compositionId: string): Promise<Record<string, string>> {
  // This instance's own app URL travels with it. A setup hook that writes
  // standing config naming a Garrison endpoint (drill's Results MCP
  // registration) must bake the REGISTERING instance's app, and it cannot
  // derive the port without re-hardcoding the port map a fitting must never
  // hold. Same value own-port fittings already receive at runtime.
  const base: Record<string, string> = { GARRISON_APP_URL: garrisonSelfBaseUrl() };
  try {
    const gateway = await resolveGatewayFitting(compositionId);
    if (!gateway) return base;
    return {
      ...base,
      GARRISON_GATEWAY_HOST: gateway.host,
      GARRISON_GATEWAY_PORT: String(gateway.port),
      GARRISON_GATEWAY_URL: gateway.baseUrl
    };
  } catch {
    return base;
  }
}

export async function runFittingSetup(
  entry: { id: string; metadata: GarrisonMetadata; localPath?: string },
  compositionDir: string,
  config: Record<string, unknown> = {},
  hookEnv: Record<string, string> = {}
): Promise<SetupResult> {
  const steps = entry.metadata.setup;
  if (!steps || steps.length === 0) {
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }
  // Setup must run where the RUNTIME lives. startOwnPortFitting spawns the
  // fitting from its seed dir (ROOT_DIR + entry.localPath), so a setup that
  // builds into the apm_modules copy produces artifacts nothing ever serves —
  // observed 2026-07-21: a HUD change deployed, up() rebuilt
  // apm_modules/_local/jarvis-os/dist, and prod kept serving the seed dist
  // from five days earlier. The installed copy remains the fallback for
  // fittings without a local seed (registry installs).
  const fittingDir = entry.localPath
    ? path.resolve(ROOT_DIR, entry.localPath)
    : path.join(compositionDir, "apm_modules", "_local", entry.id);
  // The fitting's own config wins over the shared hook env, so a composition
  // that explicitly pins a value stays authoritative.
  const env = { ...hookEnv, ...setupConfigEnv(entry.id, config) };
  // Run each step in order; abort on the first non-zero exit (aggregating
  // output so the caller logs the full trail up to the failure).
  let aggStdout = "";
  let aggStderr = "";
  for (const step of steps) {
    const result = await runShellCommand(
      fittingDir,
      step.command,
      step.timeout_ms ?? SETUP_DEFAULT_TIMEOUT_MS,
      env
    );
    if (result.stdout) aggStdout += (aggStdout ? "\n" : "") + result.stdout;
    if (result.stderr) aggStderr += (aggStderr ? "\n" : "") + result.stderr;
    if (result.exitCode !== 0) {
      return { ...result, stdout: aggStdout, stderr: aggStderr, ok: false };
    }
  }
  return { ok: true, stdout: aggStdout, stderr: aggStderr, exitCode: 0 };
}

async function runSetupHooks(compositionId: string): Promise<void> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  // Flatten the selection map → id-keyed config so each setup hook receives its
  // own composition config projected as env vars (see setupConfigEnv).
  const hookEnv = await gatewayHookEnv(compositionId);
  const configById = new Map<string, Record<string, unknown>>();
  for (const items of Object.values(composition.selections)) {
    for (const item of items ?? []) {
      // Ports shift into THIS profile's range before projection, so the single
      // committed port map serves prod (+1000), dev (0) and codex (+20000)
      // without three drifting copies of apm.yml.
      configById.set(
        item.id,
        applyPortOffsetToConfig((item.config ?? {}) as Record<string, unknown>)
      );
    }
  }
  for (const entry of entries) {
    const steps = entry.metadata.setup;
    if (!steps || steps.length === 0) {
      continue;
    }
    appendLog(
      compositionId,
      "runner",
      `setup ${entry.id}: ${steps.map((s) => s.label ?? s.command).join(" && ")}`
    );
    const result = await runFittingSetup(
      entry,
      composition.directory,
      configById.get(entry.id) ?? {},
      hookEnv
    );
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
    const { envPath } = await materializeEnvViaAuthority(composition.directory, composition.id);
    appendLog(
      compositionId,
      "runner",
      `Materialised secrets to ${path.relative(ROOT_DIR, envPath)} (verify will source them)`
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
  // Verify hooks that probe the gateway need its address for THIS instance; see
  // gatewayHookEnv. Without it a hook's own literal fallback picks an instance
  // at random and the probe passes or fails for the wrong reason.
  const verifyHookEnv = await gatewayHookEnv(compositionId);

  // Project each fitting's composition config as env vars, exactly as
  // runSetupHooks does. Without this a verify hook only ever sees its
  // config_schema DEFAULTS, so a fitting configured away from them fails its
  // own verify: projects-index with projects_root ~/dev still probed
  // ~/Projects and reported "projects_root not found", blocking dogfood-orch.
  const verifyConfigById = new Map<string, Record<string, unknown>>();
  for (const items of Object.values(composition.selections)) {
    for (const item of items ?? []) {
      verifyConfigById.set(
        item.id,
        applyPortOffsetToConfig((item.config ?? {}) as Record<string, unknown>)
      );
    }
  }

  for (const entry of entries) {
    const started = Date.now();
    const verifyInfo = entry.metadata.verify;
    appendLog(compositionId, "runner", `verify ${entry.id}: ${verifyInfo.command}`);
    const result = await runShellCommand(
      composition.directory,
      verifyInfo.command,
      verifyInfo.timeout_ms,
      verifyHookEnv
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

export async function assembleSystemPrompt(compositionId: string): Promise<string> {
  const { path: promptPath } = await writeAssembledOrchestratorPrompt(compositionId);
  appendLog(compositionId, "runner", `Assembled layered Orchestrator prompt at ${path.relative(ROOT_DIR, promptPath)}`);
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
const ROUTING_CORE_PATH = path.join(ROOT_DIR, "fittings/seed/orchestrator/lib/routing-core.mjs");

export const MISSING_ROUTING_CONFIG_WARNING =
  "WARNING: orchestrator prompt has a {{routing}} placeholder but the routing section could not be built (see the routing diagnostics above) - the routing section will be empty";

// Providers are policy data (GARRISON-RUNTIMES-V1 P2): resolve the policy's
// providers section for the primary-runtime launch env. Reads the same
// scoped-or-seed routing.json as resolveRoutingSection and runs it through
// routing-core's ensureProviders, so a pre-migration file yields the
// migration-seeded historical entries (identical to the old constant's
// behavior) — with a diagnostic, never silently.
export async function resolveProvidersList(
  compositionDir: string,
  onDiagnostic?: (message: string) => void
): Promise<Array<{ id: string; kind?: string; baseUrl?: string | null; vaultKey?: string; dummyToken?: string }>> {
  let source: Awaited<ReturnType<typeof readRoutingPolicySource>>;
  try {
    source = await readRoutingPolicySource(compositionDir);
  } catch (error) {
    const message = `providers: routing policy is unreadable (${error instanceof Error ? error.message : String(error)})`;
    onDiagnostic?.(message);
    throw new Error(message);
  }
  let config: unknown;
  try {
    config = JSON.parse(source.text) as unknown;
  } catch (error) {
    const message = `providers: routing policy ${source.path} is invalid JSON (${error instanceof Error ? error.message : String(error)})`;
    onDiagnostic?.(message);
    throw new Error(message);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    const message = `providers: routing policy ${source.path} must be a JSON object`;
    onDiagnostic?.(message);
    throw new Error(message);
  }
  const mod = (await import(/* webpackIgnore: true */ pathToFileURL(ROUTING_CORE_PATH).href)) as {
    ensureProviders: (c: unknown) => { providers: Array<{ id: string }> };
    validateProviders: (providers: unknown) => string[];
  };
  const declaredProviders = (config as { providers?: unknown }).providers;
  const errors = mod.validateProviders(declaredProviders);
  if (errors.length > 0) {
    const message = `providers: routing policy ${source.path} is invalid (${errors.join("; ")})`;
    onDiagnostic?.(message);
    throw new Error(message);
  }
  return mod.ensureProviders(config).providers as Awaited<ReturnType<typeof resolveProvidersList>>;
}

// The duty model for the routing compile, best-effort: a malformed duty graph
// must degrade to the un-repointed routing.json (a diagnostic-worthy but
// launchable state), never abort prompt assembly.
function safeKanbanModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties"> & Partial<Pick<CompositionV4, "targets">>,
  entries: Pick<LibraryEntry, "id" | "metadata">[]
): KanbanResolvedModel | null {
  try {
    return computeKanbanResolvedModel(composition, entries);
  } catch {
    return null;
  }
}

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
// null (and the caller warns) when no valid config is found or the compiler
// cannot load; each null path reports a DISTINCT diagnostic through
// onDiagnostic so a missing/invalid routing.json is never conflated with a
// compiler-load failure (the webpack empty-lazy-context incident).
export async function resolveRoutingSection(
  compositionDir: string,
  runtimeEntries: RuntimeEntry[] = [],
  onDiagnostic?: (message: string) => void,
  // The composition's resolved duty model (computeKanbanResolvedModel). When
  // present, its per-duty per-level cells REPOINT the router matrix rows at
  // the duty ladders (applyDutyCells) before validation/compile — so the
  // Muster page's duties are the routing truth for both the compiled
  // policy.json and the {{routing}} prompt section.
  dutyModel?: KanbanResolvedModel | null
): Promise<string | null> {
  let raw: string;
  let configPath: string;
  try {
    const source = await readRoutingPolicySource(compositionDir);
    raw = source.text;
    configPath = source.path;
  } catch (error) {
    onDiagnostic?.(
      `routing.json missing or unreadable for ${compositionDir}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    onDiagnostic?.(
      `routing.json invalid: ${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
    return null;
  }
  // Auto-surface composed runtime fittings as model-router targets (S3): a
  // fitted runtime becomes a selectable target without hand-editing routing.json.
  // De-duped by id, so a hand-seeded target always wins; no-op when no runtimes
  // are composed (preserves the seed/default behavior exactly).
  config = mergeRuntimeTargets(
    config as { targets?: RouterTarget[] },
    deriveRuntimeTargets(runtimeEntries)
  );
  try {
    // webpackIgnore keeps the specifier out of EVERY webpack compilation -
    // without it Next compiles this fully-dynamic import into an empty lazy
    // context module that rejects every request, so the routing section was
    // silently empty under the Next server (same fix as src/instrumentation.ts).
    const mod = (await import(/* webpackIgnore: true */ pathToFileURL(ROUTING_CORE_PATH).href)) as {
      compileRouting: (c: unknown, p?: string | null) => string;
      validateRoutingConfig: (c: unknown) => string[];
      compilePolicy: (c: unknown, p?: string | null) => unknown;
      stableStringify: (v: unknown) => string;
      applyDutyCells: (c: unknown, m: unknown) => unknown;
    };
    // Duties repoint (before validation, so a bad merge fails loudly here and
    // never ships a policy that contradicts the composition).
    if (dutyModel && typeof mod.applyDutyCells === "function") {
      config = mod.applyDutyCells(config, dutyModel);
    }
    const errors = mod.validateRoutingConfig(config);
    if (errors.length) {
      onDiagnostic?.(
        `routing.json invalid: ${configPath} failed validation: ${errors.join("; ")}`
      );
      return null;
    }
    const activeProfile = (config as { activeProfile?: string }).activeProfile ?? null;
    // D4: composition start recompiles the machine-readable policy — the one
    // consumption interface for the run engine + phase skills (no HTTP).
    try {
      const policyFile =
        process.env.GARRISON_POLICY_PATH ?? path.join(garrisonDir(), "orchestrator", "policy.json");
      await writeFileAtomic(policyFile, mod.stableStringify(mod.compilePolicy(config, activeProfile)));
    } catch (err) {
      console.warn("[runner] policy.json compile at assembly failed:", err);
    }
    return mod.compileRouting(config, activeProfile);
  } catch (err) {
    // NOT a config problem: the compiler module itself failed to load or
    // threw. Swallowing this is how the empty-{{routing}} incident hid.
    onDiagnostic?.(
      `routing compiler failed to load or run (${ROUTING_CORE_PATH}): ${err instanceof Error ? err.message : String(err)}`
    );
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
    // Derived view providers: a fitting with no declared provides but with a
    // ui.views[]/own_port surface AND a for_consumers block (e.g. the
    // file-browser's artifact-surface guidance) must still reach the
    // Operative's prompt - the resolver derives its `view` capability, so the
    // assembly derives the matching provider line. One line per fitting, not
    // per view, so multi-view fittings don't duplicate their guidance.
    if (
      entry.metadata.provides.length === 0 &&
      forConsumers &&
      deriveViewProvisions(entry.id, entry.metadata).length > 0
    ) {
      providerEntries.push({
        kind: "view",
        name: entry.id,
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

/**
 * Reduce the composition's selected Runtime-Faculty fittings to the shape the
 * primary-runtime resolver needs (id + provided capabilities + per-fitting
 * config). Order follows the composition's selection order.
 */
function buildRuntimeEntries(
  entries: LibraryEntry[],
  selections: FittingSelectionMap
): RuntimeEntry[] {
  const runtimeSelections = selections.runtimes ?? [];
  return runtimeSelections.map((selection) => {
    const entry = entries.find((candidate) => candidate.id === selection.id);
    return {
      id: selection.id,
      provides: entry?.metadata.provides ?? [],
      config: selection.config ?? {}
    };
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

    // Never pick an MCP sidecar as the PRIMARY gateway: a fitting providing
    // the mcp-gateway capability (or the mcp-gateway fitting itself) serves
    // MCP tools, not the /chat//jobs//channels HTTP surface the channels and
    // heartbeat dispatch depend on. Matching on the provides list / id keeps
    // the pick order-independent when both gateways are selected, whether or
    // not the mcp-gateway kind is in the capabilityKinds enum.
    const isMcpSidecar =
      entry.id === "mcp-gateway" ||
      entry.metadata.provides.some((provision) => String(provision.kind) === "mcp-gateway");
    if (isMcpSidecar) continue;

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
    // Profile-shifted, exactly like every own-port fitting: the composition
    // declares the base gateway port (4777) and prod/codex run it +1000/+20000.
    // The old `?? 24777` fallback hardcoded the CODEX gateway, so a composition
    // without an explicit port handed prod's operative to codex's gateway.
    const port = profilePort(Number(config.port ?? BASE_GATEWAY_PORT));

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

// Project the gateway fitting's compact-controller config (S1b) into its spawn
// env: the three scalar globals plus an optional per-runtime override map carried
// in the same config object under `compaction` (serialized as JSON). Only set keys
// present in config, so the gateway's own env-side defaults apply when unset.
function compactEnv(config: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.compact_enabled !== undefined && config.compact_enabled !== null) {
    env.GARRISON_COMPACT_ENABLED = String(config.compact_enabled);
  }
  if (config.compact_threshold_pct !== undefined && config.compact_threshold_pct !== null) {
    env.GARRISON_COMPACT_THRESHOLD_PCT = String(config.compact_threshold_pct);
  }
  if (typeof config.compact_focus_template === "string" && config.compact_focus_template.trim()) {
    env.GARRISON_COMPACT_FOCUS_TEMPLATE = config.compact_focus_template;
  }
  if (config.compaction && typeof config.compaction === "object") {
    try {
      env.GARRISON_COMPACT_CONFIG = JSON.stringify(config.compaction);
    } catch {
      /* a non-serialisable override map is dropped rather than aborting spawn */
    }
  }
  return env;
}

// ── gateway pid records ─────────────────────────────────────────────────────
// The in-memory RunnerRecord dies with the Garrison server process, but the
// gateway child does not: it keeps serving the OLD composition config on the
// port, and the next up()'s gateway crashes with EADDRINUSE while the /health
// poll below answers "ready" from the squatter - an up that silently rides a
// stale gateway. The on-disk record is what lets a later down()/up(), possibly
// in a fresh server process, reap it.

export interface GatewayPidRecord {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  fittingId: string;
}

// Records are keyed by composition AND port: two Garrison checkouts sharing
// one ~/.garrison (e.g. a clone under test on shifted ports) run the same
// composition id, and a composition-only key made each instance's spawn
// pre-flight reap the OTHER's live gateway (observed live 2026-07-17).
function gatewayPidRecordPath(compositionId: string, port: number): string {
  return path.join(garrisonDir(), "gateway-pids", `${compositionId}-${port}.json`);
}

// Pre-port-keyed record location; still read (and reaped, port-matched) so a
// gateway recorded by an older server generation is not orphaned.
function legacyGatewayPidRecordPath(compositionId: string): string {
  return path.join(garrisonDir(), "gateway-pids", `${compositionId}.json`);
}

function gatewayPidLockPath(compositionId: string, port: number): string {
  return path.join(garrisonDir(), "gateway-pids", `${compositionId}-${port}.lock.d`);
}

interface GatewayPidLockTicket {
  pid: number;
  processStartId?: string | null;
  token: string;
  choosing: boolean;
  ticket: number;
  createdAt: number;
  released?: boolean;
}

const GATEWAY_PID_LOCK_TIMEOUT_MS = 5000;
const GATEWAY_PID_INVALID_TICKET_STALE_MS = 60_000;

async function processStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const [stat, bootId] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ]);
    // comm (field 2) is parenthesized and may itself contain spaces. Fields
    // after its final ')' start at state (field 3); starttime is field 22.
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) return null;
    const startTicks = stat.slice(commEnd + 1).trim().split(/\s+/)[19];
    return startTicks ? `${bootId.trim()}:${startTicks}` : null;
  } catch {
    return null;
  }
}

function validGatewayPidLockTicket(value: unknown): value is GatewayPidLockTicket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<GatewayPidLockTicket>;
  return (
    Number.isInteger(candidate.pid) &&
    Number(candidate.pid) > 0 &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    (candidate.processStartId === undefined ||
      candidate.processStartId === null ||
      typeof candidate.processStartId === "string") &&
    typeof candidate.choosing === "boolean" &&
    (candidate.released === undefined || typeof candidate.released === "boolean") &&
    Number.isInteger(candidate.ticket) &&
    Number(candidate.ticket) >= 0 &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt)
  );
}

async function readGatewayPidLockTickets(
  lockDir: string
): Promise<Array<{ id: string; file: string; ticket: GatewayPidLockTicket }>> {
  const now = Date.now();
  let names: string[];
  try {
    names = await fs.readdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const tickets: Array<{ id: string; file: string; ticket: GatewayPidLockTicket }> = [];
  for (const id of names) {
    if (!id.endsWith(".json")) continue;
    const file = path.join(lockDir, id);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // Final ticket names are only published by atomic rename, so a malformed
      // file is foreign or left by an older implementation. A fresh one blocks
      // acquisition; an old one is safe to retire without touching any other
      // contender's unique path.
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs >= GATEWAY_PID_INVALID_TICKET_STALE_MS) {
          await fs.unlink(file).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      tickets.push({
        id,
        file,
        ticket: { pid: process.pid, token: id, choosing: true, ticket: 0, createdAt: now }
      });
      continue;
    }
    if (!validGatewayPidLockTicket(raw)) {
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs >= GATEWAY_PID_INVALID_TICKET_STALE_MS) {
        await fs.unlink(file).catch(() => undefined);
        continue;
      }
      tickets.push({
        id,
        file,
        ticket: { pid: process.pid, token: id, choosing: true, ticket: 0, createdAt: now }
      });
      continue;
    }
    if (raw.released) {
      // Release is published atomically before best-effort deletion. An unlink
      // failure therefore leaves an inert, independently-cleanable ticket, not
      // a live-PID tombstone that wedges every later operation.
      await fs.unlink(file).catch(() => undefined);
      continue;
    }
    const ownerAlive = pidAlive(raw.pid);
    const currentStartId = ownerAlive && raw.processStartId
      ? await processStartIdentity(raw.pid)
      : null;
    if (
      !ownerAlive ||
      (raw.processStartId !== undefined &&
        raw.processStartId !== null &&
        currentStartId !== null &&
        currentStartId !== raw.processStartId)
    ) {
      // Ticket paths include an unguessable process token and are never reused.
      // Removing this exact dead/reused-owner participant cannot delete a
      // successor's lock. A live ticket is NEVER expired by wall-clock age: a
      // suspended owner may resume inside its critical section.
      await fs.unlink(file).catch(() => undefined);
      continue;
    }
    tickets.push({ id, file, ticket: raw });
  }
  return tickets;
}

async function withGatewayPidLock<T>(
  compositionId: string,
  port: number,
  operation: () => Promise<T>
): Promise<T> {
  const lockDir = gatewayPidLockPath(compositionId, port);
  await fs.mkdir(lockDir, { recursive: true });
  const token = randomBytes(12).toString("hex");
  const id = `${process.pid}-${token}.json`;
  const file = path.join(lockDir, id);
  const createdAt = Date.now();
  let ownTicket: GatewayPidLockTicket = {
    pid: process.pid,
    processStartId: await processStartIdentity(process.pid),
    token,
    choosing: true,
    ticket: 0,
    createdAt
  };
  // Each participant owns a unique, atomically-published ticket. There is no
  // shared lock inode to unlink, so a pair of stale-lock reclaimers cannot
  // accidentally remove a newly-acquired successor lock.
  await writeFileAtomic(file, JSON.stringify(ownTicket), { mode: 0o600 });
  let result!: T;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    const initial = await readGatewayPidLockTickets(lockDir);
    ownTicket = {
      ...ownTicket,
      choosing: false,
      ticket: initial.reduce((max, contender) => Math.max(max, contender.ticket.ticket), 0) + 1
    };
    await writeFileAtomic(file, JSON.stringify(ownTicket), { mode: 0o600 });

    const deadline = Date.now() + GATEWAY_PID_LOCK_TIMEOUT_MS;
    while (true) {
      const contenders = await readGatewayPidLockTickets(lockDir);
      const blocked = contenders.some((contender) => {
        if (contender.id === id) return false;
        if (contender.ticket.choosing) return true;
        if (contender.ticket.ticket !== ownTicket.ticket) {
          return contender.ticket.ticket < ownTicket.ticket;
        }
        return contender.id.localeCompare(id) < 0;
      });
      if (!blocked) break;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for gateway PID lock ${path.basename(lockDir)}`);
      }
      await delay(50);
    }
    result = await operation();
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  let releaseError: unknown;
  try {
    await writeFileAtomic(
      file,
      JSON.stringify({ ...ownTicket, choosing: false, ticket: 0, released: true }),
      { mode: 0o600 }
    );
    // Once the released state is durable, deletion is only housekeeping.
    await fs.unlink(file).catch(() => undefined);
  } catch (error) {
    // If release publication itself failed, deleting this unique ticket is the
    // only safe fallback. Retry transient failures before surfacing the fault.
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt += 1) {
      try {
        await fs.unlink(file);
        removed = true;
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") {
          removed = true;
          break;
        }
        if (attempt < 2) await delay(25 * (attempt + 1));
      }
    }
    if (!removed) releaseError = error;
  }

  if (releaseError) {
    const cleanupMessage = releaseError instanceof Error ? releaseError.message : String(releaseError);
    if (operationFailed) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      throw new Error(`${primaryMessage} Gateway PID lock cleanup incomplete: ${cleanupMessage}`);
    }
    throw new Error(`Gateway PID lock cleanup incomplete: ${cleanupMessage}`);
  }
  if (operationFailed) throw primaryError;
  return result;
}

export async function writeGatewayPidRecord(
  compositionId: string,
  record: GatewayPidRecord
): Promise<void> {
  await withGatewayPidLock(compositionId, record.port, async () => {
    const file = gatewayPidRecordPath(compositionId, record.port);
    // Publish only into an empty slot. If another Garrison server races this
    // startup, the loser must fail and stop rather than overwrite the live
    // winner's reap handle. A fully-written temp inode is hard-linked into place:
    // link(2) is atomic and refuses an existing destination.
    const tmp = `${file}.publish-${process.pid}-${randomBytes(6).toString("hex")}`;
    const publishHandle = await fs.open(tmp, "wx", 0o600);
    let closed = false;
    try {
      await publishHandle.writeFile(JSON.stringify(record), "utf8");
      await publishHandle.sync();
      await publishHandle.close();
      closed = true;
      await fs.link(tmp, file);
    } finally {
      if (!closed) await publishHandle.close().catch(() => undefined);
      await fs.unlink(tmp).catch(() => undefined);
    }
  });
}

// Exit-handler variant: only clear the record if it still names THIS child.
// An old child's late exit event must never delete the record a successor
// gateway just wrote.
async function clearGatewayPidRecordForPid(
  compositionId: string,
  port: number,
  pid: number
): Promise<void> {
  await withGatewayPidLock(compositionId, port, async () => {
    const file = gatewayPidRecordPath(compositionId, port);
    try {
      const record = JSON.parse(await fs.readFile(file, "utf8")) as GatewayPidRecord;
      if (record.pid !== pid) return;
    } catch {
      return;
    }
    await fs.unlink(file).catch(() => undefined);
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill the gateway a previous server process left behind. Only recorded pids
// are ever signalled; a record from before the machine's last boot can only
// name a recycled pid, so it is cleared without signalling. Scoped to ONE
// port: a record for a different port belongs to another Garrison instance
// sharing this ~/.garrison and is never touched.
// Exported for the gateway-reap vitest gate (sandbox GARRISON_HOME); the app
// itself only reaches this through down()/spawnGateway.
export async function reapRecordedGateway(compositionId: string, port: number): Promise<void> {
  await withGatewayPidLock(compositionId, port, async () => {
    const candidates = [gatewayPidRecordPath(compositionId, port), legacyGatewayPidRecordPath(compositionId)];
    const bootTime = Date.now() - os.uptime() * 1000;
    for (const file of candidates) {
      let record: GatewayPidRecord;
      try {
        record = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        continue;
      }
      // A legacy (composition-only) record naming a different port is another
      // instance's live gateway - leave both the process and the file alone.
      if (record.port !== port) continue;
      if (record.pid && Date.parse(record.startedAt) > bootTime && pidAlive(record.pid)) {
        appendLog(
          compositionId,
          "runner",
          `Reaping stale gateway pid ${record.pid} on ${record.host}:${record.port} (left by a previous server process)`
        );
        try {
          process.kill(record.pid, "SIGTERM");
        } catch {
          /* raced its exit */
        }
        const deadline = Date.now() + 2000;
        while (pidAlive(record.pid) && Date.now() < deadline) await delay(100);
        if (pidAlive(record.pid)) {
          try {
            process.kill(record.pid, "SIGKILL");
          } catch {
            /* raced its exit */
          }
          const killDeadline = Date.now() + 2000;
          while (pidAlive(record.pid) && Date.now() < killDeadline) await delay(100);
          if (pidAlive(record.pid)) {
            throw new Error(
              `Recorded gateway pid ${record.pid} did not confirm exit; preserving ${file} for a later cleanup attempt.`
            );
          }
        }
      }
      await fs.unlink(file).catch(() => undefined);
    }
  });
}

// Bind-probe: the truthful "is this port free" check - it attempts exactly
// what the gateway child is about to do.
function portOccupied(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.listen(port, host, () => probe.close(() => resolve(false)));
  });
}

async function spawnGateway(
  compositionId: string,
  cwd: string,
  promptPath: string,
  gateway: GatewayInfo,
  extraEnv?: Record<string, string>
): Promise<ChildProcessWithoutNullStreams> {
  // Reap a recorded stale gateway, then require the port to actually be free
  // before spawning. Without this, the /health poll below can answer "ready"
  // from whatever already holds the port while our own child dies of
  // EADDRINUSE - and the up() proceeds against a gateway running a previous
  // composition config.
  await reapRecordedGateway(compositionId, gateway.port);
  if (await portOccupied(gateway.host, gateway.port)) {
    throw new Error(
      `${gateway.baseUrl} is already in use by a process Garrison did not record; ` +
        `refusing to start a second gateway. Free the port or change the gateway port config.`
    );
  }

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
    ...compactEnv(gateway.config),
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

  // Claim ownership and attach every lifecycle listener before the first
  // await. A child can fail immediately (ENOENT, EADDRINUSE, syntax error);
  // delaying this until after the PID write/readiness poll used to miss that
  // event and could mark a dead process as running.
  const record = getRecord(compositionId);
  record.process = child;
  record.gateway = gateway;
  let startupReady = false;
  let startupFailure: Error | undefined;
  const failStartup = (error: Error): void => {
    if (!startupReady && !startupFailure) startupFailure = error;
  };

  const stdoutBuffer: LogLineBuffer = { pending: "" };
  const stderrBuffer: LogLineBuffer = { pending: "" };
  child.stdout.on("data", (chunk) => {
    for (const line of splitBufferedLogChunk(stdoutBuffer, chunk.toString())) {
      appendLog(compositionId, "stdout", line);
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of splitBufferedLogChunk(stderrBuffer, chunk.toString())) {
      appendLog(compositionId, "stderr", line);
    }
  });
  child.stdout.on("end", () => {
    for (const line of splitBufferedLogChunk(stdoutBuffer, "", true)) {
      appendLog(compositionId, "stdout", line);
    }
  });
  child.stderr.on("end", () => {
    for (const line of splitBufferedLogChunk(stderrBuffer, "", true)) {
      appendLog(compositionId, "stderr", line);
    }
  });
  child.on("exit", (code, signal) => {
    failStartup(
      new Error(
        `Gateway exited before becoming ready (code=${code ?? "null"}, signal=${signal ?? "null"})`
      )
    );
    const current = getRecord(compositionId);
    const ownsRecord = current.process === child;
    if (ownsRecord) {
      clearAccountAttribution(current);
      current.process = undefined;
    }
    if (child.pid) {
      void clearGatewayPidRecordForPid(compositionId, gateway.port, child.pid).catch((error) => {
        appendLog(
          compositionId,
          "runner",
          `Gateway PID record cleanup deferred: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    appendLog(
      compositionId,
      "runner",
      `Gateway process exited code=${code ?? "null"} signal=${signal ?? "null"}`
    );
    if (ownsRecord && current.state.status === "running") {
      updateState(compositionId, {
        status: code === 0 ? "stopped" : "failed",
        pid: undefined
      });
    } else if (ownsRecord) {
      // A prior stop attempt may have timed out and left the record failed but
      // intentionally retained. When the child eventually exits, retire the
      // now-stale PID without rewriting that failure state.
      updateState(compositionId, { pid: undefined });
    }
  });
  child.on("error", (error) => {
    failStartup(error);
    const current = getRecord(compositionId);
    const ownsRecord = current.process === child;
    if (ownsRecord) clearAccountAttribution(current);
    appendLog(compositionId, "stderr", error.message);
    if (ownsRecord) {
      updateState(compositionId, { status: "failed", lastError: error.message });
    }
  });

  // Durable before the startup poll: if the SERVER dies while the gateway is
  // coming up, the record is what lets the next server process reap it.
  try {
    if (!child.pid) {
      throw new Error("Gateway spawn returned without a process id");
    }
    await writeGatewayPidRecord(compositionId, {
      pid: child.pid,
      host: gateway.host,
      port: gateway.port,
      startedAt: new Date().toISOString(),
      fittingId: gateway.fittingId
    });

    const assertStillStarting = (): void => {
      if (startupFailure) throw startupFailure;
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        child.killed ||
        getRecord(compositionId).process !== child
      ) {
        throw new Error("Gateway exited or lost runner ownership before becoming ready");
      }
    };

    assertStillStarting();
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      assertStillStarting();
      try {
        const response = await fetch(`${gateway.baseUrl}/health`, {
          signal: AbortSignal.timeout(1000)
        });
        assertStillStarting();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch (error) {
        if (startupFailure) throw startupFailure;
        // A fetch timeout/refusal means "not ready yet". Lifecycle failures
        // are retained separately and always win on the next assertion.
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          child.killed ||
          getRecord(compositionId).process !== child
        ) {
          throw error;
        }
      }
      await delay(250);
    }

    assertStillStarting();
    if (!ready) {
      throw new Error(`Gateway did not become ready within 10s on ${gateway.baseUrl}`);
    }

    startupReady = true;
    appendLog(compositionId, "runner", `Gateway ready on ${gateway.baseUrl}`);
    return child;
  } catch (error) {
    // Readiness failure owns its cleanup. This closes the orphan window on
    // PID-write failures and timeouts, and exact-PID clearing cannot erase a
    // successor's record.
    const primaryError = startupFailure ?? (
      error instanceof Error ? error : new Error(String(error))
    );
    try {
      await stopChild(child);
    } catch (stopError) {
      // Preserve the in-memory handle and durable PID record when termination
      // is not confirmed. A later down/reconciliation can retry; deleting the
      // only handles would turn an uninterruptible child into an orphan.
      const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
      throw new Error(`${primaryError.message} Cleanup incomplete: ${stopMessage}`);
    }
    let pidCleanupError: unknown;
    if (child.pid) {
      try {
        await clearGatewayPidRecordForPid(compositionId, gateway.port, child.pid);
      } catch (cleanupError) {
        pidCleanupError = cleanupError;
      }
    }
    const current = getRecord(compositionId);
    if (current.process === child) {
      clearAccountAttribution(current);
      current.process = undefined;
    }
    if (current.gateway === gateway) current.gateway = undefined;
    if (pidCleanupError) {
      throw new Error(
        `${primaryError.message} PID record cleanup deferred: ${pidCleanupError instanceof Error ? pidCleanupError.message : String(pidCleanupError)}`
      );
    }
    throw primaryError;
  }
}

function spawnClaude(
  compositionId: string,
  cwd: string,
  promptPath: string,
  primaryEnv: Record<string, string> = {},
  providerLaunch = false
): ChildProcessWithoutNullStreams {
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
        GARRISON_PERMISSION_MODE: "bypassPermissions",
        ...primaryEnv,
        ...(providerLaunch ? { GARRISON_PROVIDER_LAUNCH: "1" } : {})
      }
    },
    { spawnSite: "runner:spawnClaude", description: `fallback claude (${compositionName})` }
  );

  // Claim before returning so an immediate error/exit can never be missed by
  // up() and subsequently overwritten with a false running state.
  const record = getRecord(compositionId);
  record.process = child;
  record.gateway = undefined;

  child.stdout.on("data", (chunk) => appendLog(compositionId, "stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(compositionId, "stderr", chunk.toString()));
  child.on("exit", (code, signal) => {
    const record = getRecord(compositionId);
    const ownsRecord = record.process === child;
    if (ownsRecord) {
      clearAccountAttribution(record);
      record.process = undefined;
    }
    appendLog(
      compositionId,
      "runner",
      `Claude process exited code=${code ?? "null"} signal=${signal ?? "null"}`
    );
    if (ownsRecord && record.state.status === "running") {
      updateState(compositionId, {
        status: code === 0 ? "stopped" : "failed",
        pid: undefined
      });
    } else if (ownsRecord) {
      updateState(compositionId, { pid: undefined });
    }
  });
  child.on("error", (error) => {
    const record = getRecord(compositionId);
    const ownsRecord = record.process === child;
    if (ownsRecord) clearAccountAttribution(record);
    appendLog(compositionId, "stderr", error.message);
    if (ownsRecord) {
      updateState(compositionId, { status: "failed", lastError: error.message });
    }
  });

  if (!child.pid) {
    if (record.process === child) record.process = undefined;
    throw new Error("Claude fallback spawn returned without a process id");
  }

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

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  options: { forceAfterMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const forceAfterMs = options.forceAfterMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 5000;
  await new Promise<void>((resolve, reject) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;
    const removeListeners = (): void => {
      child.off("exit", finish);
      child.off("close", finish);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      removeListeners();
      resolve();
    };
    forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded confirmation timer below remains authoritative.
      }
    }, forceAfterMs);
    giveUpTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      removeListeners();
      reject(
        new Error(
          `process ${child.pid} did not confirm exit after SIGTERM/SIGKILL within ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
    child.once("exit", finish);
    child.once("close", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      // Keep the SIGKILL fallback armed. A failed first signal is not evidence
      // that the process is gone, and clearing the runner handle here could
      // turn it into an orphan.
    }
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

// RUNTIME-ACCOUNTS-V1 D5: an auth failure surfacing in a session's log stream
// while the operative is pinned to a named account flags that account
// needs-relogin (once per up; setup tokens are replaced, never refreshed).
const ANTHROPIC_AUTH_FAILURE_RE =
  /Failed to authenticate|\b401\b[^\n]*(?:bearer|oauth|authenticat|unauthori[sz]ed|invalid[_ -]?(?:token|credential))/i;
const PROVIDER_AUTH_FAILURE_RE =
  /\b401\b[^\n]*(?:unauthori[sz]ed|invalid[_ -]?(?:api[_ -]?key|token|credential)|incorrect[^\n]*api[_ -]?key|authenticat|bearer|oauth)/i;

// PAYMASTER D10: a usage-limit hit in the log stream while pinned to an
// account. The regex is only a TRIGGER - ordinary session output can mention
// these phrases (the operative works on this very repo), so the hit is
// confirmed with a live probe of the pinned account before alarming. The
// session stays sticky (no mid-run migration - that waits for Handoff
// Packets); the surfacing pre-computes "resume on <best account now>".
const ANTHROPIC_LIMIT_RE =
  /usage limit reached|rate.?limit.?(error|reached|exceeded)|"type"\s*:\s*"rate_limit_error"/i;
const PROVIDER_LIMIT_RE =
  /\b429\b|"(?:type|code)"\s*:\s*"(?:rate_limit_error|rate_limit_exceeded)"/i;

export type AccountFailureKind = "auth" | "limit";

/**
 * Extract only a trusted failure payload. Gateway chat input/output is JSON on
 * stdout and can quote arbitrary user/assistant prose. For non-Anthropic
 * accounts, only the gateway's structured chat-stream-failed stderr event is
 * attributable to the active provider; setup/npm/sidecar stderr is not. Raw
 * stderr/stdout remains only for the legacy direct Anthropic CLI path.
 */
export function accountFailureText(
  stream: LogEvent["stream"],
  line: string,
  platform: AccountPlatform | undefined
): string | null {
  if (stream !== "stdout" && stream !== "stderr") return null;
  try {
    const parsed = JSON.parse(line) as {
      component?: unknown;
      stream?: unknown;
      kind?: unknown;
      error?: unknown;
    };
    if (
      parsed.component === "http-gateway-pty" &&
      parsed.stream === "stderr"
    ) {
      return stream === "stderr" &&
        parsed.kind === "chat-stream-failed" &&
        typeof parsed.error === "string"
        ? parsed.error
        : null;
    }
  } catch {
    // Raw CLI/log output continues through the stream checks below.
  }
  if (platform !== "anthropic") return null;
  return line;
}

export function classifyAccountFailure(
  stream: LogEvent["stream"],
  line: string,
  platform: AccountPlatform | undefined
): AccountFailureKind | null {
  const text = accountFailureText(stream, line, platform);
  if (!text) return null;
  if (platform === "anthropic") {
    if (ANTHROPIC_AUTH_FAILURE_RE.test(text)) return "auth";
    if (ANTHROPIC_LIMIT_RE.test(text)) return "limit";
    return null;
  }
  if (PROVIDER_AUTH_FAILURE_RE.test(text)) return "auth";
  if (PROVIDER_LIMIT_RE.test(text)) return "limit";
  return null;
}

export function accountAuthFailureMessage(
  account: string,
  platform: AccountPlatform | undefined
): string {
  if (platform === "anthropic") {
    return `Auth failure observed under account "${account}" — flagged needs-relogin (re-run setup-token from the runtime config).`;
  }
  const label = platform ? PLATFORM_SPECS[platform].label : "Provider";
  return `${label} account "${account}" rejected its credential — flagged needs-relogin. Replace or reconnect it in Accounts, then restart the operative.`;
}

export type MidRunLimitHandling =
  | { kind: "anthropic-paymaster" }
  | { kind: "provider"; message: string };

/** The env builder's account is Anthropic; a strictly resolved account keeps its registry platform. */
export function resolveActiveAccountPlatform(
  anthropicAccount: string | undefined,
  namedAccountPlatform: AccountPlatform | undefined
): AccountPlatform | undefined {
  return anthropicAccount ? "anthropic" : namedAccountPlatform;
}

/**
 * Decide which usage-limit rail owns a named primary account. Missing platform
 * metadata fails closed onto a generic provider message: only an explicit
 * `anthropic` value may invoke the Paymaster or recommend its Auto mode.
 */
export function midRunLimitHandling(
  account: string,
  platform: AccountPlatform | undefined
): MidRunLimitHandling {
  if (platform === "anthropic") return { kind: "anthropic-paymaster" };

  const providerLabel = platform ? PLATFORM_SPECS[platform].label : null;
  const accountLabel = providerLabel ? `${providerLabel} account` : "Account";
  const resetLabel = providerLabel ?? "provider";
  const alternative = platform
    ? `another ${platform} account`
    : "another account for that provider";
  return {
    kind: "provider",
    message:
      `${accountLabel} "${account}" hit a rate limit mid-run (session stays pinned). ` +
      `Retry after the ${resetLabel} limit resets or restart with ${alternative}.`
  };
}

function surfaceMidRunLimit(
  compositionId: string,
  account: string,
  platform: AccountPlatform | undefined
): void {
  const handling = midRunLimitHandling(account, platform);
  if (handling.kind === "provider") {
    appendLog(compositionId, "runner", handling.message);
    return;
  }

  void (async () => {
    const accounts = await listAccounts();
    const pinned = accounts.filter((candidate) => candidate.name === account);
    const usage = await refreshUsage({ ttlMs: 0, force: true, accounts: pinned });
    const active = usage[account];
    // Fresh successful probe -> judge by the unified status/utilization; an
    // unreadable probe (network/401) leaves the trigger trusted.
    const freshProbe =
      active && !active.error && Date.now() - Date.parse(active.probedAt) < 60_000;
    const limited = freshProbe
      ? active.status !== "allowed" ||
        active.fiveHour.status !== "allowed" ||
        active.weekly.status !== "allowed" ||
        active.fiveHour.pct >= 100 ||
        active.weekly.pct >= 100
      : true;
    const record = getRecord(compositionId);
    if (!limited) {
      // False positive (log line merely mentioned a limit phrase): re-arm the
      // detector after a cooldown so a real hit later still surfaces.
      record.limitFlagged = false;
      record.limitCooldownUntil = Date.now() + 5 * 60_000;
      return;
    }
    const cache = await readUsageCache();
    const decision = resolvePaymaster(
      candidatesFrom(accounts.filter((candidate) => candidate.name !== account), cache)
    );
    appendLog(
      compositionId,
      "runner",
      decision.pick
        ? `Account "${account}" hit its usage limit mid-run (session stays pinned, D10). ` +
            `Resume on "${decision.pick}" - restart the operative with account Auto or pin it there.`
        : `Account "${account}" hit its usage limit mid-run and no other account is eligible right now` +
            (decision.nearestResetAt ? ` - nearest reset ${decision.nearestResetAt}.` : ".")
    );
  })().catch(() => undefined);
}

function appendLog(compositionId: string, stream: LogEvent["stream"], message: string): void {
  const record = getRecord(compositionId);
  for (const line of message.split(/\r?\n/).filter((value) => value.length > 0)) {
    const accountFailure =
      record.activeAccount &&
      (record.state.status === "starting" || record.state.status === "running")
      ? classifyAccountFailure(stream, line, record.activeAccountPlatform)
      : null;
    if (
      record.activeAccount &&
      !record.authFailureFlagged &&
      accountFailure === "auth"
    ) {
      record.authFailureFlagged = true;
      const account = record.activeAccount;
      const platform = record.activeAccountPlatform;
      void setAccountNeedsRelogin(account, true, platform ?? "anthropic")
        .then(() =>
          appendLog(
            compositionId,
            "runner",
            accountAuthFailureMessage(account, platform)
          )
        )
        .catch(() => undefined);
    }
    if (
      record.activeAccount &&
      !record.limitFlagged &&
      (record.limitCooldownUntil ?? 0) <= Date.now() &&
      accountFailure === "limit"
    ) {
      record.limitFlagged = true;
      surfaceMidRunLimit(
        compositionId,
        record.activeAccount,
        record.activeAccountPlatform
      );
    }
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
