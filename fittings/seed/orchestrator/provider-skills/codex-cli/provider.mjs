#!/usr/bin/env node
import { spawn } from "node:child_process";
import { runProvider } from "../provider-common.mjs";

await runProvider({
  id: "codex-cli",
  label: "Codex CLI",
  keyEnv: null,
  allowModels: ["gpt-5.4", "gpt-5.5", "gpt-5.4-mini"],
  invoke: ({ model, prompt }) => new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--model", model, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `codex exited ${code}`));
    });
    child.stdin.end(prompt);
  })
});
