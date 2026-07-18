#!/usr/bin/env node
// Atomically detach a scheduler jobs file from one checkout's installed
// composition scripts and point it at another checkout. Dry-run by default.
//
// Example:
//   node scripts/repoint-scheduler-jobs.mjs \
//     --file ~/.garrison/scheduler-jobs.json \
//     --from /old/repo/compositions/default/apm_modules \
//     --to /new/repo/compositions/default/apm_modules \
//     --expect 4
//
// Add --apply --backup /absolute/backup.json only after reviewing the plan.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function requiredPath(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

export function rewriteJobCommands(jobs, fromPrefix, toPrefix) {
  if (!Array.isArray(jobs)) throw new Error("jobs file must contain a JSON array");
  const from = requiredPath(fromPrefix, "--from");
  const to = requiredPath(toPrefix, "--to");
  if (from === to) throw new Error("--from and --to must differ");

  let changed = 0;
  const plan = [];
  const rewritten = jobs.map((job) => {
    const before = typeof job?.command === "string" ? job.command : null;
    const after = before ? before.split(from).join(to) : before;
    const didChange = before !== after;
    if (didChange) changed += 1;
    plan.push({ id: String(job?.id ?? ""), changed: didChange, before, after });
    return didChange ? { ...job, command: after } : job;
  });
  return { jobs: rewritten, plan, changed, from, to };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fsyncFile(file) {
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function applyRewrite({ file, backup, result }) {
  if (!backup) throw new Error("--backup is required with --apply");
  const backupPath = requiredPath(backup, "--backup");
  if (existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);

  const mode = statSync(file).mode & 0o777;
  copyFileSync(file, backupPath);
  chmodSync(backupPath, mode);
  fsyncFile(backupPath);

  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.repoint-${process.pid}-${Date.now()}`
  );
  try {
    writeFileSync(temp, `${JSON.stringify(result.jobs, null, 2)}\n`, { mode });
    chmodSync(temp, mode);
    fsyncFile(temp);
    renameSync(temp, file);
    const dirFd = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function main(argv = process.argv.slice(2)) {
  const file = requiredPath(option(argv, "--file"), "--file");
  const from = requiredPath(option(argv, "--from"), "--from");
  const to = requiredPath(option(argv, "--to"), "--to");
  const expectedRaw = option(argv, "--expect");
  const expected = expectedRaw === undefined ? null : Number(expectedRaw);
  if (expected !== null && (!Number.isInteger(expected) || expected < 0)) {
    throw new Error("--expect must be a non-negative integer");
  }

  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const result = rewriteJobCommands(parsed, from, to);
  if (expected !== null && result.changed !== expected) {
    throw new Error(`expected ${expected} changed jobs, found ${result.changed}`);
  }
  if (result.changed === 0) throw new Error("no job commands matched --from");

  const missingTargets = [];
  for (const row of result.plan.filter((entry) => entry.changed && entry.after)) {
    const escaped = to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = row.after.match(new RegExp(`${escaped}[^\\s'"]+`, "g")) ?? [];
    for (const target of matches) {
      if (!existsSync(target)) missingTargets.push({ id: row.id, target });
    }
  }
  if (missingTargets.length > 0) {
    throw new Error(`replacement targets are missing: ${JSON.stringify(missingTargets)}`);
  }

  const apply = argv.includes("--apply");
  if (apply) {
    applyRewrite({ file, backup: option(argv, "--backup"), result });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: apply ? "applied" : "dry-run",
        file,
        changed: result.changed,
        from,
        to,
        plan: result.plan
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`repoint-scheduler-jobs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
