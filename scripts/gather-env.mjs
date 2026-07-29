#!/usr/bin/env node
// Gather helper (brief Phase 1, optional): scan a machine's existing project
// .env files and PROPOSE vault entries. Applies nothing without explicit
// approval — this reads real credentials, so the default must be "show me".
//
// Usage:
//   node scripts/gather-env.mjs [--root ~/dev] [--project <id>] [--apply]
//
// Without --apply it prints a proposal: which NAMES it found, in which files,
// and whether the vault already holds that name (and whether the existing value
// differs). Values are never printed - only a masked preview, the same shape the
// Vault surface shows.
//
// With --apply it writes the proposed entries to the vault, SKIPPING any name
// that already exists with a different value (a collision is a decision for a
// human: it is exactly the case the PROJECT__VAR override convention exists for).

import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".next-prod",
  "apm_modules", "venv", ".venv", "__pycache__", "target", "vendor"
]);
// .env.example and friends hold placeholders, not secrets - proposing them
// would seed the vault with "changeme".
const ENV_FILE = /^\.env(\.(local|development|production))?$/;

function maskValue(v) {
  if (!v) return "";
  if (v.length <= 12) return `••••• (${v.length} chars)`;
  const flat = v.replace(/\s+/g, " ");
  return `${flat.slice(0, 4)}…${flat.slice(-4)} (${v.length} chars)`;
}

// Deliberately simple: NAME=VALUE, optional quotes, ignore comments/blank lines.
function parseEnvFile(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // an empty var carries no secret to gather
    out.push({ name, value });
  }
  return out;
}

async function* walk(dir, depth = 0) {
  if (depth > 4) return; // project .env files are near the root; don't crawl forever
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") && e.name !== ".config") continue;
      yield* walk(path.join(dir, e.name), depth + 1);
    } else if (ENV_FILE.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

function vaultSnapshot() {
  const res = spawnSync(
    "npx",
    ["tsx", "-e", `
      import { readVaultSecrets } from "./src/lib/vault";
      // async IIFE: tsx -e emits CJS, where top-level await is a hard error.
      (async () => {
        process.stdout.write(JSON.stringify(await readVaultSecrets()));
      })().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
    `],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    console.error(res.stderr || "could not read the vault (is it unlocked?)");
    process.exit(1);
  }
  return new Map(JSON.parse(res.stdout).map((s) => [s.key, s.value]));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : null;
  };
  const root = path.resolve(flag("root") || path.join(homedir(), "dev"));
  const apply = args.includes("--apply");

  try {
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    console.error(`not a directory: ${root}`);
    process.exit(2);
  }

  const existing = vaultSnapshot();
  // name -> { value, files[] }
  const found = new Map();
  for await (const file of walk(root)) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const { name, value } of parseEnvFile(text)) {
      const prev = found.get(name);
      if (prev) {
        prev.files.push(file);
        if (prev.value !== value) prev.conflicting = true;
      } else {
        found.set(name, { value, files: [file], conflicting: false });
      }
    }
  }

  if (!found.size) {
    console.log(`no .env files with values under ${root}`);
    return;
  }

  const proposals = [];
  console.log(`scanned ${root}\n`);
  for (const [name, info] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    const inVault = existing.has(name);
    const same = inVault && existing.get(name) === info.value;
    let verdict;
    if (same) verdict = "already in vault, identical";
    else if (inVault) verdict = "CONFLICT — vault holds a different value";
    else if (info.conflicting) verdict = "CONFLICT — projects disagree on this name";
    else {
      verdict = "propose";
      proposals.push({ key: name, value: info.value });
    }
    console.log(`${name}`);
    console.log(`  ${maskValue(info.value)}  ${verdict}`);
    console.log(`  ${info.files.length} file(s): ${info.files.slice(0, 3).map((f) => path.relative(root, f)).join(", ")}${info.files.length > 3 ? " …" : ""}`);
    if (verdict.startsWith("CONFLICT")) {
      console.log(`  -> use a per-project override: add ${"<PROJECT>"}__${name} to the vault instead`);
    }
    console.log("");
  }

  if (!apply) {
    console.log(`${proposals.length} entr${proposals.length === 1 ? "y" : "ies"} would be added. Re-run with --apply to write them.`);
    return;
  }
  if (!proposals.length) {
    console.log("nothing to apply.");
    return;
  }

  const res = spawnSync(
    "npx",
    ["tsx", "-e", `
      import { readVaultSecrets, writeVaultSecrets } from "./src/lib/vault";
      (async () => {
        const add = JSON.parse(process.env.GATHER_PROPOSALS);
        const current = await readVaultSecrets();
        // Merge: never drop an existing entry, never overwrite one.
        const byKey = new Map(current.map((s) => [s.key, s]));
        for (const p of add) if (!byKey.has(p.key)) byKey.set(p.key, p);
        await writeVaultSecrets([...byKey.values()]);
        process.stdout.write(String(add.length));
      })().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
    `],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GATHER_PROPOSALS: JSON.stringify(proposals) }
    }
  );
  if (res.status !== 0) {
    console.error(res.stderr || "failed to write the vault");
    process.exit(1);
  }
  console.log(`added ${res.stdout} entries to the vault.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
