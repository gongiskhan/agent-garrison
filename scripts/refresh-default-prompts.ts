import { refreshDefaultPrompts } from "../src/lib/compositions";

async function main(): Promise<void> {
  const id = process.argv[2] ?? "default";
  const { orchestratorPath } = await refreshDefaultPrompts(id);
  console.log(`Refreshed the default Orchestrator prompt for composition: ${id}`);
  console.log(`Overwrote: ${orchestratorPath}`);
  console.log("Restart the composition (Stop → Run) for the new prompts to take effect.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
