#!/usr/bin/env node
// Retire Omi cloud while retaining the Garrison phone/BLE capture settings.
// Artifacts and historical source records are deliberately left on their owner.
import { parseDocument, isSeq, isMap } from "yaml";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { createStateClient } from "../packages/garrison-state-client/index.mjs";

export function retireOmiManifest(manifestYaml) {
  const doc = parseDocument(manifestYaml);
  if (doc.errors.length) throw new Error("Invalid composition YAML");
  let changed = false;
  const selections = doc.getIn(["x-garrison", "composition", "selections"]);
  let retired;
  let capture;
  if (isMap(selections)) {
    for (const pair of selections.items) {
      if (!isSeq(pair.value)) continue;
      for (const item of pair.value.items) {
        if (isMap(item) && item.get("id") === "omi-channel") retired = item;
        if (isMap(item) && item.get("id") === "capture-service") capture = item;
      }
    }
    if (retired && capture) {
      const previous = retired.get("config")?.toJSON?.() ?? {};
      if (!capture.has("config")) capture.set("config", doc.createNode({}));
      const config = capture.get("config");
      if (!isMap(config)) throw new Error("Capture configuration must be a map");
      for (const key of ["triage_enabled", "triage_cron", "triage_batch_cap", "allowed_categories", "blocked_folders", "drop_discarded", "tips_enabled", "tips_max_per_day"]) {
        if (Object.hasOwn(previous, key) && !config.has(key)) config.set(key, doc.createNode(previous[key]));
      }
      if (Object.hasOwn(previous, "classify_target") && !config.has("triage_classify_target")) config.set("triage_classify_target", previous.classify_target);
    }
    for (const pair of selections.items) {
      if (!isSeq(pair.value)) continue;
      const kept = pair.value.items.filter(item => !(isMap(item) && item.get("id") === "omi-channel"));
      if (kept.length !== pair.value.items.length) { pair.value.items = kept; changed = true; }
    }
  }
  const deps = doc.getIn(["dependencies", "apm"]);
  if (isSeq(deps)) {
    const kept = deps.items.filter(item => {
      const dep = item?.toJSON?.() ?? item;
      const value = typeof dep === "string" ? dep : dep?.path ?? "";
      return !/(?:^|\/)omi-channel\/?$/.test(value) && !/^gongiskhan\/garrison-omi-channel(?:#.*)?$/.test(value);
    });
    if (kept.length !== deps.items.length) { deps.items = kept; changed = true; }
  }
  return { changed, manifestYaml: changed ? doc.toString() : manifestYaml };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const finalize = process.argv.includes("--finalize");
  const client = createStateClient({
    env: { ...process.env, GARRISON_HOME: process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison") },
    readFileSync
  });
  for (const row of await client.listCompositions()) {
    const comp = await client.getComposition(row.id);
    const result = retireOmiManifest(comp.manifestYaml);
    if (!result.changed) continue;
    console.log(`${apply ? "retiring" : "would retire"} Omi from composition ${row.id} at rev ${comp.rev}`);
    if (apply) await client.putComposition(row.id, result.manifestYaml, { ifMatchRev: comp.rev });
  }
  if (finalize) {
    if (!apply) throw new Error("--finalize requires --apply; deploy Capture immediately afterwards");
    const jobs = await client.listSchedulerJobs();
    for (const job of jobs.filter(job => job.id === "omi-triage" || (job.id.startsWith("omi-triage-") || job.id.startsWith("omi-triage@")))) {
      await client.deleteSchedulerJob(job.id, { ifMatchRev: job.rev });
      console.log(`removed scheduler job ${job.id}`);
    }
    const keys = await client.listSecretKeys();
    for (const entry of keys) {
      const key = typeof entry === "string" ? entry : entry.key;
      if (!key?.startsWith("OMI_")) continue;
      await client.deleteSecret(key);
      console.log(`removed retired credential ${key}`);
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
