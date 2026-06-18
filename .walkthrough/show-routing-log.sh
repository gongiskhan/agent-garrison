#!/usr/bin/env bash
# Show the Garrison orchestrator's routing decisions — what RUNTIME and MODEL
# handled each turn (read-only observation of the live decisions log).
cd /Users/ggomes/dev/garrison || exit 1
echo "Garrison orchestrator — routing decisions (.garrison/decisions.jsonl):"
echo
tail -4 compositions/default/.garrison/decisions.jsonl | node -e '
const ls = require("fs").readFileSync(0, "utf8").trim().split("\n");
for (const l of ls) {
  const d = JSON.parse(l);
  const rt = d.runtime === "agent-sdk" ? "agent-sdk  (Claude Agent SDK)" : "claude-code (Max-plan PTY)";
  console.log(`  ${String(d.role).padEnd(9)} -> ${String(d.targetId).padEnd(15)}  runtime=${String(d.runtime).padEnd(11)}  provider=${String(d.provider).padEnd(14)}  model=${d.model}`);
}
'
