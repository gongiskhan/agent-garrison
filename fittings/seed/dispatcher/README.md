# dispatcher

The **Dispatcher** — a duty (`kind: duty`, `name: dispatch`) that replaces the
tier classifier (MARATHON-V3 D6). It is the routing brain in the
duties-and-levels vocabulary.

## What it does

Given the resolved composition model (`{ duties, selectedDuties }`) and an
inbound message, the Dispatcher picks a **(duty, level)** pair with a confidence
note. The pick is made by **one single-shot, structured `garrison-call`** on a
small fast model — no tool loop, no session, never a primary. Code, not the
model, does the clamping, the human override, and the resolution to a leaf cell.

Because it reads the composition's *own* duties, adding a duty needs **no
Dispatcher change** — the vocabulary is discovered, not hardcoded.

## Contract

```
dispatch(model, message, opts) ->
  { duty, level, confidence, reason, overridden, overrideSource, dispatchOk, callError, evidence }
```

- `opts.call` — the `garrison-call` invoker `(spec) => Promise<{ok, structured|text|error}>` (required; injected for tests).
- `opts.shape` / `provider` / `model` — the default dispatch cell (a small fast model).
- `opts.cardLevel` — a card-level explicit `level` field (human override).
- `opts.evidenceFile` — the decisions log the routing-evidence line is appended to.

The resolution of a `(duty, level)` to a concrete leaf cell `{skill, target,
effort}` is the Resolver's job (`src/lib/resolver.ts` `resolveSequence`); this
fitting only produces the `(duty, level)`.

## Human override

An explicit **"run at level N"** in the message, or a card-level `level` field,
**always** wins over the Dispatcher's chosen level. The duty is kept (the human
is overriding *depth*, not *what the work is*); the message instruction beats the
card field when both are present; the level is clamped into the duty's real range.

## Routing evidence

Every dispatch logs `{ kind: "dispatch", at, messageDigest, duty, level, reason }`
to the decisions log — the **raw message is never stored**, only its SHA-256
digest (the same shape as the gateway's `promptDigest`).

## Parity with the classifier (assumption 5)

- `buildDispatchPrompt` / `parseDispatch` mirror the classifier's
  `buildClassifierPrompt` / `parseClassification` (list the whole vocabulary,
  ask for single-line JSON, clamp out-of-vocab to the standard slot, `null` only
  on total failure).
- A `(duty, level)` resolves through the migrated duties model to the **same
  `(runtime, model, effort)`** the old `(task-type, tier)` matrix produced —
  proven exhaustively over the full seed matrix in
  `tests/dispatcher-parity.test.ts`.
- **Classifier retention:** live classification-accuracy parity of a small model
  against the pinned haiku classifier is not established on-box, so the dedicated
  classifier session is **kept as the documented live default** (D6 pre-authorizes
  retention — retirement is not forced). The Dispatcher lands fully tested and
  ready to promote; the gateway exposes an opt-in `dispatchRoute()` (default off).

## Verify

```
node scripts/dispatch.mjs --probe    # -> "ok" (no network)
```
