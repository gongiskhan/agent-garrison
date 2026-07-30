#!/usr/bin/env tsx
// RECOVERY ONLY. Start the prod omi-channel fitting with a runner-parity env when
// Garrison's own /api/fittings/omi-channel/start is unavailable — e.g. while the
// running build's metadata schema is older than a fitting manifest on disk, so the
// route's library scan rejects the whole composition.
//
// Derives every value from the composition + the profile offset (never a port
// literal) and pulls the fitting's declared secret_scope from the vault, so the
// spawned process sees what up() would have projected.
//
// Usage: tsx scripts/spike/omi-recover-start.ts [--print-only]

import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { BASE_APP_PORT, profilePort } from "../../src/lib/instance-profile";

// Read secrets through the RUNNING server, which already holds the unlocked vault;
// a fresh process importing src/lib/vault would have to unlock it again.
async function revealVaultSecret(key: string): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${profilePort(BASE_APP_PORT, "prod")}/api/vault/secrets/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key })
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { value?: unknown };
  return typeof body.value === "string" && body.value.length > 0 ? body.value : null;
}

// Run from the repo root (tsx's cjs transform rules out import.meta).
const REPO = process.cwd();
const FITTING_ID = "omi-channel";
const ENV_PREFIX = `GARRISON_${FITTING_ID.replace(/[^a-z0-9]/gi, "").toUpperCase()}_`;
const PROFILE = "prod" as const;
const GARRISON_HOME = path.join(process.env.HOME ?? "/home/ggomes", ".garrison");

type Cfg = Record<string, unknown>;
const doc = yaml.load(readFileSync(path.join(REPO, "compositions", "default", "apm.yml"), "utf8")) as any;
const faculties = doc?.["x-garrison"]?.composition?.selections ?? {};

function configFor(id: string): Cfg {
  for (const items of Object.values(faculties) as any[]) {
    const hit = (items ?? []).find((i: any) => i?.id === id);
    if (hit) return (hit.config ?? {}) as Cfg;
  }
  return {};
}

const own = configFor(FITTING_ID);
const gateway = configFor("http-gateway");
if (typeof own.port !== "number") throw new Error("omi-channel has no numeric port in the composition");
if (typeof gateway.port !== "number") throw new Error("http-gateway has no numeric port in the composition");

const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  GARRISON_HOME,
  GARRISON_INSTANCE_ID: PROFILE,
  GARRISON_COMPOSITION_ID: "default",
  GARRISON_GATEWAY_URL: `http://127.0.0.1:${profilePort(gateway.port, PROFILE)}`
};

// Project every config key the same way the runner does: GARRISON_<FITTING>_<KEY>,
// with `port` shifted by the profile offset.
for (const [key, value] of Object.entries(own)) {
  if (value === null || typeof value === "object") continue;
  const name = `${ENV_PREFIX}${key.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
  env[name] = key === "port" ? String(profilePort(value as number, PROFILE)) : String(value);
}

// The fitting's declared secret_scope, straight from its own manifest.
const fittingDoc = yaml.load(
  readFileSync(path.join(REPO, "fittings", "seed", FITTING_ID, "apm.yml"), "utf8")
) as any;
const scope: string[] = fittingDoc?.["x-garrison"]?.secret_scope ?? [];

async function main() {
  const delivered: string[] = [];
  for (const key of scope) {
    const value = await revealVaultSecret(key);
    if (value) {
      env[key] = value;
      delivered.push(key);
    }
  }

  const printable = Object.fromEntries(
    Object.entries(env)
      .filter(([k]) => k.startsWith("GARRISON_") || scope.includes(k))
      .map(([k, v]) => [k, scope.includes(k) ? `<${v.length} chars>` : v])
  );
  console.log(JSON.stringify({ printable, secretsDelivered: delivered }, null, 2));
  if (process.argv.includes("--print-only")) return;

  const logFile = path.join(GARRISON_HOME, "ui-fittings", `${FITTING_ID}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn("node", ["scripts/start.mjs"], {
    cwd: path.join(REPO, "fittings", "seed", FITTING_ID),
    env,
    detached: true,
    stdio: ["ignore", fd, fd]
  });
  child.unref();
  console.log(`spawned pid ${child.pid}; log -> ${logFile}`);
}

void main();
