#!/usr/bin/env node
// The only sanctioned way to delete documentation. Dry-run by default; --apply
// deletes. Every gate here is the executable form of a rule the skill states in
// prose, in the same spirit as the sample-hash guarantee: a doc leaves the repo
// only when the machine can prove its content already lives somewhere else.
//
//   node scripts/cleanup.mjs --repo <path> [--apply]
//
// Every entry is preflighted before the first deletion. A later filesystem error
// stops immediately and reports the exact partial deletion set; verified copies
// remain available under viewer/docs.
//
// Gates, in order, all of them mechanical:
//   1. viewer/intake.json recorded cleanupArmed: true.
//   2. viewer/cleanup-allowlist.json exists, is approved (approvedAt set), and
//      every entry is a literal repo-relative path — no globs, no patterns.
//   3. No entry touches the hard exclusions (executable markdown and payload):
//      fittings/seed/**, .codex/skills/**, site/**, public/icons/**, nor any
//      README.md, CLAUDE.md, AGENTS.md, SKILL.md anywhere (slim-only files).
//   4. Every entry has a docs-manifest entry whose `source` is this path and
//      whose `sourceSha256` matches the CURRENT bytes of the file — i.e. the
//      doc was consolidated via store.consolidateDoc and has not changed since.
//   5. The consolidated copy exists, is non-empty, still hashes to the same
//      sourceSha256, and renders through the same renderer /docs uses.

