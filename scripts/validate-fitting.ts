import { validateFitting } from "../src/lib/validation";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: tsx scripts/validate-fitting.ts <fitting-path>");
    process.exit(2);
  }

  const report = await validateFitting(target);

  console.log(`Fitting:  ${report.fittingId}`);
  console.log(`Path:     ${report.fittingPath}`);
  console.log(`Ran at:   ${report.ranAt}`);
  console.log(`Overall:  ${report.overall.toUpperCase()}`);
  console.log("");

  for (const check of report.checks) {
    const status = check.passed ? "PASS" : "FAIL";
    console.log(`[${status}] ${check.name}`);
    for (const note of check.notes) {
      console.log(`       note: ${note}`);
    }
    for (const err of check.errors) {
      console.log(`       error: ${err}`);
    }
  }

  process.exit(report.overall === "pass" ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
