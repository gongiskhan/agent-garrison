#!/usr/bin/env bash
# Show the orchestrator's routing decisions for the multi-step build workflow —
# which RUNTIME and MODEL handled each step (read-only view of the live log).
cd /Users/ggomes/dev/garrison || exit 1
echo "Garrison orchestrator — multi-step build workflow routing (.garrison/decisions.jsonl):"
echo
node -e '
const fs=require("fs");
const lines=fs.readFileSync("compositions/default/.garrison/decisions.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
// resolution records only (drop the honored-check QA records that carry an "honored" field)
const res=lines.filter(d=>!("honored" in d));
const label={ "ex-build-schema":"1. build: data model ", "ex-build-helper":"2. build: helper     ", "ex-build-core":"3. build: core algo  ", "ex-review":"4. review            ", "ex-fixes":"5. apply fixes       ", "ex-test":"6. test              " };
const order=["ex-build-schema","ex-build-helper","ex-build-core","ex-review","ex-fixes","ex-test"];
// last occurrence of each step, in workflow order
const byEx={}; for(const d of res){ if(d.matchedException) byEx[d.matchedException]=d; }
for(const ex of order){ const d=byEx[ex]; if(!d) continue;
  console.log(`  ${label[ex]} → ${String(d.targetId).padEnd(15)} runtime=${String(d.runtime).padEnd(11)} provider=${String(d.provider).padEnd(14)} model=${d.model}`);
}
'
