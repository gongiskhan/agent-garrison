#!/usr/bin/env node
// Garrison testing Fitting — project-aware test runner.
//
// Usage:
//   node run_tests.mjs --probe           # health check, prints "ok"
//   echo '{"cwd":"/path"}' | node run_tests.mjs
//   echo '{"cwd":"/path","pattern":"auth"}' | node run_tests.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const TIMEOUT_MS = 5 * 60 * 1000;

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function detectProject(cwd) {
  if (existsSync(path.join(cwd, "package.json"))) return "node";
  if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "pytest.ini"))) return "python";
  if (existsSync(path.join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(path.join(cwd, "go.mod"))) return "go";
  return null;
}

function buildCommand(projectType, pattern) {
  switch (projectType) {
    case "node":
      return pattern ? ["npm", ["test", "--", pattern]] : ["npm", ["test"]];
    case "python":
      return pattern ? ["pytest", [pattern]] : ["pytest", []];
    case "rust":
      return pattern ? ["cargo", ["test", pattern]] : ["cargo", ["test"]];
    case "go":
      return pattern ? ["go", ["test", "./...", "-run", pattern]] : ["go", ["test", "./..."]];
    default:
      return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function runTests(cwd, pattern) {
  const expanded = expandTilde(cwd);
  if (!existsSync(expanded)) {
    throw new Error(`cwd does not exist: ${expanded}`);
  }

  const projectType = detectProject(expanded);
  if (!projectType) {
    throw new Error(
      `could not detect project type in ${expanded} — no package.json, pyproject.toml, Cargo.toml, or go.mod found`
    );
  }

  const [cmd, args] = buildCommand(projectType, pattern ?? null);
  const commandStr = [cmd, ...args].join(" ");
  const startMs = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: expanded,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`run_tests timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({
        project_type: projectType,
        command: commandStr,
        exit_code: exitCode ?? -1,
        stdout: stdout.slice(0, 128 * 1024),
        stderr: stderr.slice(0, 32 * 1024),
        duration_ms: Date.now() - startMs
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${err.message}`));
    });
  });
}

async function main(argv) {
  if (argv[0] === "--probe") {
    process.stdout.write("ok\n");
    return 0;
  }

  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`run_tests: invalid JSON input: ${err.message}\n`);
    return 1;
  }

  if (!input.cwd || typeof input.cwd !== "string") {
    process.stderr.write("run_tests: input.cwd (string) is required\n");
    return 1;
  }

  try {
    const result = await runTests(input.cwd, input.pattern);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`run_tests: ${err.message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`run_tests: ${err.message}\n`);
  process.exit(1);
});