import { createHash } from "node:crypto";
import { readFile, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { confinedPath, relativePath } from "../lib/paths.mjs";
import * as store from "../lib/store.mjs";
import { renderDoc } from "../lib/render.mjs";

const HARD_EXCLUDED_DIRS = ["fittings", ".codex", ".agents", ".claude", ".git", ".garrison", "viewer", "compositions", "node_modules", "apm_modules", "site", "public/icons"];
const SLIM_ONLY_BASENAMES = new Set(["README.MD", "CLAUDE.MD", "AGENTS.MD", "SKILL.MD"]);
const GLOBBISH = /[*?[\]{}]/;

export function isHardExcluded(rel) {
  const posix = relativePath(rel.split(path.sep).join("/"));
  const folded = posix.toLowerCase();
  if (HARD_EXCLUDED_DIRS.some((d) => folded === d || folded.startsWith(`${d}/`))) return true;
  if (SLIM_ONLY_BASENAMES.has(path.posix.basename(posix).toUpperCase())) return true;
  return false;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Check every gate; delete only when apply is set AND every entry passes.
 * Returns { ok, problems, checked, deleted } and never touches a file unless
 * ok && apply. Exit codes and printing belong to main(), not here.
 */
export async function runCleanup(root, { apply = false } = {}) {
  const problems = [];
  root = path.resolve(root);

  const intake = await store.getIntake(root);
  if (intake?.cleanupArmed !== true) {
    return {
      ok: false,
      problems: ["intake did not record cleanupArmed: true — cleanup was never armed for this project"],
      checked: [],
      deleted: [],
    };
  }

  const allowlist = await store.readJson(store.cleanupAllowlistPath(root));
  if (!allowlist) {
    return { ok: false, problems: ["viewer/cleanup-allowlist.json does not exist — nothing to do"], checked: [], deleted: [] };
  }
  if (!allowlist.approvedAt) {
    return { ok: false, problems: ["the allowlist has no approvedAt — a human has not approved this list"], checked: [], deleted: [] };
  }
  const entries = Array.isArray(allowlist.entries) ? allowlist.entries : null;
  if (!entries || entries.length === 0) {
    return { ok: false, problems: ["the allowlist has no entries"], checked: [], deleted: [] };
  }

  const manifest = await store.getDocsManifest(root);
  const docs = manifest.docs ?? [];
  const checked = [];
  const seen = new Set();

  for (const entry of entries) {
    const raw = String(entry?.path ?? "");
    const label = raw || "<empty path>";
    if (!raw || GLOBBISH.test(raw)) {
      problems.push(`${label}: not a literal path — globs and patterns are never accepted`);
      continue;
    }
    let rel;
    try { rel = relativePath(raw); } catch { problems.push(`${label}: escapes the repo`); continue; }
    if (seen.has(rel)) { problems.push(`${label}: duplicate deletion entry`); continue; }
    seen.add(rel);
    if (!/\.(md|mdx|txt|rst|adoc)$/i.test(rel)) { problems.push(`${label}: only documentation files may be deleted`); continue; }
    if (path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
      problems.push(`${label}: escapes the repo — entries must be repo-relative`);
      continue;
    }
    if (!entry.reason) problems.push(`${label}: has no reason`);
    if (isHardExcluded(rel)) {
      problems.push(`${label}: hard-excluded (executable payload or slim-only doc) — never deletable`);
      continue;
    }

    let abs, sourceStat;
    let bytes;
    try {
      abs = confinedPath(root, rel);
      sourceStat = await lstat(abs);
      if (!sourceStat.isFile()) throw new Error("not a regular file");
      bytes = await readFile(abs);
    } catch {
      problems.push(`${label}: does not exist in the repo`);
      continue;
    }

    const posix = relativePath(rel.split(path.sep).join("/"));
    const doc = docs.find((d) => d.source === posix);
    if (!doc) {
      problems.push(`${label}: never consolidated — no docs-manifest entry claims this source`);
      continue;
    }
    const currentSha = sha256(bytes);
    if (doc.sourceSha256 !== currentSha) {
      problems.push(
        `${label}: changed after consolidation (manifest has ${String(doc.sourceSha256).slice(0, 12)}…, ` +
          `file is ${currentSha.slice(0, 12)}…) — consolidate again before deleting`
      );
      continue;
    }

    let copy;
    try {
      const storedAbs = store.consolidatedDocPath(root, doc);
      const copyStat = await lstat(storedAbs);
      if (!copyStat.isFile() || (sourceStat.dev === copyStat.dev && sourceStat.ino === copyStat.ino)) throw new Error("copy is not independent");
      copy = await readFile(storedAbs);
    } catch {
      problems.push(`${label}: consolidated copy ${doc.storedAt} is missing`);
      continue;
    }
    if (copy.length === 0) {
      problems.push(`${label}: consolidated copy ${doc.storedAt} is empty`);
      continue;
    }
    if (sha256(copy) !== doc.sourceSha256) {
      problems.push(`${label}: consolidated copy ${doc.storedAt} no longer matches the recorded hash`);
      continue;
    }
    try {
      const html = renderDoc(doc, copy.toString("utf8"), {});
      if (!html || typeof html !== "string") throw new Error("renderer returned nothing");
    } catch (err) {
      problems.push(`${label}: consolidated copy does not render: ${err.message}`);
      continue;
    }

    checked.push({ rel: posix, abs, docId: doc.docId, sourceSha256: currentSha });
  }

  if (problems.length) return { ok: false, problems, checked: [], deleted: [] };

  const deleted = [];
  if (apply) {
    // Re-read the approved set and every copy immediately before the destructive phase.
    const fresh = await runCleanup(root);
    if (!fresh.ok || JSON.stringify(fresh.checked) !== JSON.stringify(checked)) {
      return { ok: false, problems: ["cleanup inputs changed during verification"], checked: [], deleted: [] };
    }
    for (const c of checked) {
      try {
        const file = confinedPath(root, c.rel);
        if (sha256(await readFile(file)) !== c.sourceSha256) throw new Error("source changed");
        await unlink(file);
        deleted.push(c.rel);
      } catch {
        return { ok: false, problems: [`${c.rel}: deletion stopped; source changed or filesystem refused removal`], checked, deleted };
      }
    }
  }
  return { ok: true, problems: [], checked, deleted };
}

async function main() {
  const args = process.argv.slice(2);
  const opts = { repo: null, apply: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--repo") opts.repo = args[++i];
    else if (args[i] === "--apply") opts.apply = true;
    else {
      process.stderr.write(`unknown argument ${args[i]}\n`);
      process.exit(1);
    }
  }
  if (!opts.repo) {
    process.stderr.write("usage: cleanup.mjs --repo <path> [--apply]\n");
    process.exit(1);
  }

  const result = await runCleanup(opts.repo, { apply: opts.apply });
  if (!result.ok) {
    process.stderr.write(`cleanup stopped — ${result.deleted.length} file(s) deleted:\n`);
    for (const p of result.problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  for (const c of result.checked) {
    process.stdout.write(`${opts.apply ? "deleted" : "would delete"} ${c.rel} (consolidated as ${c.docId})\n`);
  }
  process.stdout.write(
    opts.apply
      ? `${result.deleted.length} file(s) deleted; every one verified consolidated first.\n`
      : `dry run: ${result.checked.length} file(s) pass every gate. Re-run with --apply to delete.\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
