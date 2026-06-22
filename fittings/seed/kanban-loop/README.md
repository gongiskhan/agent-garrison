# kanban-loop (V1a engine)

A workflow state machine wearing a Kanban board. **Cards** are work items; **lists**
are pipeline states; an **agent-list**'s router-prompt is the transition function.
It composes the orchestrator (preRoute), skills, and the heartbeat — it does **not**
become a runtime framework (compose, don't own). V1a is the engine; the board UI is
V1b.

## Storage (`~/.garrison/kanban-loop/`, override `GARRISON_KANBAN_DIR`)
- `board.json` — list defs + order + per-list config (never membership).
- `cards/<ulid>/card.json` — title, project, list, status, iterations, goalMode, ts.
- `cards/<ulid>/log-N.md` — per-iteration logs.

ULID ids (so concurrent drops never race), atomic writes (temp + rename),
read-immediately-before-write on every mutation. **List membership is derived by
scanning cards — never stored.**

## Engine (`lib/engine.mjs`)
A **manual** list is a plain column. An **agent** list has a named `skill` +
`executePrompt` + `routerPrompt`. On entry the engine builds the combined prompt and
sends it through the orchestrator front door (an injected `runFn` = preRoute /
gateway `/chat`), then the router output must **exactly** name one of the card's
valid next lists (no fuzzy matching, no guessing) or the card parks in
`needs-attention`. A per-card **iteration cap** breach also parks it.

## §9 decisions (accepted)
- **Effort/model are the router's job** — no per-list model; the engine sends a
  `{taskType,tier}` classification (§10) and preRoute resolves the target.
- **Skill is explicit per list** (one skill-decider per list, one effort/model
  decider in the router — no overlap).
- **Suppress the router's continuations** under kanban (the list boundary is the
  gate — no double-gating).
- **No Infer column** — low-confidence inference parks in `needs-attention`.
- **Adversarial = higher effort**, not a separate skill.

## Goal-mode
A `goalMode` card on an implement-type list has the engine prepend `/goal` + the
card's acceptance (lifted from `FLOW_PLAN.md`); execute-prompts stay clean.

## CLI
`node scripts/kanban.mjs --setup | --probe | --tick`. `--tick` dispatches due
immediate agent-list cards through `GARRISON_GATEWAY_URL` (`/chat` → preRoute).
