# FLOW_PLAN — Add a multiply function with a test

Project: flow-scratch (/home/ggomes/dev/flow-scratch)
Run: 01KX7RCN0NSE1TGS40CNDBC1K8
Slice S1: add a `multiply` function alongside the existing `add`.

## Approach
- `src/multiply.mjs` exports `multiply(a, b)`, mirroring the shape of `src/add.mjs`.
- `test/multiply.test.mjs` covers the happy path and the zero case, using `node:test`
  like the existing `test/add.test.mjs`.

## Acceptance (machine-checkable)
- `npm test` (node --test) passes, with the new multiply tests included.
- `npm run lint` passes.
- `multiply(3, 4) === 12` and `multiply(7, 0) === 0`.
