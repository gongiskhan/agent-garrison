// Push a composition's committed apm.yml to the mesh state service.
//
// The state service, not git, is the source of truth for a composition's
// shared files: up() on every node materialises apm.yml FROM the service and
// only Muster edits flow back (src/app/api/muster/model.ts -> pushManifestToState).
// A manifest change that arrives through git therefore changes nothing on any
// node until it is pushed here - up() overwrites the working tree with the
// service copy on the next run. This script is that push, for a manifest edited
// in the checkout on purpose.
//
//   tsx scripts/state-push-composition.ts <composition-id> [--dry-run]
//
// It refuses when the working-tree manifest differs from HEAD (an un-committed
// or service-materialised edit is not an intent), shows the diff against the
// service copy, and writes with rev CAS - a 409 means another node edited the
// composition meanwhile; re-run after looking at what changed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { pushManifestToState } from "../src/lib/composition-sync";
import { stateClient } from "../src/lib/state-client";

async function main(): Promise<void> {
  const [compositionId, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  if (!compositionId) {
    console.error("usage: tsx scripts/state-push-composition.ts <composition-id> [--dry-run]");
    process.exit(2);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const relManifest = path.join("compositions", compositionId, "apm.yml");
  const manifestPath = path.join(repoRoot, relManifest);

  const committed = execFileSync("git", ["show", `HEAD:${relManifest}`], { cwd: repoRoot, encoding: "utf8" });
  const working = await readFile(manifestPath, "utf8");
  if (working !== committed) {
    console.error(
      `${relManifest} differs from HEAD. Commit the intended manifest first (or 'git checkout -- ${relManifest}' ` +
        "to drop a service-materialised copy); this script pushes the committed one."
    );
    process.exit(1);
  }

  const current = await stateClient().getComposition(compositionId);
  if (!current) {
    console.log(`service has no copy of "${compositionId}"; up() will seed it from this tree.`);
    process.exit(0);
  }
  if (current.manifestYaml === committed) {
    console.log(`service copy of "${compositionId}" (rev ${current.rev}) already matches HEAD.`);
    process.exit(0);
  }

  const servicePath = path.join(os.tmpdir(), `garrison-state-${compositionId}-rev${current.rev}.apm.yml`);
  await writeFile(servicePath, current.manifestYaml, { mode: 0o600 });
  console.log(`service rev ${current.rev} -> HEAD:`);
  try {
    execFileSync("diff", ["-u", "--label", "service", "--label", "HEAD", servicePath, manifestPath], {
      stdio: "inherit"
    });
  } catch (err) {
    // diff exits 1 when the inputs differ; that is the expected path here.
    if ((err as { status?: number }).status !== 1) throw err;
  }
  if (dryRun) {
    console.log("dry run; nothing pushed.");
    process.exit(0);
  }
  const out = await pushManifestToState(compositionId, committed);
  console.log(out.pushed ? `pushed; service rev ${out.rev}.` : "node not enrolled; nothing pushed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
