# S4 acceptance gap #10 — the flow runs end to end on a scratch non-Garrison project

**Verdict: PASS**, with one real (low-severity) Garrison-self assumption found and reported below.

Date: 2026-07-11. Repo under test: `/home/ggomes/dev/flow-scratch` (a throwaway Node repo:
ESM, `node --test`, no Garrison anything). Never pushed; worked on its default branch
(`master`); no branches created.

## What actually ran

The **real run engine** (`fittings/seed/kanban-loop/lib/engine.mjs`) — `processCard` for the
dispatched phases and `advanceCardPhase` for the in-process doorway (D13) — against a
**sandboxed** board:

| knob | value |
| --- | --- |
| `GARRISON_KANBAN_DIR` | `<scratchpad>/gap10/kanban` |
| `GARRISON_HOME` | `<scratchpad>/gap10/home` |
| `GARRISON_RUNS_DIR` | `<scratchpad>/gap10/runs` |
| `GARRISON_POLICY_PATH` | a **copy of the LIVE compiled policy** (`~/.garrison/orchestrator/policy.json`) |

so the real `garrison-*` phase-skill bindings, work kinds, phase plans and the coordination
section (fences on, `Garrison-Card` trailer, exclusive leases) were all in force. The live
`~/.garrison` board/runs/coord were never written (the live `board.json` mtime is unchanged
and its 2 cards are untouched); everything the run produced landed in the sandbox.

Project resolution pointed at the foreign repo via `board.projects["flow-scratch"].path =
/home/ggomes/dev/flow-scratch`, which is the first branch of `repoPathForProject`
(`lib/coordination.mjs:252`) — no dependency on `~/.garrison/dev-root`.

The card: **"Add a multiply function with a test"**, work kind **`full-feature`** (phase plan
`full`, 11 phases), tier `T1-standard`, goal mode on. The operative was a stub that *behaved*
like an operative — it did each phase's real work in the scratch repo and returned the phase
verdict; it never faked a gate:

- **plan** — wrote `FLOW_PLAN.md` + `touch-set.json` (predicting `src/multiply.mjs`,
  `test/multiply.test.mjs`) and the `plan` gate entry.
- **implement** — really wrote the two files into flow-scratch, ran `node --check`.
- **review / adversarial-review** — real export-surface probe, gate entries with verdicts.
- **test** — really ran the repo's own `npm test` (`node --test`) + `npm run lint`, wrote the
  exit codes and real output into the gate entry.
- **adversarial-test** — an independent probe (`node -e`, *not* the committed test file)
  asserting the acceptance directly.
- **walkthrough** — wrote a real `evidence/evidence.md` (the diff, the fence commit, the real
  test output). No video: the change is a headless library with no visual surface, which the
  Walkthrough list's own prompt explicitly allows ("do NOT force a video").
- **validate** — done through the **in-process doorway** (`advanceCardPhase`): the session
  checked every gate itself, wrote `evidence-index.json` + the `validate` gate record, then
  advanced with the `done` verdict under the same D9 contract as the dispatched path.

## Phase path

```
todo -> plan -> implement -> review -> adversarial-review -> test -> adversarial-test
     -> walkthrough -> validate -> done          (done = terminal; 7 dispatches, cap 10)
```

No park, no needs-attention, no interference, `status=ok`. The `security-review` phase is OFF
in this rail (not in the `full` phase plan) and was recorded off, never silently passed.

## What was proven

1. **Terminal list reached** — the card ended on `done` (`terminal: true`), not parked.
2. **Run artifacts exist** under the sandbox runs home, outside the repo (D19) — see
   `runDir/`: `FLOW_PLAN.md`, `touch-set.json`, `slices/S1/gate-status.json` (8 gate entries:
   plan, implement, review, adversarialReview, test, adversarialTest, walkthrough, validate),
   `evidence-index.json`, `evidence/evidence.md`. **D9 was genuinely enforced** — every
   transition required its durable gate entry in addition to the verdict.
