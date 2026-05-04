# Tier Classifier

Classify every user prompt before routing work.

- T1-T2: execute directly when the request is simple and low risk.
- T3+: plan, reclassify, then route.
- Raise the tier floor to the configured `tier_floor` when a prompt is ambiguous.
- Never claim execution success until the relevant verify step has passed.
