#!/usr/bin/env -S npx tsx
import { captureHomesInventory, homesInventoryPath } from "../src/lib/homes-inventory";
async function main() {
  const inventory = await captureHomesInventory();
  console.log(JSON.stringify({ node: inventory.node, at: inventory.at, items: inventory.items.length, path: homesInventoryPath() }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
