import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { commandExists } from "./preflight";
import { readCompositionWithDerivedTasks, selectedLibraryEntries } from "./compositions";
import { materializeEnv, wipeMaterializedEnv } from "./vault";
import { ROOT_DIR } from "./paths";
import type { LibraryEntry, RunnerState, VerifyResult } from "./types";

interface LogEvent {
  ts: string;
  stream: "runner" | "stdout" | "stderr" | "input";
  message: string;
}

interface RunnerRecord {
  state: RunnerState;
  logs: LogEvent[];
  logBytes: number;
  subscribers: Set<(event: LogEvent) => void>;
  process?: ChildProcessWithoutNullStreams;
  watcher?: FSWatcher;
  restartTimer?: NodeJS.Timeout;
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
    await requireCommand(compositionId, "claude");
    const composition = await readCompositionWithDerivedTasks(compositionId);
    await runProcess(compositionId, "apm", ["install"], composition.directory);
    const envPath = await materializeEnv(composition.directory);
    appendLog(compositionId, "runner", `Materialised vault secrets to ${path.relative(ROOT_DIR, envPath)}`);
    const verifyResults = await verify(compositionId);
    const failed = verifyResults.find((result) => !result.ok);
    if (failed) {
      throw new Error(`Verify failed for ${failed.componentId}`);
    }
    const promptPath = await assembleSystemPrompt(compositionId);
    const child = spawnClaude(compositionId, composition.directory, promptPath);
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
  const composition = await readCompositionWithDerivedTasks(compositionId);
  await wipeMaterializedEnv(composition.directory);
  updateState(compositionId, { status: "stopped", pid: undefined, devMode: false });
  appendLog(compositionId, "runner", "Stopped and wiped materialised .env");
  return getRunnerState(compositionId);
}

export async function verify(compositionId: string): Promise<VerifyResult[]> {
  updateState(compositionId, { status: "verifying" });
  appendLog(compositionId, "runner", "Running component verify hooks");
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  const results: VerifyResult[] = [];

  for (const entry of entries) {
    const started = Date.now();
    const verifyInfo = entry.metadata.verify;
    appendLog(compositionId, "runner", `verify ${entry.id}: ${verifyInfo.command}`);
    const result = await runVerifyCommand(
      composition.directory,
      verifyInfo.command,
      verifyInfo.timeout_ms
    );
    const stdout = result.stdout.trim();
    const ok = result.exitCode === 0 && stdout.includes(verifyInfo.expect);
    results.push({
      componentId: entry.id,
      primitive: entry.primitive,
      command: verifyInfo.command,
      expect: verifyInfo.expect,
      ok,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      error: result.error
    });
    appendLog(compositionId, ok ? "runner" : "stderr", `${entry.id} verify ${ok ? "passed" : "failed"}`);
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

export async function sendTestMessage(compositionId: string, message: string): Promise<RunnerState> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Test message is required");
  }
  const record = getRecord(compositionId);
  if (!record.process || record.state.status !== "running") {
    throw new Error("Operative is not running");
  }
  if (!record.process.stdin.writable) {
    throw new Error("Operative stdin is not writable");
  }
  appendLog(compositionId, "input", `test message: ${trimmed}`);
  record.process.stdin.write(`${trimmed}\n`);
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
    appendLog(compositionId, "runner", "Dev mode has no local-path components to watch");
    return;
  }
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    ignored: ["**/.git/**", "**/node_modules/**"]
  });
  watcher.on("all", (_event, changedPath) => {
    appendLog(compositionId, "runner", `Detected local component change: ${path.relative(ROOT_DIR, changedPath)}`);
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
    }
    record.restartTimer = setTimeout(() => {
      appendLog(compositionId, "runner", "Re-applying local component changes");
      up(compositionId, { devMode: true }).catch((error) => {
        appendLog(compositionId, "stderr", error instanceof Error ? error.message : String(error));
      });
    }, 750);
  });
  record.watcher = watcher;
  appendLog(compositionId, "runner", `Dev mode watching ${watchPaths.length} local component path(s)`);
}

async function assembleSystemPrompt(compositionId: string): Promise<string> {
  const composition = await readCompositionWithDerivedTasks(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  const orchestrator = await readPromptForPrimitive(entries, "orchestrator");
  const soul = await readPromptForPrimitive(entries, "soul");
  const fallbackOrchestrator = await fs.readFile(
    path.join(composition.directory, ".garrison", "prompts", "orchestrator.md"),
    "utf8"
  );
  const fallbackSoul = await fs.readFile(
    path.join(composition.directory, ".garrison", "prompts", "soul.md"),
    "utf8"
  );
  const prompt = [
    orchestrator ?? fallbackOrchestrator,
    "",
    soul ?? fallbackSoul
  ].join("\n");
  const promptPath = path.join(composition.directory, ".garrison", "assembled-system-prompt.md");
  await fs.writeFile(promptPath, prompt, "utf8");
  appendLog(compositionId, "runner", `Assembled orchestrator+soul prompt at ${path.relative(ROOT_DIR, promptPath)}`);
  return promptPath;
}

async function readPromptForPrimitive(
  entries: LibraryEntry[],
  primitive: "orchestrator" | "soul"
): Promise<string | undefined> {
  const entry = entries.find((candidate) => candidate.primitive === primitive);
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

function spawnClaude(compositionId: string, cwd: string, promptPath: string): ChildProcessWithoutNullStreams {
  const compositionName = `garrison-${compositionId}`;
  const args = [
    "--append-system-prompt-file",
    promptPath,
    "--permission-mode",
    "auto",
    "--name",
    compositionName,
    "Agent Garrison operative is online. Wait for heartbeat, gateway, and channel dispatches before doing work."
  ];
  appendLog(compositionId, "runner", `claude ${args.slice(0, 5).join(" ")} ...`);
  const child = spawn("claude", args, {
    cwd,
    env: { ...process.env, AGENT_GARRISON_COMPOSITION: compositionId }
  });
  child.stdout.on("data", (chunk) => appendLog(compositionId, "stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(compositionId, "stderr", chunk.toString()));
  child.on("exit", (code, signal) => {
    const record = getRecord(compositionId);
    record.process = undefined;
    appendLog(compositionId, "runner", `Claude process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (record.state.status === "running") {
      updateState(compositionId, { status: code === 0 ? "stopped" : "failed", pid: undefined });
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

async function runVerifyCommand(
  cwd: string,
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
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
    child.on("exit", (code) => {
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
