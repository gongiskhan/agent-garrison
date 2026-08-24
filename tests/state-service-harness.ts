// Boots the real state service on an EPHEMERAL port against a temp DB and
// hands back a configured StateClient. The client throws when unconfigured —
// so no test can ever silently hit the real service (the same isolation
// discipline as GARRISON_HOME pinning, generalised).

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { StateClient } from "@garrison/state-client";

const SERVICE_DIR = path.resolve(__dirname, "..", "services", "state");

export interface StateHarness {
  client: StateClient;
  url: string;
  token: string;
  dbPath: string;
  /** Issue a token for an additional node (offline, straight into the DB is
   *  not possible while the service holds it — so this uses the API via the
   *  first node? No: registration is local-only. Tests that need a second
   *  node issue it BEFORE start via issueToken, or restart. */
  stop(): Promise<void>;
  proc: ChildProcess;
}

export function issueToken(dbPath: string, name: string, extra: string[] = []): string {
  return execFileSync(
    process.execPath,
    [path.join(SERVICE_DIR, "scripts", "issue-node-token.mjs"), "--db", dbPath, name, ...extra],
    { encoding: "utf8" }
  ).trim();
}

export async function startStateService(options: {
  nodes?: string[];
} = {}): Promise<StateHarness & { tokens: Record<string, string> }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "garrison-state-test-"));
  const dbPath = path.join(dir, "state.db");
  const masterKey = randomBytes(32).toString("hex");

  const nodeNames = options.nodes ?? ["test-node"];
  const tokens: Record<string, string> = {};
  for (const name of nodeNames) {
    tokens[name] = issueToken(dbPath, name);
  }

  const proc = spawn(process.execPath, [path.join(SERVICE_DIR, "src", "server.mjs")], {
    env: {
      ...process.env,
      GARRISON_STATE_DB: dbPath,
      GARRISON_STATE_PORT: "0",
      GARRISON_STATE_MASTER_KEY_HEX: masterKey,
      // Explicitly unset so nothing in the service resolves the real world.
      GARRISON_STATE_BIND: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const url: string = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`state service did not start:\n${buffer}`)), 10_000);
    proc.stdout!.on("data", (chunk) => {
      buffer += String(chunk);
      const m = buffer.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.stderr!.on("data", (chunk) => {
      buffer += String(chunk);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`state service exited ${code} before listening:\n${buffer}`));
    });
  });

  const primary = nodeNames[0];
  const client = new StateClient({ url, token: tokens[primary], node: primary });

  return {
    client,
    url,
    token: tokens[primary],
    tokens,
    dbPath,
    proc,
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((resolve) => proc.on("exit", resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
