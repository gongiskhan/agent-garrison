import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { commandExists } from "./preflight";
import { readCompositionWithDerivedTasks, selectedLibraryEntries } from "./compositions";
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
  const record = getRecord(compositionId);
  if (record.process) {
    await down(compositionId);
  }
  updateState(compositionId, { status: "starting", devMode: Boolean(options.devMode), lastError: undefined });
  appendLog(compositionId, "runner", `Starting composition ${compositionId}`);

  try {
    await requireCommand(compositionId, "apm");
    const composition = await readCompositionWithDerivedTasks(compositionId);
    await runProcess(compositionId, "apm", ["install"], composition.directory);
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
      child = await spawnGateway(compositionId, composition.directory, promptPath, gateway);
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

export interface SetupResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export async function runFittingSetup(
  entry: { id: string; metadata: GarrisonMetadata },
  compositionDir: string
): Promise<SetupResult> {
  const setup = entry.metadata.setup;
  if (!setup) {
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }
  const fittingDir = path.join(compositionDir, "apm_modules", "_local", entry.id);
  const result = await runShellCommand(
    fittingDir,
    setup.command,
    setup.timeout_ms ?? SETUP_DEFAULT_TIMEOUT_MS
  );
  return { ...result, ok: result.exitCode === 0 };
}

async function runSetupHooks(compositionId: string): Promise<void> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  for (const entry of entries) {
    const setup = entry.metadata.setup;
    if (!setup) {
      continue;
    }
    appendLog(compositionId, "runner", `setup ${entry.id}: ${setup.command}`);
    const result = await runFittingSetup(entry, composition.directory);
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

export async function verify(compositionId: string): Promise<VerifyResult[]> {
  updateState(compositionId, { status: "verifying" });
  appendLog(compositionId, "runner", "Running fitting verify hooks");
  const composition = await readCompositionWithDerivedTasks(compositionId);

  // Materialize the vault if unlocked, so verify hooks that read API keys
  // can see them. If the vault is locked, log a clear actionable message
  // rather than silently letting hooks fail with cryptic errors.
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

  const entries = await selectedLibraryEntries(composition.selections);
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

export async function sendTestMessage(compositionId: string, message: string): Promise<RunnerState> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Test message is required");
  }
  const record = getRecord(compositionId);
  if (!record.process || record.state.status !== "running") {
    throw new Error("Operative is not running");
  }
  appendLog(compositionId, "input", `test message: ${trimmed}`);

  if (record.gateway) {
    try {
      const response = await fetch(`${record.gateway.baseUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gateway /chat returned ${response.status}: ${text}`);
      }
      const data = (await response.json()) as { reply?: string };
      const reply = data.reply ?? "";
      if (reply) {
        appendLog(compositionId, "stdout", `assistant: ${reply}`);
      } else {
        appendLog(compositionId, "stdout", "(empty assistant reply)");
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      appendLog(compositionId, "stderr", `chat failed: ${messageText}`);
      throw error;
    }
    return getRunnerState(compositionId);
  }

  if (!record.process.stdin.writable) {
    throw new Error("Operative stdin is not writable");
  }
  const turn = {
    type: "user",
    message: { role: "user", content: trimmed }
  };
  record.process.stdin.write(JSON.stringify(turn) + "\n");
  return getRunnerState(compositionId);
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
  const soul = await readPromptForFaculty(entries, "soul");
  const fallbackOrchestrator = await fs.readFile(
    path.join(composition.directory, ".garrison", "prompts", "orchestrator.md"),
    "utf8"
  );
  const fallbackSoul = await fs.readFile(
    path.join(composition.directory, ".garrison", "prompts", "soul.md"),
    "utf8"
  );
  const orchestrator = substituteCapabilitiesPlaceholder(
    orchestratorRaw ?? fallbackOrchestrator,
    entries
  );
  // Soul (identity) first, Orchestrator (behavior) second. Identity at the
  // top of the append makes the override land before the long behavior
  // section buries it; otherwise Claude Code's preset ("You are Claude")
  // wins on identity questions.
  const prompt = [soul ?? fallbackSoul, "", orchestrator].join("\n");
  const promptPath = path.join(composition.directory, ".garrison", "assembled-system-prompt.md");
  await fs.writeFile(promptPath, prompt, "utf8");
  appendLog(compositionId, "runner", `Assembled soul+orchestrator prompt at ${path.relative(ROOT_DIR, promptPath)}`);
  return promptPath;
}

export function substituteCapabilitiesPlaceholder(
  prompt: string,
  entries: LibraryEntry[]
): string {
  return prompt.replace(/{{capabilities}}/g, renderCapabilitiesBlock(entries));
}

export function renderCapabilitiesBlock(entries: LibraryEntry[]): string {
  const inputs = entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }));
  const result = resolveCapabilities(inputs);
  const providerEntries: Array<{ kind: string; name: string; summary: string }> = [];
  for (const entry of entries) {
    for (const provision of entry.metadata.provides) {
      providerEntries.push({
        kind: provision.kind,
        name: provision.name,
        summary: entry.metadata.summary?.trim() || entry.summary || entry.id
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
  return providerEntries
    .map((entry) => `- ${entry.kind}:${entry.name} — ${entry.summary}`)
    .join("\n");
}

async function readPromptForFaculty(
  entries: LibraryEntry[],
  faculty: "orchestrator" | "soul"
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

async function resolveGatewayFitting(
  compositionId: string
): Promise<GatewayInfo | null> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const gatewaySelections = composition.selections.gateway ?? [];
  if (gatewaySelections.length === 0) {
    return null;
  }
  const selection = gatewaySelections[0];
  const entries = await selectedLibraryEntries(composition.selections);
  const entry = entries.find((candidate) => candidate.id === selection.id);
  if (!entry) {
    return null;
  }

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
    return null;
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

async function spawnGateway(
  compositionId: string,
  cwd: string,
  promptPath: string,
  gateway: GatewayInfo
): Promise<ChildProcessWithoutNullStreams> {
  appendLog(
    compositionId,
    "runner",
    `Starting gateway fitting ${gateway.fittingId} on ${gateway.baseUrl}`
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
    GARRISON_MODEL: (gateway.config.model as string | undefined) ?? "opus"
  };

  const child = spawn("node", [gateway.scriptPath], { cwd, env });

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
  const args = [
    "--append-system-prompt-file", promptPath,
    "--permission-mode", "bypassPermissions",
    "--name", compositionName,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--print",
    "--verbose"
  ];
  appendLog(
    compositionId,
    "runner",
    `Fallback: claude ${args.join(" ")} (no gateway fitting selected)`
  );
  const child = spawn("claude", args, {
    cwd,
    env: { ...process.env, AGENT_GARRISON_COMPOSITION: compositionId }
  });

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let nl: number;
    while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      handleClaudeStreamEvent(compositionId, line);
    }
  });
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

  const initial = {
    type: "user",
    message: {
      role: "user",
      content: "You are now online as an Agent Garrison operative. Acknowledge briefly."
    }
  };
  child.stdin.write(JSON.stringify(initial) + "\n");

  return child;
}

function handleClaudeStreamEvent(compositionId: string, line: string): void {
  let event: { type?: string; subtype?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> } };
  try {
    event = JSON.parse(line);
  } catch {
    appendLog(compositionId, "stdout", line);
    return;
  }
  if (event.type === "assistant" && event.message?.content) {
    const blocks = Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        appendLog(compositionId, "stdout", `assistant: ${block.text}`);
      } else if (block.type === "tool_use" && block.name) {
        appendLog(compositionId, "stdout", `tool_use: ${block.name}`);
      }
    }
  } else if (event.type === "system") {
    appendLog(compositionId, "runner", `claude system: ${event.subtype ?? "event"}`);
  } else if (event.type === "result") {
    appendLog(compositionId, "runner", `claude turn result: ${event.subtype ?? ""}`);
  }
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
    const child = spawn(command, args, { cwd, env: process.env });
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  // Note: listens on `close` rather than `exit` so stdio is fully drained
  // before resolving — `exit` can fire while data buffers still hold output.
  // Also merges any .env in cwd into the subprocess env so verify/setup hooks
  // see vault-resolved credentials without each Fitting needing to source it.
  return new Promise((resolve) => {
    const dotenvVars = loadDotenvFromCwd(cwd);
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...dotenvVars },
      shell: true
    });
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
