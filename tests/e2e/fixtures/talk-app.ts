import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// The Garrison shell as the host of the Conversations engine (/talk), booted by
// a spec: one throwaway `next dev` per spec file, on a free loopback port, over
// a scratch GARRISON_HOME, pointed at the spec's fake gateway through
// GARRISON_GATEWAY_URL. A spec owns the process (not the config's `webServer`)
// so it can kill and respawn it mid-test - the restart-recovery contract is
// only provable against a genuine restart.
//
// Playwright transpiles specs to CJS, so process.cwd() (the repo root) stands
// in for import.meta.url.
export const REPO_ROOT = process.cwd();
const NEXT_BIN = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");

// The same dist dir the base config's dev server uses. A second `next dev` on
// the live server's .next/ stomps its route manifests, so the e2e servers keep
// their own; and it has to be THIS dir rather than one minted per run because
// Next appends any distDir it does not find in tsconfig.json's `include` to
// that file - .next-e2e is the one already listed there and in .gitignore. The
// two e2e configs therefore never run at the same time.
const DIST_DIR = ".next-e2e";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface TalkAppOptions {
  /** Scratch GARRISON_HOME. Created (with the Claude sandbox inside it) if missing. */
  home: string;
  /** The fake gateway's loopback base; read by the shell through GARRISON_GATEWAY_URL. */
  gatewayUrl: string;
  /** Loopback port to listen on; a restart re-binds the same one. */
  port: number;
}

export interface TalkApp {
  readonly port: number;
  readonly base: string;
  readonly home: string;
  readonly proc: ChildProcess;
  /** SIGTERM the process tree and wait until the port is closed. */
  stop(): Promise<void>;
  /** stop() then boot again on the same home, gateway and port. */
  restart(): Promise<void>;
}

export function scratchHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, "claude"), { recursive: true });
  return home;
}

function appEnv(opts: TalkAppOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GARRISON_HOME: opts.home,
    // Everything the shell would read from the user's live ~/.claude lands in
    // the scratch home instead; a dir not named `.claude` also keeps its
    // .claude.json inside it (src/lib/claude-home.ts).
    GARRISON_CLAUDE_HOME: path.join(opts.home, "claude"),
    GARRISON_STATE_PATH: path.join(opts.home, "state.json"),
    GARRISON_GATEWAY_URL: opts.gatewayUrl,
    GARRISON_APP_PORT: String(opts.port),
    PORT: String(opts.port),
    // The sandbox profile: never the node's ports, never its host daemon sweep.
    GARRISON_INSTANCE_ID: "dev",
    GARRISON_DISABLE_HOST_DAEMONS: "1",
    NEXT_DIST_DIR: DIST_DIR,
    NODE_ENV: "development",
  };
  // A launcher-exported Claude config dir must not leak into the sandbox.
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

async function waitForHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) {
        const body = (await r.json()) as { ok?: boolean };
        if (body?.ok) return;
      }
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`talk app never became healthy at ${base} (last: ${last})`);
}

async function waitForClosed(port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (!open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} still accepting connections after stop`);
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid == null) return;
  // `next dev` forks the server into a child; the spawn is detached so the
  // whole group can be signalled at once and no server outlives its spec.
  try { process.kill(-proc.pid, signal); } catch { /* group already gone */ }
  try { proc.kill(signal); } catch { /* already gone */ }
}

async function spawnApp(opts: TalkAppOptions): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [NEXT_BIN, "dev", "-H", "127.0.0.1", "-p", String(opts.port)], {
    cwd: REPO_ROOT,
    env: appEnv(opts),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Both pipes are drained: an unread pipe fills and stalls the server. The
  // tail is what an early exit reports.
  let tail = "";
  const drain = (chunk: unknown) => {
    tail += String(chunk);
    if (tail.length > 8_000) tail = tail.slice(-8_000);
  };
  proc.stdout?.on("data", drain);
  proc.stderr?.on("data", drain);
  const exited = new Promise<never>((_, reject) => {
    proc.once("exit", (code, sig) => reject(new Error(`next dev exited early (${code ?? sig}): ${tail.trim()}`)));
  });
  const base = `http://127.0.0.1:${opts.port}`;
  // Dev compiles a route on first hit: the catch-all for health, then /talk so
  // the first navigation of a spec measures the page, not the compiler.
  await Promise.race([waitForHealth(base, 90_000), exited]);
  await Promise.race([
    fetch(`${base}/talk`, { signal: AbortSignal.timeout(90_000) }).then((r) => {
      if (!r.ok) throw new Error(`GET /talk answered ${r.status}`);
    }),
    exited,
  ]);
  return proc;
}

export async function startTalkApp(opts: TalkAppOptions): Promise<TalkApp> {
  fs.mkdirSync(path.join(opts.home, "claude"), { recursive: true });
  let proc = await spawnApp(opts);
  const base = `http://127.0.0.1:${opts.port}`;
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await waitForClosed(opts.port, 5_000);
      return;
    }
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    killTree(proc, "SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (proc.exitCode === null && proc.signalCode === null) {
      killTree(proc, "SIGKILL");
      await exited;
    }
    await waitForClosed(opts.port, 10_000);
  };
  const app: TalkApp = {
    port: opts.port,
    base,
    home: opts.home,
    get proc() { return proc; },
    stop,
    async restart() {
      await stop();
      proc = await spawnApp(opts);
    },
  };
  return app;
}
