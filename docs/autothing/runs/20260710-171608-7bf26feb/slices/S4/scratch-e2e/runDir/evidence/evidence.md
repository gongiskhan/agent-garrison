# Evidence — Add a multiply function with a test

Project: flow-scratch (/home/ggomes/dev/flow-scratch) — a plain Node repo, not the Garrison repo.

## What changed
- `src/multiply.mjs` (new): exports `multiply(a, b)`.
- `test/multiply.test.mjs` (new): two node:test cases.

Landed as the implement fence commit:

```
b7e1af2 garrison(flow-scratch): implement fence - Add a multiply function with a test
Garrison-Card: 01KX7RCN0FRGY4SFB7GEKDJ2JT
Garrison-Run: 01KX7RCN0NSE1TGS40CNDBC1K8
Garrison-Phase: implement


 src/multiply.mjs       |  3 +++
 test/multiply.test.mjs | 11 +++++++++++
 2 files changed, 14 insertions(+)
```

## How it was verified (real commands, real output)
`npm test` in /home/ggomes/dev/flow-scratch:

```
  ---
  duration_ms: 0.15004
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 70.567473
```

Independent acceptance probe (adversarial-test phase): `multiply(3,4)=12`, `multiply(7,0)=0`.

No visual surface on this change (headless library), so no screenshot/video was forced.
