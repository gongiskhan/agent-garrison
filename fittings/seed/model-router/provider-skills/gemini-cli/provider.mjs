#!/usr/bin/env node
import { spawn } from "node:child_process";
import { runProvider } from "../provider-common.mjs";

await runProvider({
  id: "gemini-cli",
  label: "Gemini CLI",
  keyEnv: "GEMINI_API_KEY",
  allowModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  invoke: ({ model, prompt }) => new Promise((resolve, reject) => {
    const child = spawn("gemini", ["--model", model], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `gemini exited ${code}`));
    });
    child.stdin.end(prompt);
  })
});
