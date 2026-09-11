#!/usr/bin/env -S npx tsx
import { captureHomesInventory, homesInventoryPath } from "../src/lib/homes-inventory";
const inventory = await captureHomesInventory();
console.log(JSON.stringify({ node: inventory.node, at: inventory.at, items: inventory.items.length, path: homesInventoryPath() }));
