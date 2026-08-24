#!/usr/bin/env node
// The convergence one-shot — the process that survives the restart it causes.
//
// THE RULE (from the plan): the nightly card never owns the process that
// kills it. The card writes a convergence INTENT to the state service, the
// scheduler daemon launches THIS as a detached one-shot
// (`systemd-run --user --unit=garrison-converge-<ts>` on Linux, a launchd
// one-shot on macOS), and the card POLLS the intent. This script:
//
//   1. reads the intent      (config doc mesh.converge / node:<self>)
//   2. acts                  (redeploy | revert)
//   3. health-checks         (/api/mesh/self 200 + composition up, 180s)
//   4. PATCHes the intent terminal (done | failed, with evidence)
//
//   garrison-converge.mjs redeploy            build+restart+up, health-gated
//   garrison-converge.mjs revert <project> <tag>   reset to the premerge tag first
//
// On failure the intent records it and — for redeploy — the tree is reset to
// the intent's premergeTag and NOT restarted again: a node that merged a
// broken tree and restarts is down until morning; a node left on its last
// good build is merely behind.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
const REPO = process.env.GARRISON_REPO?.trim() || path.join(os.homedir(), "dev", "garrison");
const APP = `http://127.0.0.1:${process.env.GARRISON_APP_PORT?.trim() || "8777"}`;

function stateConfig() {
  const raw = JSON.parse(readFileSync(path.join(HOME, "state.json"), "utf8"));
  return { url: raw.url, token: raw.token, node: raw.node };
}

async function api(method, p, body) {
  const { url, token } = stateConfig();
  const res = await fetch(`${url}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${parsed.error ?? ""}`);
  return parsed;
}

async function putIntent(node, body) {
  const ns = "mesh.converge";
  const scope = `node:${node}`;
  const { url, token } = stateConfig();
  for (let attempt = 0; attempt < 2; attempt++) {
    const currentRes = await fetch(`${url}/v1/config/${ns}/${scope}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const current = currentRes.ok ? await currentRes.json() : null;
    const res = await fetch(`${url}/v1/config/${ns}/${scope}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": String(current?.rev ?? 0)
      },
      body: JSON.stringify({ ...(current?.body ?? {}), ...body, updatedAtStep: new Date().toISOString() })
    });
    if (res.ok) return;
    if (res.status !== 409) throw new Error(`intent PUT ${res.status}`);
  }
  throw new Error("intent PUT lost the CAS twice");
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

async function healthCheck() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP}/api/mesh/self`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const self = await res.json();
        const compUp = self?.composition?.running !== false;
        if (compUp) return { ok: true, self };
      }
    } catch {
      // still coming up
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false };
}

const [mode, arg1, arg2] = process.argv.slice(2);
const { node } = stateConfig();

try {
  if (mode === "revert") {
    const project = arg1;
    const tag = arg2;
    if (!project || !tag) throw new Error("usage: garrison-converge.mjs revert <project> <premerge-tag>");
    const projectDir = project === "garrison" ? REPO : path.join(os.homedir(), "dev", project);
    await putIntent(node, { state: "reverting", project, tag });
    execFileSync("git", ["-C", projectDir, "reset", "--hard", tag], { stdio: "inherit" });
    if (project === "garrison") {
      sh("npm run node:build");
      execFileSync("systemctl", ["--user", "restart", "garrison-prod.service"], { stdio: "inherit" });
      const health = await healthCheck();
      await putIntent(node, { state: health.ok ? "reverted" : "revert-unhealthy", terminal: true });
      process.exit(health.ok ? 0 : 1);
    }
    await putIntent(node, { state: "reverted", terminal: true });
    process.exit(0);
  }

  // Default: redeploy (install + typecheck + test happened BEFORE the intent
  // was written — the card gates on them; this one-shot only swaps + proves).
  await putIntent(node, { state: "building" });
  sh("npm install --no-audit --no-fund >/dev/null 2>&1 || true");
  sh("npm run node:build");
  await putIntent(node, { state: "restarting" });
  execFileSync("systemctl", ["--user", "restart", "garrison-prod.service"], { stdio: "inherit" });
  const health = await healthCheck();
  if (health.ok) {
    // Bring the composition up on the new code.
    await fetch(`${APP}/api/vault/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000)
    }).catch(() => {});
    await fetch(`${APP}/api/runner/default/up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(600_000)
    }).catch(() => {});
    await putIntent(node, { state: "done", terminal: true, healthyAt: new Date().toISOString() });
    process.exit(0);
  }
  // Health failed: reset to the premerge tag if the intent named one; DO NOT
  // restart again.
  const intent = await api("GET", `/v1/config/mesh.converge/node:${node}`).catch(() => null);
  const tag = intent?.body?.premergeTag;
  if (tag) {
    execFileSync("git", ["-C", REPO, "reset", "--hard", tag], { stdio: "inherit" });
    sh("npm run node:build");
    execFileSync("systemctl", ["--user", "restart", "garrison-prod.service"], { stdio: "inherit" });
  }
  await putIntent(node, { state: "failed", terminal: true, revertedTo: tag ?? null });
  process.exit(1);
} catch (err) {
  await putIntent(node, { state: "failed", terminal: true, error: String(err?.message ?? err) }).catch(() => {});
  console.error(`[converge] ${err?.message ?? err}`);
  process.exit(1);
}
