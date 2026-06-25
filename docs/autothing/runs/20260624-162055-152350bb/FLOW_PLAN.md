# Flow Plan — Kanban Loop V1b

Run: `20260624-162055-152350bb` · project: kanban-loop-v1b
Build the dormant V1a kanban engine into a running, full-pipeline Kanban Loop with a
responsive phone-first board, the cross-model Codex passes as their own lists, a new
`autothing-validate` verb, the gateway hint honored in both modes, and the web channel
grown into the one generic context-driven chat surface.

Code wins over docs. Briefs: `BRIEF/kanban-loop-v1b-build-brief.md` (15 FINDINGs + final
`KANBAN-LOOP-V1B OK`), `BRIEF/kanban-loop-wireframe-v4.html`, `BRIEF/kanban-loop-design-state.md`,
`~/.garrison/kanban-loop/implementation-state.md`, `~/.garrison/kanban-loop/autothing-skills-survey.md`,
`BRIEF/BRIEF-garrison-modes-fitting.md`.

## Verify-first resolutions (decided — do not re-investigate)
- **autothing-implement loads only what it is handed** ("does not inherit the lead's context"). garrison-architecture carries real doctrine (surface-wiring page→component→/api→lib→Sidebar; host-config IO: read-fresh→mutate→write-whole, one-writer, base-path injection) NOT in CLAUDE.md → rehome to `docs/architecture.md`, hand it to Implement via the execute-prompt; retire `garrison-*` only after parity is confirmed on one real Implement slice.
- **walkthrough video** → `~/.walkthrough/runs/<project>/[folder/]<ts>/final.mp4`, served Tailscale `:8099`; `card.videoUrl` = that link.
- **transcript** → `~/.claude/projects/-Users-ggomes-dev-garrison/<sessionId>.jsonl` (helper `claudeProjectDirForCwd`, `packages/claude-pty/src/paths.mjs`).
- **Watch**: pooled gateway operative is NOT tmux-attachable (raw node-pty) → Watch streams the card log via SSE for live runs, opens web-chat for interactive lists, shows static linked logs otherwise. (Honest correction to the wireframe's `tmux attach`.)
- **runId**: engine threads `runDir` through the execute-prompt TEXT (gateway `skill` field is inert); autothing-plan honors a caller path; adversarial verbs take `<runDir>`; `autothing-validate` must be created.
- **souls-mode** `/chat` (`gateway.mjs ~:548`) drops the hint → fix via a testable `souls-route.mjs` helper (parse `body.classification` + `resolveRoute` → thread tier/role into the orchestrator turn). PTY mode already honors it.

## Slices

| # | Slice ID | Title | Kind | Area / owns | Parallel group | Status |
|---|----------|-------|------|-------------|----------------|--------|
| 1 | arch-doctrine-rehome | Rehome garrison-architecture doctrine into docs | mixed | `docs/architecture.md` | P0 | passed |
| 2 | autothing-validate-verb | Create the standalone `autothing-validate` verb | mixed | `~/.claude/skills/autothing-validate/`, `tests/autothing-validate.test.ts` | P0 | passed |
| 3 | gateway-souls-hint | Honor the classification hint in BOTH gateway modes | mixed | `fittings/seed/http-gateway/scripts/lib/souls-route.mjs`, `…/gateway.mjs`, `tests/gateway-souls-hint.test.ts` | P0 | passed |
| 4 | kanban-engine-v1b | New lists, triggers, runId threading, card pointers, Test batching, scheduler beat | mixed | `fittings/seed/kanban-loop/{lib/engine.mjs,lib/board.mjs,scripts/kanban.mjs,apm.yml}`, `tests/kanban.test.ts` | P1 (after P0) | passed |
| 5 | kanban-install-tick | Install fitting into a composition + scheduler tick | mixed | `compositions/default/apm.yml` (+ `apm.lock.yaml`) | P2 (after P1) | passed |
| 6 | kanban-board-ui | Own-port server + responsive phone-first board UI | ui | `fittings/seed/kanban-loop/{scripts/server.mjs,ui/**,dist/**}` | P2 (after P1) | passed |
| 7 | web-channel-generic-context | Generic context + read-aloud + doc render | ui | `fittings/seed/web-channel-default/{scripts/server.mjs,ui/main.tsx,ui/styles.css,dist/**}`, `packages/claude-chat/src/ClaudeChat.tsx` | P2 (after P1) | passed |
| 8 | discuss-james-brief | Discuss → James-mode web chat → brief-to-disk, linked, manual advance | mixed | `fittings/seed/kanban-loop/scripts/discuss.mjs`, `tests/kanban-discuss.test.ts` | P3 (after F,G) | passed |
| 9 | parity-and-shim-retire | Confirm doc parity on one slice, then retire `garrison-*` shims | mixed | `.claude/skills/garrison-*`, model-router discipline map | P4 (last) | passed |

Status: pending | in_progress | passed | blocked. Mirror of each slice's gate-status.json.

## Acceptance per slice (cite FINDING #s)
- **arch-doctrine-rehome**: `docs/architecture.md` carries the surface-wiring pattern + host-config IO discipline that the generic `autothing-implement` reads in place of the area skill. garrison-architecture NOT yet deleted. [FINDING 15 prereq]
- **autothing-validate-verb**: skill runs standalone given `<runDir> <sliceId>`; reads gate-status + evidence-index, checks the DoD incl. a `verified` walkthrough video, writes durable markers, ends with a parseable last line `Done` (DoD holds) or `Implement` (fails). Show both. [FINDING 9]
- **gateway-souls-hint**: with the souls / mcp-gateway stack present, an in-vocab `{taskType,tier}` hint resolves to the correct tier/role (unit-tested helper + wired into `gateway.mjs` `/chat` and `/chat/stream`); a malformed hint falls back to classify. PTY mode unchanged. [FINDING 11]
- **kanban-engine-v1b**: seed board has the full pipeline `Backlog→To Do→Discuss→Plan→Implement→Review→Adv Review→Test→Adv Test→Walkthrough→Validate→Done` (+ needs-attention) with kind/trigger/skill/classification/validNext populated; Plan/Implement/Review repointed to `autothing-*`; Adv lists use `autothing-adversarial-*`; Validate→`autothing-validate`; Backlog infers title eagerly, project only ≥70% else parks; Start→Plan mints `runId`+`runDir`, threads `runDir` into every execute-prompt, auto-moves to Implement; agent reply's exact last line = one `validNext` id (pass moves fwd, fail/no-match/cap → loop to Implement / park); Test batches a project's waiting cards in one session on a scheduler beat; new card fields `runId/runDir/sliceId/sessionIds[]/briefPath/videoUrl`, no inlined bodies; iteration cap is the convergence guard. [FINDINGs 2,3,4,5,7,10]
- **kanban-install-tick**: `kanban-loop` is a dependency of a composition and a scheduler job ticks it; print the composition dependency line + the scheduler job. [FINDING 1]
- **kanban-board-ui**: own-port server (`:7087`, `~/.garrison/ui-fittings/kanban-loop.json`, embedded `/embed/kanban-loop`) serving `/board`,`/cards`, start/advance/move, watch SSE + artifact-link serving; responsive phone-first React board (card front Start/Advance·Move·Watch·Open; detail shows the decision-10 links + decision log); shows a card's `videoUrl` link and surfaces the Adv-Review `CODEX CALL` line in Watch. [FINDINGs 12, 8, 10, 6]
- **web-channel-generic-context**: web channel accepts an opaque `context` blob + `mode` (James selectable), threads both to `/chat/stream`; offers read-aloud via the proxied voice fitting; renders/links a produced document as markdown. Stays generic (no kanban/dev-env knowledge); `src/app/run/page.tsx` + spike chat-harness untouched. [FINDING 14]
- **discuss-james-brief**: Discuss opens the web-channel chat in James mode carrying the card as context, produces a brief under `briefs_path`, sets+links `card.briefPath`, manual advance to Plan; print the brief path + the card link. [FINDING 13]
- **parity-and-shim-retire**: one real `autothing-implement` slice run against `docs/architecture.md` (no area skill handed in) passes the review+adversarial gates → parity confirmed; ONLY then delete the `garrison-*` shims and fix references; print the parity result. [FINDING 15]

## Parallelism
- **P0** (arch-doctrine-rehome, autothing-validate-verb, gateway-souls-hint) — fully file-disjoint (docs / external skill dir / gateway) → build concurrently via agent teams.
- **P1** (kanban-engine-v1b) — solo; owns the whole fitting `lib/` + `scripts/kanban.mjs` + `apm.yml`. Depends on B (Validate references the verb) and A (Implement execute-prompt references the doc); soft-depends on D.
- **P2** (kanban-install-tick, kanban-board-ui, web-channel-generic-context) — disjoint after C (composition / kanban scripts+ui / web-channel). **C owns `apm.yml` exclusively** — F must not edit it (own_port:true, default_port:7087, UI build step, Test scheduler-beat all land in C).
- **P3** (discuss-james-brief) — after F+G; isolated as its own `scripts/discuss.mjs` so it never edits F's `server.mjs`.
- **P4** (parity-and-shim-retire) — last; depends on A,B,C,D,E,F,G,H.

Critical path: `A,B,D → C → E,F,G → H → I`. Max parallel width 3.

## Evidence kind per slice
- **Real walkthrough video (UI)**: F (board responsive + video link + CODEX CALL surfaced + card links), G (doc render + read-aloud), H (Discuss interactive flow).
- **asciinema / committed-assertion only**: B (verdict lines), C (board table, park, runId, batched run, card.json), D (unit test), E (dep + job lines), I (parity line).

## Serialization risks (flagged)
- C↔F on `apm.yml` → C owns it exclusively.
- F↔H on `server.mjs` → H ships a separate `discuss.mjs` module F imports; if H must edit the route table, serialize H strictly after F.
- D must NOT touch `gateway-pty.mjs` (already correct) or `gateway-routing.mjs` (shared core) — only `gateway.mjs` + new `souls-route.mjs`.

## Global acceptance
All 15 FINDINGs printed + final `KANBAN-LOOP-V1B OK`. Tracked in `<runDir>/evidence-index.json → globalGate`. Every UI slice (F,G,H) has a `verified` walkthrough video; every slice has a clean Codex `approve` + Codex Playwright `pass`; build/typecheck/lint/e2e exit 0.
