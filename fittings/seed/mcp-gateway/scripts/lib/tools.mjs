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
