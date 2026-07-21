// account-login.ts — RUNTIME-ACCOUNTS-V1 D2: the guided setup-token login flow.
//
// The Next server cannot host node-pty in its bundle, so each login attempt is
// a detached helper process (scripts/account-login-pty.mjs) speaking a small
// file protocol under <garrison home>/account-login/<id>/. This module owns
// the server side: start/status/code/cancel, and the finalize step that moves
// a captured token from the helper's 0600 file into the vault (deleting the
// file), then runs a live verify probe under the new token. Token values never
// appear in any status payload.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { garrisonDir } from "./claude-home";
import { ROOT_DIR } from "./paths";
import { addAccount, setAccountNeedsRelogin } from "./accounts";
import { accountAuthEnv } from "./account-env";

export interface LoginStatus {
  id: string;
  accountName: string;
  mode: "setup-token" | "generic";
  /** Helper-reported state, overlaid with the server's finalize progress. */
  state:
    | "starting"
    | "running"
    | "awaiting-browser"
    | "captured"
    | "verifying"
    | "done"
    | "finished"
    | "cancelled"
    | "error";
  authorizeUrl: string | null;
  outputTail: string;
  error: string | null;
  verify: { ok: boolean; detail: string } | null;
}

interface LoginRuntimeEntry {
  accountName: string;
  label?: string;
  mode: "setup-token" | "generic";
  finalize?: "pending" | "verifying" | "done" | "failed";
  verify?: { ok: boolean; detail: string } | null;
  finalizeError?: string;
}

interface LoginRuntime {
  sessions: Map<string, LoginRuntimeEntry>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonAccountLogin: LoginRuntime | undefined;
}

function runtime(): LoginRuntime {
  globalThis.__agentGarrisonAccountLogin ??= { sessions: new Map() };
  return globalThis.__agentGarrisonAccountLogin;
}

function loginDir(id: string): string {
  return path.join(garrisonDir(), "account-login", id);
}

const ID_RE = /^[a-f0-9]{16}$/;

export async function startLogin(options: {
  accountName: string;
  label?: string;
  mode?: "setup-token" | "generic";
  command?: string;
}): Promise<{ id: string }> {
  const id = randomBytes(8).toString("hex");
  const dir = loginDir(id);
  await fs.mkdir(dir, { recursive: true });
  const mode = options.mode ?? "setup-token";
  const helper = path.join(ROOT_DIR, "scripts", "account-login-pty.mjs");
  const args = [helper, "--dir", dir, "--mode", mode === "generic" ? "generic" : "setup-token"];
  if (mode === "generic" && options.command) args.push("--command", options.command);
  const child = spawn("node", args, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore",
    env: { ...process.env }
  });
  child.unref();
  runtime().sessions.set(id, { accountName: options.accountName, label: options.label, mode });
  return { id };
}

async function readHelperStatus(id: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(loginDir(id), "status.json"), "utf8"));
  } catch {
    return null;
  }
}

// Move a captured token into the vault exactly once, then verify it live. The
// helper's token file is deleted the moment it is read.
async function finalizeCapture(id: string, entry: LoginRuntimeEntry): Promise<void> {
  if (entry.finalize) return;
  const tokenPath = path.join(loginDir(id), "token.txt");
  if (!existsSync(tokenPath)) return;
  entry.finalize = "pending";
  let token: string;
  try {
    token = (await fs.readFile(tokenPath, "utf8")).trim();
    await fs.unlink(tokenPath);
    await addAccount({ name: entry.accountName, token, label: entry.label });
  } catch (error) {
    entry.finalize = "failed";
    entry.finalizeError = error instanceof Error ? error.message : String(error);
    return;
  }
  entry.finalize = "verifying";
  entry.verify = null;
  try {
    const verify = await verifyToken(entry.accountName, token);
    entry.verify = verify;
    entry.finalize = "done";
    await setAccountNeedsRelogin(entry.accountName, !verify.ok);
  } catch (error) {
    entry.verify = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    entry.finalize = "done";
  }
}

// Live probe: a one-shot claude print run pinned to the new token. Proves the
// captured token actually authenticates before the UI reports success.
function verifyToken(name: string, token: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("claude", ["-p", "Reply with exactly: VERIFY-OK"], {
      cwd: garrisonDir(),
      env: {
        NODE_ENV: process.env.NODE_ENV,
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        TERM: "xterm",
        ...accountAuthEnv(name, token)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      if (out.includes("VERIFY-OK")) {
        resolve({ ok: true, detail: "live probe answered under the new token" });
      } else {
        const auth = /401|authenticate|bearer/i.test(out + err);
        resolve({
          ok: false,
          detail: auth ? "token was rejected by the API (401)" : `probe did not answer (${(out + err).slice(0, 160).trim()})`
        });
      }
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `probe failed to start: ${error.message}` });
    });
  });
}

export async function loginStatus(id: string): Promise<LoginStatus | null> {
  if (!ID_RE.test(id)) return null;
  const entry = runtime().sessions.get(id);
  const helper = await readHelperStatus(id);
  if (!entry && !helper) return null;
  const fallback: LoginRuntimeEntry = entry ?? { accountName: "", mode: "setup-token" };

  // Finalize lazily on poll: the helper marks "captured"; the server moves the
  // token into the vault + verifies on the next status read.
  if (helper?.state === "captured" && fallback.accountName) {
    await finalizeCapture(id, fallback);
  }

  const helperState = String(helper?.state ?? "starting") as LoginStatus["state"];
  let state: LoginStatus["state"] = helperState;
  let error = (helper?.error as string | null) ?? null;
  if (fallback.finalize === "pending" || fallback.finalize === "verifying") state = "verifying";
  if (fallback.finalize === "done") state = "done";
  if (fallback.finalize === "failed") {
    state = "error";
    error = fallback.finalizeError ?? "storing the captured token failed";
  }

  return {
    id,
    accountName: fallback.accountName,
    mode: fallback.mode,
    state,
    authorizeUrl: (helper?.authorizeUrl as string | null) ?? null,
    outputTail: String(helper?.outputTail ?? ""),
    error,
    verify: fallback.verify ?? null
  };
}

export async function sendLoginInput(id: string, text: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("unknown login id");
  // One line only — the input is typed into a PTY.
  const line = text.replace(/[\r\n]+/g, " ").trim().slice(0, 4096);
  await fs.writeFile(path.join(loginDir(id), "input.txt"), line, { mode: 0o600 });
}

export async function cancelLogin(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("unknown login id");
  await fs.writeFile(path.join(loginDir(id), "cancel"), "");
}
