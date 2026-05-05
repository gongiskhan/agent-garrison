import { refreshDefaultPrompts } from "../src/lib/compositions";

async function main(): Promise<void> {
  const id = process.argv[2] ?? "default";
  const { orchestratorPath, soulPath } = await refreshDefaultPrompts(id);
  console.log(`Refreshed default prompts for composition: ${id}`);
  console.log(`Overwrote: ${orchestratorPath}`);
  console.log(`Overwrote: ${soulPath}`);
  console.log("Restart the operative (Stop → Run) for the new prompts to take effect.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