3. **Real commits with `Garrison-Card` trailers** in flow-scratch — the fence path
   (`lib/fences.mjs`) committed *only* the touch-set paths on a real foreign repo:

   ```
   b7e1af2 garrison(flow-scratch): implement fence - Add a multiply function with a test
   Garrison-Card:  01KX7RCN0FRGY4SFB7GEKDJ2JT
   Garrison-Run:   01KX7RCN0NSE1TGS40CNDBC1K8
   Garrison-Phase: implement
   ```

   containing exactly `src/multiply.mjs` + `test/multiply.test.mjs` — i.e. **touch-set
   enforcement is real**: the scoped `git add`/`git commit --only` committed the predicted
   paths and nothing else. The other seven phases produced correct **empty fence anchors**
   (nothing dirty within the touch-set), so `anchor..HEAD` stays gapless. Worktree clean
   afterwards; still on `master`; no branch created; nothing pushed.
4. **The test suite passes** — `npm test` in flow-scratch: **3 tests, 3 pass, 0 fail** (the
   original `add` test plus the two new `multiply` tests); `npm run lint` exits 0. See
   `flow-scratch-test-output.txt`.
5. **Coordination substrate worked on a foreign repo** — the touch-set was registered as an
   intent row keyed by `sha1(/home/ggomes/dev/flow-scratch)[:16]`, the stability point fired
   at the first clean review, and the **terminal cleanup removed the intent rows** when the
   card reached `done` (the ledger file is empty at the end).

## Garrison-self assumptions: one surfaced

I grepped every artifact the run produced (`runDir/*`, `card.json` events + park reasons,
the card logs) **and every prompt the engine handed the operative** (`prompts.json`) for
Garrison-repo paths, ports, fitting names and platform nouns.

**FINDING (real, low severity) — the Implement prompt hardcodes `docs/architecture.md`.**
`fittings/seed/kanban-loop/scripts/kanban.mjs:37` defines `const ARCH_DOC =
"docs/architecture.md"` and line 77 injects it into every Implement dispatch:

> "Read the plan + acceptance from the run directory and the architecture doc at
> **docs/architecture.md**; follow existing conventions; …"

flow-scratch has no `docs/` directory at all. This is a Garrison-repo/foundation convention
leaking into a foreign project's implement prompt. It did **not** fail the run (a real
operative would find nothing there and move on), but it is exactly the class of assumption
gap #10 exists to catch. Suggested fix: make the architecture-doc pointer conditional (only
inject when the file exists in the project root), or resolve it from the project's own
foundation rather than a constant.

**Not findings** (checked and classified benign):

- `garrison-plan` / `garrison-implement` / … in the dispatch prompts and card events — the
  policy's phase→skill bindings. These are *platform* skills, correct on any project.
- `~/.garrison/orchestrator/policy.json` (7 prompt references) — the control plane's own
  home, not a repo assumption.
- `Garrison-Card` / `Garrison-Run` / `Garrison-Phase` trailers and the `garrison(<project>):`
  commit subject now in flow-scratch's history — by design (the trailer is the attribution
  mechanism and is policy-configurable via `coordination.fences.trailer`).
- No Garrison ports (7777/7089/7086/…), no fitting names, no `apm.yml`/`x-garrison`, no
  `docs/autothing`, no `src/lib/` paths appeared anywhere in the artifacts or prompts.

## Files here

| file | what it is |
| --- | --- |
| `runDir/` | the run directory the engine produced (plan, touch-set, gate-status, evidence-index, evidence) |
| `flow-scratch-git-log.txt` | git log of the foreign repo, showing the fence commit + trailers + its file list |
| `flow-scratch-test-output.txt` | `npm test` + `npm run lint` output after the run (3/3 pass) |
| `card.json` | the final card (list `done`, 7 iterations, 8 fence records) |
| `events.txt` | the card's event timeline (dispatch / routed / fence / stability) |
| `prompts.json` | every prompt the engine handed the operative — the corpus for the assumption grep |
| `drive-trace.txt` | the harness's console trace |
| `drive.mjs` | the harness — re-runnable; boots the sandbox, seeds the board, drives the real engine |
