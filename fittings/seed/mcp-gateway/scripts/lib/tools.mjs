// Tool registry for the mcp-gateway Fitting.
// Each tool shells out to the underlying Fitting's script.
// GARRISON_COMPOSITION_DIR must be set before importing this module.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();

function resolveScript(fittingId, scriptName) {
  return path.join(COMPOSITION_DIR, "apm_modules", "_local", fittingId, "scripts", scriptName);
}

export async function checkProbe(fittingId, scriptName) {
  const scriptPath = resolveScript(fittingId, scriptName);
  if (!existsSync(scriptPath)) return false;
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath, "--probe"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("exit", (code) => resolve(code === 0 && stdout.trim() === "ok"));
    child.on("error", () => resolve(false));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 5000);
  });
}

function callScript(scriptPath, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error(`script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `script exited with code ${code}`));
      } else {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`invalid JSON from script: ${stdout.slice(0, 200)}`));
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${err.message}`));
    });
  });
}

export async function callClassifyTier(input) {
  const scriptPath = resolveScript("tier-classifier", "classify_tier.mjs");
  if (!existsSync(scriptPath)) throw new Error("classify_tier script not found");
  return callScript(scriptPath, input, 30_000);
}

export async function callRunTests(input) {
  const scriptPath = resolveScript("testing", "run_tests.mjs");
  if (!existsSync(scriptPath)) throw new Error("run_tests script not found");
  return callScript(scriptPath, input, 5 * 60_000);
}

// ───────────────────────────────────────────────────────── garrison-control
// Thin HTTP forwarders to the http-gateway's internal endpoints. Only present
// when GARRISON_HTTP_GATEWAY_BASE_URL is set at boot.

const HTTP_GATEWAY_BASE_URL = process.env.GARRISON_HTTP_GATEWAY_BASE_URL ?? "";

function httpGatewayUrl(pathSuffix) {
  if (!HTTP_GATEWAY_BASE_URL) {
    throw new Error("GARRISON_HTTP_GATEWAY_BASE_URL not set");
  }
  return `${HTTP_GATEWAY_BASE_URL.replace(/\/+$/, "")}${pathSuffix}`;
}

async function httpRequest(method, pathSuffix, body) {
  const url = httpGatewayUrl(pathSuffix);
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  let lastErr;
  const delays = [100, 500, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return await response.json().catch(() => ({}));
      const text = await response.text().catch(() => "");
      lastErr = new Error(`${method} ${pathSuffix} → ${response.status}: ${text.slice(0, 200)}`);
      if (response.status >= 500) throw lastErr; // retry
      throw lastErr;
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

export function isGarrisonControlEnabled() {
  return Boolean(HTTP_GATEWAY_BASE_URL);
}

export async function callTalkTo(input) {
  return httpRequest("POST", "/sessions/spawn", {
    soul: input.soul,
    message: input.message,
    worktree_id: input.worktree_id,
    mode: input.mode,
    tier_hint: input.tier_hint,
    task_title: input.task_title,
    channel: input.channel,
    cwd: input.cwd
  });
}

export async function callWaitFor(input) {
  return httpRequest(
    "POST",
    `/sessions/${encodeURIComponent(input.session_id)}/wait`,
    { timeout_seconds: input.timeout_seconds }
  );
}

export async function callListActiveSessions(input = {}) {
  const params = new URLSearchParams();
  if (input.parent) params.set("parent", input.parent);
  if (input.worktree_id) params.set("worktree_id", input.worktree_id);
  if (input.mode) params.set("mode", input.mode);
  if (input.soul) params.set("soul", input.soul);
  const suffix = params.toString() ? `?${params}` : "";
  return httpRequest("GET", `/sessions${suffix}`);
}

export async function callEndSession(input) {
  return httpRequest("POST", `/sessions/by-soul/${encodeURIComponent(input.soul)}/end`);
}

export async function callListWorkdirs(input) {
  return httpRequest("GET", `/workdirs?soul=${encodeURIComponent(input.soul)}`);
}

export async function callListWorktrees(input = {}) {
  const params = new URLSearchParams();
  if (input.project) params.set("project", input.project);
  const suffix = params.toString() ? `?${params}` : "";
  return httpRequest("GET", `/worktrees${suffix}`);
}

export async function callCreateWorktree(input) {
  return httpRequest("POST", "/worktrees", {
    project: input.project,
    task_title: input.task_title,
    branch_name: input.branch_name,
    base_branch: input.base_branch
  });
}

export async function callGetWorktree(input) {
  return httpRequest("GET", `/worktrees?id=${encodeURIComponent(input.id)}`);
}

export async function callCloseWorktree(input) {
  return httpRequest("POST", `/worktrees/${encodeURIComponent(input.id)}/close`, {
    action: input.action,
    pr_title: input.pr_title,
    pr_body: input.pr_body
  });
}
