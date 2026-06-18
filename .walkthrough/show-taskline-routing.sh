#!/usr/bin/env bash
# Show the orchestrator's routing for the taskline cross-model build — which
# RUNTIME and MODEL handled each step (read-only view of the live decision log).
cd /Users/ggomes/dev/garrison || exit 1
echo "Garrison orchestrator — taskline build: which model built each file (.garrison/decisions.jsonl):"
echo
node -e '
const fs=require("fs");
const lines=fs.readFileSync("compositions/default/.garrison/decisions.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
const res=lines.filter(d=>!("honored" in d));
const label={ "ex-build-schema":"1. data model   src/model.mjs ", "ex-build-helper":"2. id helper    src/id.mjs    ", "ex-build-core":"3. core store   src/store.mjs ", "ex-review":"4. code review  (read store)  ", "ex-fixes":"5. apply fix    src/store.mjs ", "ex-test":"6. tests + CLI  test+cli.mjs  " };
const order=["ex-build-schema","ex-build-helper","ex-build-core","ex-review","ex-fixes","ex-test"];
const byEx={}; for(const d of res){ if(d.matchedException) byEx[d.matchedException]=d; }
for(const ex of order){ const d=byEx[ex]; if(!d) continue;
  console.log(`  ${label[ex]} -> ${String(d.targetId).padEnd(15)} runtime=${String(d.runtime).padEnd(11)} provider=${String(d.provider).padEnd(13)} model=${d.model}`);
}
'
