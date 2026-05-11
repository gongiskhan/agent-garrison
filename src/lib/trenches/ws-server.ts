import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = parseInt(process.env.GARRISON_TRENCHES_PORT || "3601", 10);
const HOST = process.env.GARRISON_TRENCHES_HOST || "127.0.0.1";
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const WS_SCRIPT = path.join(process.cwd(), "scripts", "trenches-ws.mjs");

let ensurePromise: Promise<void> | null = null;
let lastHealthOkAt = 0;
const HEALTH_CACHE_MS = 4_000;

async function probeHealth(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean };
    return Boolean(json?.ok);
  } catch {
    return false;
  }
}

async function spawnAndWait(): Promise<void> {
  if (!existsSync(WS_SCRIPT)) {
    throw new Error(`trenches-ws script not found at ${WS_SCRIPT}`);
  }
  const child = spawn(process.execPath, [WS_SCRIPT], {
    stdio: "ignore",
    env: process.env,
    detached: true,
  });
  child.unref();
  child.on("error", (err) => {
    console.warn("[trenches] failed to spawn ws server:", err);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`[trenches] ws server exited code=${code} signal=${signal}`);
    }
  });

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await probeHealth()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("trenches-ws did not become ready within 8s");
}

export async function ensureWsServer(): Promise<void> {
  if (Date.now() - lastHealthOkAt < HEALTH_CACHE_MS) return;
  if (await probeHealth()) {
    lastHealthOkAt = Date.now();
    return;
  }
  if (!ensurePromise) {
    ensurePromise = spawnAndWait()
      .then(() => {
        lastHealthOkAt = Date.now();
      })
      .finally(() => {
        ensurePromise = null;
      });
  }
  await ensurePromise;
}

export function trenchesBaseUrl(): string {
  return `http://${HOST}:${PORT}`;
}

export function trenchesWsUrl(): string {
  return `ws://${HOST}:${PORT}/io`;
}
