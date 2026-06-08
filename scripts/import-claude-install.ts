/**
 * Seed importer — bootstrap Garrison's seed catalog from a real ~/.claude install.
 *
 * Scans ~/.claude/skills/<name>/SKILL.md and emits one fittings/seed/<slug>/
 * (apm.yml + .apm/skills/<name>/ copied verbatim) per skill. Skips slugs that
 * already exist as seeds (never mutates an existing seed). With --adopt it also
 * records each emitted skill's already-on-disk artifact into the install lock
 * (the brown-field "import what I already have" bootstrap). Untagged hook groups
 * in settings.json are reported (faithful installable hook-fitting emission is a
 * documented follow-up; see docs/autothing/decisions.md).
 *
 * Usage:
 *   tsx scripts/import-claude-install.ts            # dry-run report
 *   tsx scripts/import-claude-install.ts --write    # actually emit fittings
 *   tsx scripts/import-claude-install.ts --write --adopt
 *   tsx scripts/import-claude-install.ts --write --prefix imported-
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { adoptFitting, type InstallManifest } from "../src/lib/claude-install";
import { parseFrontmatter } from "../src/lib/reconcile";

// Re-exported so existing importers of this script keep working; the canonical
// definition now lives in the reusable reconcile lib (EA3).
export { parseFrontmatter };

export interface ImportOpts {
  claudeHome: string;
  outDir: string;
  write: boolean;
  adopt: boolean;
  prefix: string;
  lockPath?: string;
}

export interface ImportReport {
  created: string[];
  skipped: string[];
  adopted: string[];
  untaggedHookGroups: number;
  table: string;
}

export async function runImport(opts: ImportOpts): Promise<ImportReport> {
  const created: string[] = [];
  const skipped: string[] = [];
  const adopted: string[] = [];

  const skillsDir = path.join(opts.claudeHome, "skills");
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const skillMd = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue; // plugin-only dir, no local SKILL.md

    const slug = `${opts.prefix}${name}`;
    const fittingDir = path.join(opts.outDir, slug);
    if (fs.existsSync(fittingDir)) {
      skipped.push(slug); // never mutate an existing seed
      continue;
    }

    if (opts.write) {
      const apmSkillDir = path.join(fittingDir, ".apm", "skills", name);
      await fsp.mkdir(apmSkillDir, { recursive: true });
      await fsp.cp(path.join(skillsDir, name), apmSkillDir, { recursive: true });

      const fm = parseFrontmatter(await fsp.readFile(skillMd, "utf8"));
      const description = String(fm.description ?? `Imported skill ${name}`).split("\n")[0].slice(0, 280);
      const manifest = {
        name: slug,
        version: "0.1.0",
        description,
        target: "claude",
        type: "skill",
        includes: "auto",
        "x-garrison": {
          faculty: "skills",
          cardinality_hint: "multi",
          component_shape: "skill",
          platforms: ["claude-code"],
          summary: description,
          provides: [{ kind: "agent-skill", name: slug }],
          verify: { command: `test -f .apm/skills/${name}/SKILL.md && echo ok`, expect: "ok" }
        }
      };
      await fsp.writeFile(path.join(fittingDir, "apm.yml"), yaml.dump(manifest, { lineWidth: 120 }), "utf8");
      created.push(slug);

      if (opts.adopt) {
        const m: InstallManifest = {
          fittingId: slug,
          source: `fittings/seed/${slug}`,
          artifacts: [{ target: `skills/${name}`, kind: "skill-dir" }]
        };
        const r = await adoptFitting(m, { claudeHome: opts.claudeHome, lockPath: opts.lockPath });
        if (r.ok) adopted.push(slug);
      }
    } else {
      created.push(slug); // dry-run: would-create
    }
  }

  // Report untagged hook groups (faithful hook-fitting emission deferred).
  let untaggedHookGroups = 0;
  try {
    const settings = JSON.parse(await fsp.readFile(path.join(opts.claudeHome, "settings.json"), "utf8"));
    for (const list of Object.values(settings.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const g of list) if (g && (g as { _garrison?: unknown })._garrison === undefined) untaggedHookGroups++;
    }
  } catch {
    // no settings / no hooks
  }

  const table =
    `created=${created.length} skipped=${skipped.length} adopted=${adopted.length} untagged-hook-groups=${untaggedHookGroups}`;
  return { created, skipped, adopted, untaggedHookGroups, table };
}

function parseArgs(argv: string[]): ImportOpts {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    claudeHome: get("--claude-home") ?? process.env.GARRISON_CLAUDE_HOME ?? path.join(os.homedir(), ".claude"),
    outDir: get("--out") ?? path.join(process.cwd(), "fittings", "seed"),
    write: argv.includes("--write"),
    adopt: argv.includes("--adopt"),
    prefix: get("--prefix") ?? ""
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runImport(opts);
  const mode = opts.write ? "WRITE" : "DRY-RUN (pass --write to emit)";
  console.log(`[import-claude-install] ${mode} — claudeHome=${opts.claudeHome} out=${opts.outDir}`);
  console.log(`  created:  ${report.created.join(", ") || "(none)"}`);
  console.log(`  skipped:  ${report.skipped.join(", ") || "(none)"}  (already-existing seeds)`);
  if (opts.adopt) console.log(`  adopted:  ${report.adopted.join(", ") || "(none)"}`);
  console.log(`  untagged hook groups in settings.json: ${report.untaggedHookGroups} (reported; emission deferred)`);
  console.log(`  ${report.table}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("[import-claude-install] failed:", err);
    process.exit(1);
  });
}
