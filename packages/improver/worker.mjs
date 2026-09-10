#!/usr/bin/env node
import fs from "node:fs/promises";
import { ImprovementStore } from "./src/store.mjs";
import { runReview } from "./src/service.mjs";
import { applyProposal, reconcileOutcomes } from "./src/authoring.mjs";
import { runNightly } from "./src/nightly.mjs";

const file = process.argv[2];
const { context, run } = JSON.parse(await fs.readFile(file,"utf8"));
const store = new ImprovementStore();
context.apply = (proposal, action) => applyProposal(context,proposal,action);
try {
  await reconcileOutcomes(store,context);
  const result = run.mode === "nightly" ? await runNightly({store,context,run}) : await runReview({store,context,run});
  console.log(JSON.stringify({id:run.id,status:result.status}));
} catch(error) { console.error(error.stack || error.message); process.exitCode = 1; }
