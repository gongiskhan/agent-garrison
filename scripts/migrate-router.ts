import path from "node:path";
import { migrateRouterConfig } from "../src/lib/router-migrate";

// Router-config -> duties migrator CLI (MARATHON-V3 S3c).
//   npx tsx scripts/migrate-router.ts <compositionDir>
// Folds <compositionDir>/.garrison/routing.json into composition v4 duties on
// <compositionDir>/apm.yml, emits a sibling composition per non-active profile,
// backs routing.json up to routing.json.v3.bak, and prints the diff. Idempotent
// (refuses if the .v3.bak marker exists). See src/lib/router-migrate.ts.

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npx tsx scripts/migrate-router.ts <compositionDir>");
    process.exit(2);
  }
  const compositionDir = path.resolve(target);

  const result = await migrateRouterConfig(compositionDir);

  if (result.skipped) {
    console.log(`SKIPPED (idempotent): ${result.reason}`);
    process.exit(0);
  }

  const fold = result.activeFold!;
  console.log(`Router -> duties migration`);
  console.log(`  composition dir : ${compositionDir}`);
  console.log(`  routing.json    : ${result.routingJsonPath}`);
  console.log(`  backup          : ${result.backupPath}`);
  console.log(`  active profile  : ${result.activeProfile}`);
  console.log("");

  console.log(`Targets (effort shed, deduped): ${fold.targets.length}`);
  for (const t of fold.targets) {
    const bits = [t.runtime, t.provider, t.model].filter(Boolean).join(" / ");
    console.log(`  - ${t.id}  (${bits})${t.params ? `  params: ${Object.keys(t.params).join(",")}` : ""}`);
  }
  console.log("");

  console.log(`Duties (${fold.duties.length}) - selected_duties (${fold.selectedDuties.length} wired):`);
  for (const duty of fold.duties) {
    const selected = fold.selectedDuties.includes(duty.id);
    const cells = duty.levels
      .map((lvl, i) => {
        const c = lvl.cell ?? {};
        const parts = [c.target ?? "-", c.effort ?? "-"];
        if (c.skill) parts.unshift(`skill:${c.skill}`);
        return `L${i + 1}[${parts.join("/")}]`;
      })
      .join(" ");
    console.log(`  ${selected ? "[x]" : "[ ]"} ${duty.id}  ${cells}`);
  }
  console.log("  ([x] = in selected_duties / wired; [ ] = retained-only, restored on reselection)");
  console.log("");

  if (fold.disciplineRefs.length) {
    console.log("By-name discipline refs rewritten:");
    for (const ref of fold.disciplineRefs) {
      console.log(
        `  ${ref.tier} ${ref.field} = "${ref.value}"  ->  {duty: ${ref.resolved.duty}, level: ${ref.resolved.level}}  (${ref.note})`
      );
    }
    console.log("");
  }

  if (result.siblings.length) {
    console.log(`Sibling compositions emitted (${result.siblings.length}):`);
    for (const sibling of result.siblings) {
      console.log(`  - ${sibling.id}  ${sibling.apmPath}  (selected: ${sibling.selectedDuties.length})`);
    }
    console.log("");
  }

  if (result.violations.length) {
    console.log(`Cell-compatibility violations (${result.violations.length}):`);
    for (const v of result.violations) {
      console.log(`  - [${v.profile}] ${v.duty} L${v.level}: ${v.error.message}`);
    }
    console.log("");
  } else {
    console.log("Cell-compatibility: no violations.");
    console.log("");
  }

  console.log("apm.yml diff:");
  console.log(result.diff);

  process.exit(0);
}

main().catch((error) => {
  console.error(`migrate-router failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
