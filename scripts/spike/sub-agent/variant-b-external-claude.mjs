#!/usr/bin/env node
/**
 * Variant B — External `claude` CLI.
 *
 * Spawn the `claude` binary as a child process with cwd set to the target
 * project. Communicate via stdio. Heaviest in process cost, most isolated.
 * Useful as a fallback if A and C don't carry the load.
 *
 * Usage:
 *   node variant-b-external-claude.mjs
 */
import { spawn } from "node:child_process";
import { makeTempProject, cleanup, readReadme } from "./_temp.mjs";

const PROMPT = `Append a single line to README.md that says exactly:
"This file was edited by the variant-b sub-agent."
Then stop. Do not edit any other files.`;

async function main() {
  const projectDir = await makeTempProject("variant-b");
  console.log(`[variant-b] target project: ${projectDir}`);

  const before = await readReadme(projectDir);
  console.log(`[variant-b] README.md before:\n${before}`);

  const start = Date.now();
  let firstStdoutAt = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;

  // Use --print for non-interactive single-turn execution.
  // --output-format stream-json gives us structured streaming output.
  const child = spawn(
    "claude",
    [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--model", "sonnet",
      PROMPT
    ],
    {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  child.stdout.on("data", (buf) => {
    if (firstStdoutAt === null) firstStdoutAt = Date.now() - start;
    stdoutBytes += buf.length;
  });
  child.stderr.on("data", (buf) => {
    stderrBytes += buf.length;
    process.stderr.write(buf);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  const totalMs = Date.now() - start;
  const after = await readReadme(projectDir);
  console.log(`[variant-b] README.md after:\n${after}`);

  const fileChanged = before !== after;
  const success = exitCode === 0 && fileChanged;

  console.log(JSON.stringify({
    variant: "b-external-claude",
    success,
    file_changed: fileChanged,
    exit_code: exitCode,
    total_ms: totalMs,
    first_stdout_ms: firstStdoutAt,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes
  }, null, 2));

  await cleanup(projectDir);
  process.exit(success ? 0 : 1);
}

main().catch(error => {
  console.error(`[variant-b] failed: ${error.message}`);
  console.error(error.stack);
  process.exit(2);
});
