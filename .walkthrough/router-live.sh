#!/usr/bin/env bash
# Live model-router config API: active profile + the deterministic role->target
# resolution for a few task-type/tier cells. Real curls against the running
# own-port server (:7087); no test runner, no mocks.
set -e
echo "active profile: $(curl -s http://127.0.0.1:7087/routing | jq -r '.config.activeProfile')"
echo "profiles:       $(curl -s http://127.0.0.1:7087/routing | jq -r '.config.profiles | keys | join(", ")')"
echo
for body in '{"taskType":"code","tier":"T2-deep"}' '{"taskType":"review","tier":"T1-standard"}' '{"taskType":"image","tier":"T1-standard"}'; do
  curl -s -X POST http://127.0.0.1:7087/simulate -H 'content-type: application/json' -d "$body" \
    | jq -r '"  \(.classification.taskType)/\(.classification.tier)  ->  role=\(.route.role)   target=\(.route.targetId)"'
done
