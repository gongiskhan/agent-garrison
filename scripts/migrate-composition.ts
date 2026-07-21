import path from "node:path";
import { migrateCompositionV3ToV4 } from "../src/lib/composition-migrate";

// v3 -> v4 composition migrator CLI.
//   npx tsx scripts/migrate-composition.ts <compositionDir>
// Backs up apm.yml -> apm.yml.v3.bak, stamps schema: 4, extracts machine-local
// values into local.yml, and prints the unified diff. Refuses to run twice.
async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npx tsx scripts/migrate-composition.ts <compositionDir>");
    process.exit(2);
    return;
  }

  const compositionDir = path.resolve(target);
  const result = await migrateCompositionV3ToV4(compositionDir);

  if (result.skipped) {
    console.error(result.reason);
    process.exit(1);
    return;
  }

  process.stdout.write(result.diff);
  process.stdout.write("\n");

  if (result.localYml) {
    console.log(`\n=== created ${path.basename(result.localPath)} ===\n`);
    process.stdout.write(result.localYml);
  } else {
    console.log("\n(no machine-local values extracted; no local.yml created)");
  }

  console.log(`\nBacked up original -> ${result.backupPath}`);
  console.log(`Wrote schema: 4 -> ${result.apmPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
