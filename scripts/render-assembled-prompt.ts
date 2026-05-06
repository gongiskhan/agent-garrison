import { substituteCapabilitiesPlaceholder } from "../src/lib/runner";
import { readCompositionWithDerivedTasks, selectedLibraryEntries } from "../src/lib/compositions";
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const COMPOSITION_ID = process.argv[2] ?? "default";
  const composition = await readCompositionWithDerivedTasks(COMPOSITION_ID);
  const entries = await selectedLibraryEntries(composition.selections);

  const orchestratorEntry = entries.find((e) => e.faculty === "orchestrator");
  const soulEntry = entries.find((e) => e.faculty === "soul");
  if (!orchestratorEntry?.localPath) {
    console.error("no orchestrator selected");
    process.exit(1);
  }

  const orchestratorPath = path.join(
    process.cwd(),
    orchestratorEntry.localPath,
    ".apm",
    "prompts",
    "personal-operative.prompt.md"
  );
  const orchestratorPrompt = await fs.readFile(orchestratorPath, "utf8");
  const substituted = substituteCapabilitiesPlaceholder(orchestratorPrompt, entries);

  let soulPrompt = "";
  if (soulEntry?.localPath) {
    const soulPath = path.join(process.cwd(), soulEntry.localPath, ".apm", "prompts", "soul.prompt.md");
    soulPrompt = await fs.readFile(soulPath, "utf8");
  }

  const assembled = [substituted, "", soulPrompt].join("\n");
  const outPath = path.join(composition.directory, ".garrison", "assembled-system-prompt.md");
  await fs.writeFile(outPath, assembled, "utf8");
  console.log(`wrote ${outPath} (${assembled.length} chars)`);
}

main();
