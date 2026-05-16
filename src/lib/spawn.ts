import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  type SpawnOptions
} from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  writeFileSync,
  type WriteStream
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REDACT_PATTERN = /(_TOKEN$|_KEY$|_SECRET$|_PASSWORD$|^TOKEN$|^SECRET$|^PASSWORD$|^KEY$)/i;
const REDACTED = "***REDACTED***";

export interface SpawnTrackedMeta {
  spawnSite: string;
  description?: string;
}

export interface SpawnTrackedResult {
  child: ChildProcessWithoutNullStreams;
  logsDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  closeLogs: () => void;
}

export interface MetaJson {
  pid: number;
  command: string;
  args: string[];
  shell: boolean;
  cwd: string;
  parentPid: number;
  spawnedAt: string;
  env: Record<string, string>;
  spawnSite: string;
  description?: string;
}

export function garrisonLogsRoot(): string {
  return path.join(os.homedir(), ".garrison", "logs");
}

export function logsDirForPid(pid: number): string {
  return path.join(garrisonLogsRoot(), String(pid));
}

function redactEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = REDACT_PATTERN.test(key) ? REDACTED : value;
  }
  return out;
}

function isOptionsObject(value: unknown): value is SpawnOptions {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface SpawnArgs {
  command: string;
  args: string[];
  options: SpawnOptions & { shell?: boolean | string };
  shellInvocation: boolean;
}

function normaliseArgs(
  command: string,
  argsOrOptions: string[] | (SpawnOptions & { shell?: boolean | string }) | undefined,
  options: (SpawnOptions & { shell?: boolean | string }) | undefined
): SpawnArgs {
  if (Array.isArray(argsOrOptions)) {
    const opts: SpawnOptions & { shell?: boolean | string } = options ?? {};
    return {
      command,
      args: argsOrOptions,
      options: opts,
      shellInvocation: Boolean(opts.shell)
    };
  }
  if (isOptionsObject(argsOrOptions)) {
    return {
      command,
      args: [],
      options: argsOrOptions,
      shellInvocation: Boolean(argsOrOptions.shell)
    };
  }
  return {
    command,
    args: [],
    options: {},
    shellInvocation: false
  };
}

/**
 * Spawn a child process and tee stdout/stderr to ~/.garrison/logs/<pid>/.
 *
 * Two call shapes match node:child_process.spawn:
 *   spawnTracked(cmd, args, options, meta)
 *   spawnTracked(cmd, options, meta)
 *
 * The second form is for shell invocations (`{ shell: true }`).
 *
 * The returned child has its stdout/stderr streams attached normally —
 * callers can still `.on('data')` listen, write to stdin, etc. The tee
 * is additive.
 */
export function spawnTracked(
  command: string,
  args: string[],
  options: SpawnOptions & { shell?: boolean | string },
  meta: SpawnTrackedMeta
): SpawnTrackedResult;
export function spawnTracked(
  command: string,
  options: SpawnOptions & { shell?: boolean | string },
  meta: SpawnTrackedMeta
): SpawnTrackedResult;
export function spawnTracked(
  command: string,
  argsOrOptions: string[] | (SpawnOptions & { shell?: boolean | string }),
  optionsOrMeta: (SpawnOptions & { shell?: boolean | string }) | SpawnTrackedMeta,
  maybeMeta?: SpawnTrackedMeta
): SpawnTrackedResult {
  let meta: SpawnTrackedMeta;
  let spawnArgs: SpawnArgs;
  if (Array.isArray(argsOrOptions)) {
    meta = maybeMeta as SpawnTrackedMeta;
    spawnArgs = normaliseArgs(
      command,
      argsOrOptions,
      optionsOrMeta as SpawnOptions & { shell?: boolean | string }
    );
  } else {
    meta = optionsOrMeta as SpawnTrackedMeta;
    spawnArgs = normaliseArgs(
      command,
      argsOrOptions as SpawnOptions & { shell?: boolean | string },
      undefined
    );
  }

  // Force stdio to pipe so we can tee.
  const stdioOption = spawnArgs.options.stdio;
  const stdio = stdioOption ?? "pipe";

  const child = nodeSpawn(spawnArgs.command, spawnArgs.args, {
    ...spawnArgs.options,
    stdio
  }) as ChildProcessWithoutNullStreams;

  const pid = child.pid;
  if (!pid) {
    // Spawn failed; return without log capture but with stub paths.
    const logsDir = logsDirForPid(0);
    return {
      child,
      logsDir,
      stdoutPath: path.join(logsDir, "stdout.log"),
      stderrPath: path.join(logsDir, "stderr.log"),
      metaPath: path.join(logsDir, "meta.json"),
      closeLogs: () => {}
    };
  }

  const logsDir = logsDirForPid(pid);
  mkdirSync(logsDir, { recursive: true });

  const stdoutPath = path.join(logsDir, "stdout.log");
  const stderrPath = path.join(logsDir, "stderr.log");
  const metaPath = path.join(logsDir, "meta.json");

  const metaJson: MetaJson = {
    pid,
    command: spawnArgs.command,
    args: spawnArgs.args,
    shell: spawnArgs.shellInvocation,
    cwd: (spawnArgs.options.cwd as string | undefined) ?? process.cwd(),
    parentPid: process.pid,
    spawnedAt: new Date().toISOString(),
    env: redactEnv(spawnArgs.options.env as NodeJS.ProcessEnv | undefined),
    spawnSite: meta.spawnSite,
    description: meta.description
  };
  writeFileSync(metaPath, JSON.stringify(metaJson, null, 2));

  let stdoutStream: WriteStream | null = null;
  let stderrStream: WriteStream | null = null;

  if (child.stdout) {
    stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
    child.stdout.on("data", (chunk) => stdoutStream?.write(chunk));
  }
  if (child.stderr) {
    stderrStream = createWriteStream(stderrPath, { flags: "a" });
    child.stderr.on("data", (chunk) => stderrStream?.write(chunk));
  }

  const closeLogs = () => {
    stdoutStream?.end();
    stderrStream?.end();
  };

  // Best-effort close on exit; tee continues until streams drain.
  child.on("close", () => closeLogs());

  return {
    child,
    logsDir,
    stdoutPath,
    stderrPath,
    metaPath,
    closeLogs
  };
}

// Convenience re-export so callers don't need to import node:child_process types separately.
export type { ChildProcessWithoutNullStreams };
