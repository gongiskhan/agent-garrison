Design complete. I read the engine, board storage, policy reader, board server, CLI/tick, coord-mcp server + intent-store + agentmail liveness, discover.mjs, the RUN_SPEC assumptions ledger (A1-A4 bind directly on this design), and the UI badge precedents. Here is the S1/S2 coordination-engine design.

# GARRISON-FLOW-V2 S1+S2 — Coordination engine design

## Architecture in one paragraph

Three new libraries inside kanban-loop — `lib/coordination.mjs` (touch-sets, overlap scoring, ordering/wait predicates, availability, ledger writer), `lib/fences.mjs` (git fence commits, attribution, prepared revert), `lib/coord-mail.mjs` (mail abstraction) — plus surgical hooks at the engine's three transition seams, dispatch choke points in `kanban.mjs`/`server.mjs`, a `coordination` section in policy.json (with code defaults so an un-recompiled policy still works), and a waiting badge in the board UI. Git (via `Garrison-Card:` trailers) is the source of truth for attribution; cards cache fence shas for convenience only. The coord-mcp intents ledger is a *file protocol*, not a code dependency: the engine writes rows in its wire format directly (spawning a stdio MCP server per tick would be waste), so interactive Claude sessions using coord-mcp see kanban cards' claims in their digests for free.

---

## Q1 — Touch-set artifact

**Location:** `<runDir>/touch-set.json`, sibling of `FLOW_PLAN.md`.

**Who writes it:** the plan phase *skill* writes the file (it knows the prediction); the *engine* validates + registers it (A4: skills never own cross-card coordination). No board migration needed for the prompt: `buildCardPrompt` in `engine.mjs` appends the touch-set instruction at dispatch time when `phase === "plan"` and coordination is enabled — the same pattern as the existing runDir threading (engine.mjs:296-300), so existing boards' `executePrompt` config is untouched.

**Schema (version 1):**

```json
{
  "version": 1,
  "cardId": "<ULID>", "runId": "<ULID>", "project": "<label>",
  "predictedAt": "<ISO>",
  "files": ["src/lib/foo.ts"],
  "dirs": ["src/routes/"],
  "surfaces": ["policy.json:coordination", "board:lists"],
  "exclusive": ["package-lock.json"],
  "notes": "free text"
}
```

`files` are exact repo-relative paths; `dirs` are prefix claims; `surfaces` are named non-file contention points (config keys, DB tables, ports); `exclusive` is the D6 lease list.

**Enforcement:** when `coordination.enabled`, `touch-set.json` becomes part of the plan phase's durable evidence — the plan→implement advance parks if it's missing/invalid, exactly in the style of the existing `gateEvidenceMissing` branch (engine.mjs:644-659). When coordination is disabled or policy absent, no check. A card that somehow reaches implement without a touch-set (quick cards skip plan) is treated as serialized against all other live same-project cards — the conservative honest rule.

**Registration:** on plan completion the engine appends a row to `~/.garrison/coord/intents/<repoSlug>.jsonl` in the coord-mcp wire format (intent-store.mjs:27-34) with extra keys the readers ignore: `{repo, session: "kanban:<cardId>", area: <card title>, files: [...files, ...dirs], reason, ts, cardId, runId, kind: "touch-set"}`. `repoSlug` = sha1(resolved repo path).slice(0,16) — reimplemented (~8 lines) with a comment naming `coord-mcp/scripts/lib/repo.mjs` as the contract. The `kanban:<cardId>` session key makes release deterministic: on terminal/abandon the engine rewrites the ledger dropping that session's rows (same as `removeIntentsBySession`). **The engine's own overlap computation does NOT read the ledger** — it reads live cards' `<runDir>/touch-set.json` directly (cards carry runDir; live = same project, on a non-terminal list). The ledger is the outward-facing registry for non-kanban sessions.

## Q2 — Overlap scorer

**Location:** pure function in `lib/coordination.mjs`:

```js
scoreOverlap(a, b, thresholds) // → { grade: "none"|"light"|"medium"|"heavy",
                               //     sharedFiles, sharedDirs, sharedSurfaces }
```

Normalize to posix-relative paths, then:
- **heavy** — any shared path in both `exclusive` lists; or shared exact files ≥ `thresholds.heavyFiles` (default 3); or shared files ≥ `thresholds.heavyRatio` (default 0.5) of the smaller set.
- **medium** — ≥1 shared exact file, ≥1 shared surface, or one card's file falls under the other's dir claim.
- **light** — dir claims overlap (prefix relation) but no shared files/surfaces.
- **none** — otherwise.

**Policy shape** (new top-level `coordination` key in `~/.garrison/orchestrator/policy.json`; `DEFAULT_COORDINATION` constant in coordination.mjs supplies every default so S1/S2 don't depend on the S6 composer work):

```json
"coordination": {
  "enabled": true,
  "thresholds": { "heavyFiles": 3, "heavyRatio": 0.5 },
  "fences": { "enabled": true, "trailer": "Garrison-Card" },
  "leaseTtlMinutes": 60,
  "serializeWhenUnavailable": true
}
```

**Two computation points (D1):**
1. **Card creation** — `handleCreateCard` (server.mjs:768) fires `computeProvisionalOverlap` fire-and-forget, same pattern as `runProjectInference`. If the card already has a touch-set (resumed run) it scores for real; otherwise, when other live same-project cards exist, it records an honest `coordination` event: "provisional — no touch-set yet, overlap will be computed when Plan completes". D9 serialization (Q8) applies here regardless.
2. **Plan completion** — inside `processCard`'s post-verdict moved branch when the from-list phase is `plan` (and mirrored in `advanceCardPhase`; plan is never batched). A new `applyPlanCompletionCoordination({board, card, allCards, policy, now})` reads+validates touch-set.json, registers the ledger intent, scores against every other live same-project card's touch-set, and produces either the normal advance or a **wait** (Q4). The earlier/later order is total and acyclic: earlier = the card whose plan completed first (persisted as `planCompletedAt`; ties broken by runId ULID), so no deadlock is possible.

Grades → actions (D3): **light** = proceed in parallel + courtesy mail (Q9) + `coordination` event on both cards; **medium** = later card waits `until: "stability"` of the earlier; **heavy** = later card waits `until: "terminal"`. The decision + reason is recorded as a `coordination` event on BOTH cards (the blocker's written with the CAS-retry `updateCard` helper, which moves from server.mjs into `board.mjs` so the engine can use it).

## Q3 — Stability event (D2)

One helper, `stabilityFields(card, phase, effectiveNext, now)` in coordination.mjs, called at **all three seams** E3 identified so the predicate lives once:

- `processCard` moved branch (engine.mjs:610-643),
- `advanceCardPhase` (engine.mjs:811-826),
- `processBatch` moved branch (engine.mjs:1008-1035) — review is never batched today, but parity is cheap and E3 demands it.

Predicate: `phase === "review" && effectiveNext !== "implement" && !card.stabilityAt`. Returns `{ stabilityAt: now(), event: {kind: "stability", message: "Stability point: first review passed — overlapping cards waiting on stability may start"} }`, folded into the same CAS write as the move (no extra write, no race — matching the mint-fold precedent at engine.mjs:433-459). Idempotent via the `!card.stabilityAt` guard. When fences are enabled the same advance also records `stabilityCommit: <fence sha>` (Q5).

**Gate re-check:** waiting cards are re-evaluated by `reevaluateWaiting({root, board, cards, now})` called at the top of `tick()` / `tickList()` (kanban.mjs) and before dispatch in `handleStartCard` / the auto-dispatch path. Predicate cleared when: `until:"stability"` and blocker has `stabilityAt`; `until:"terminal"` and blocker is on a terminal list, abandoned, or deleted; `until:"fence"` and the offender has recorded a fence newer than the one noted at detection (Q6). On release: CAS-move the card to `waitingOn.thenTo` (or re-dispatch in place when `waitingOn.rerun`), clear `waitingOn`, `released` events on both cards.

## Q4 — Wait / badge mechanism

**Card fields** (file-per-card JSON tolerates new keys; no migration):

```js
waitingOn: {
  cardId, cardTitle,          // the blocker
  grade,                      // "medium" | "heavy" | "interference" | "lease"
  reason,                     // human text incl. the shared files summary
  until,                      // "stability" | "terminal" | "fence"
  thenTo,                     // deferred advance target ("implement"), or
  rerun,                      // true → re-dispatch current phase instead of moving
  offenderFenceSha,           // for until:"fence" (Q6)
  since                       // ISO
} | null,
stabilityAt: ISO | null,
planCompletedAt: ISO | null,
blocking: [cardIds],          // UI convenience on the blocker, best-effort
fences: [{phase, sha, at, empty}],
preparedRevert: {...} | null  // Q7
```

The key mechanic: when the plan advance decides "wait", the engine does **not** move the card — it CAS-saves `waitingOn` (plus `planCompletedAt`, the registered touch-set) and returns outcome `{status: "waiting"}`. The card **sits in Plan** (D3) with its gate evidence already written, so the later release is a pure engine move to `thenTo` — Plan is never re-run.

**Dispatch skip:** `tick()`/`tickList()` (kanban.mjs:284-294, 330-337) and `processBatch` acquisition add `if (card.waitingOn) continue` next to the existing `status === "running"` skip; `processCard` gets a belt-and-suspenders early return. `processChain` needs no change — a `"waiting"` outcome isn't `"moved"`, so the chain stops naturally (engine.mjs:728). **Manual Start on a waiting card = explicit override**: `handleStartCard` clears `waitingOn` with a recorded `"wait overridden manually"` event and dispatches — no new endpoint, and the escape hatch is a deliberate button press.

**UI:** `cardSummary` (server.mjs:113-163) adds `waitingOn`, `stabilityAt`, `blocking`. In `ui/main.tsx`, next to the existing parked callout (main.tsx:210-215) render `card.waitingOn && <div className="state-callout waiting">Waiting on {shortId/title}: {reason} (until {until})</div>` plus a chip in the chips row (main.tsx:168 precedent); blocker cards get a small "blocks N" chip. `.state-callout.waiting` variant in `ui/styles.css` (amber, distinct from the parked red). Text labels only, no emoji.

## Q5 — Commit fences (D5)

**Where:** `lib/fences.mjs`, `commitFence({repoPath, card, phase, touchSet, now})`, invoked in the same three moved-branch seams as stability, **before** the CAS card save (so the sha folds into the same write; on a CAS conflict the commit still exists and git remains authoritative). Fences fire on every successful advance out of an agent phase for a card with a runDir, when `coordination.fences.enabled`.

**Repo resolution:** `repoPathForProject(project, board)` in coordination.mjs: `board.projects[label].path` if set → an absolute-path label that exists → `listProjects(readDevRoot())` name lookup (discover.mjs:35-51, the same source the project picker uses). Unresolvable → fences skipped for the card with an honest `fenceError` event, never a park.

**Scoped staging (A2 — the load-bearing part):** `execFileSync("git", ["add", "--", ...paths])` with paths = the touch-set's `files` + `dirs` that exist on disk. **Never `-A`.** `git add <dir>` stages tracked *and untracked* files under a claimed dir — exactly the wanted scope. Then `git diff --cached --quiet`: nothing staged → no commit; record `{phase, sha: <current HEAD>, at, empty: true}` so the attribution anchor chain never has gaps. Arg-vector exec only, no shell; plain `git commit` respecting repo config (no `--no-verify`); any git failure → `fenceError` event + continue (fences degrade visibly, attribution then reports the gap as "unattributable" rather than blaming anyone).

**Message format:**

```
garrison(<project>): <phase> fence — <card title ≤50 chars>

Garrison-Card: <cardId>
Garrison-Run: <runId>
Garrison-Phase: <phase>
```

**Dirty-tree honesty:** files modified outside every live card's touch-set are left uncommitted, and the fence records a warning event listing them ("out-of-touch-set changes present, not fenced, unattributable"). The implement dispatch prompt (buildCardPrompt, coordination-enabled branch) instructs the operative to stay inside the declared touch-set and to *update touch-set.json first* if it needs more — the fence re-reads touch-set.json each time; growth triggers re-registration + re-scoring (a not-yet-implementing later card can newly wait; two already-implementing cards get an interference-risk event + courtesy mail, never a retroactive block).

**Leases (D6):** before dispatching implement for a card whose touch-set has `exclusive` entries, acquire a local lease file `~/.garrison/coord/leases/<repoSlug>/<sha1(path)>.json` (`O_EXCL` create — the `withFileLock` pattern from board.mjs:156-197 with a `leaseTtlMinutes` TTL, renewed at each fence, released on advance past implement or terminal). Held by another live card → `waitingOn {until: "lease"}`. Mirrored into agent-mail `file_reservation_paths` when it's up so external sessions see it; the local file is primary (works when agent-mail is absent — A1).

## Q6 — Attribution (D5/D7)

**Trigger points:** whenever a gate phase's verdict is the fail edge (`next === "implement"` from review/test/adversarial-review/adversarial-test/validate) and other live cards share the project — in `processCard`, `advanceCardPhase`, and per-card inside `processBatch` (which **is** the D7 red-beat path: attribution runs before the implement loop-back is applied).

**Algorithm** (`attributeBreakage({repoPath, victimCard, liveCards})` in fences.mjs):
1. Anchor = victim's last fence sha (`card.fences`); no anchor → return `unknown` (normal loop-back).
2. `git log <anchor>..HEAD --format=%H%x00%B` — partition commits by parsed `Garrison-Card:` trailer into own / foreign(cardId) / unattributed.
3. For each foreign commit, `git show --name-only` its files; intersect with the victim's touch-set claims (files + dir prefixes). Non-empty intersection → interference candidate; offender = that trailer's card.
4. Return `{verdict: "foreign"|"own"|"mixed"|"unknown", offenderCardId, commits, overlapFiles}`.

**On `foreign`:** the victim does **not** loop to implement (D5's core promise). Instead: `interference` event; `waitingOn = {cardId: offender, grade: "interference", until: "fence", offenderFenceSha: <offender's latest fence>, rerun: true, reason: "…broken by card X commits <shas> touching <files>"}`; the consumed iteration is refunded (`iterations - 1`, floored, recorded honestly in the event — foreign breakage must not eat the victim's cap). The offender gets an `interference` event + mail (Q9) with the shas and files, copied into **both** runDirs (D4). Release: the offender's next fence (its fix landing) clears the predicate and the victim re-dispatches the *same* phase in place. `own`/`unknown`/`mixed` → today's behavior unchanged.

## Q7 — Abandonment revert (D8)

**Flow:** new `POST /cards/:id/abandon` (originAllowed; human-only — engine header not accepted). The engine: builds the descriptor from `git log --grep="Garrison-Card: <cardId>" --format=%H` (trailer-attributed commits only, newest first); computes `conflictRisk` (files in those commits later touched by other cards' commits); writes it durably to `<runDir>/coordination/prepared-revert.json` AND onto `card.preparedRevert`; releases the card's ledger intents + leases; parks it in needs-attention with `attentionReason: "Abandoned — prepared revert of N commits ready; confirm to apply"`. Terminal-waiters on it are released (abandon counts as terminal).

**Descriptor:**

```json
{ "cardId": "…", "project": "…", "repoPath": "…",
  "commits": ["sha…"], "preparedAt": "…",
  "conflictRisk": [{"sha": "…", "files": ["…"]}],
  "state": "prepared" }
```

**Confirm endpoint:** `POST /cards/:id/revert` with body `{confirm: true}` required (anything else 400) — executes `git revert --no-edit <shas>` newest-first in repoPath; the revert commits carry `Garrison-Card: <cardId>` + `Garrison-Revert: true` trailers. Conflict → `git revert --abort`, descriptor `state: "conflict"`, honest event + 409; **never auto-applied, never retried silently**. Success → `state: "applied"` + event; the card stays in needs-attention for the user to archive.

## Q8 — D9 availability detection + serialize fallback

**Probe** (`coordinationAvailability()` in coordination.mjs, cached ~5s like loadPolicy): coordination is *available* iff (a) `policyLoadState() !== "corrupt"`, and (b) the file substrate works — `mkdir -p` the ledger dir + O_EXCL write/rm a probe file under `~/.garrison/coord/`. **agent-mail being down does NOT trigger D9** — the file-record mail fallback (Q9) keeps the protocol honest; D9 fires only when coordination state cannot be persisted at all (or the policy is corrupt, matching the engine's existing corrupt-policy fail-safe posture at engine.mjs:592-595).

**Serialize gate:** `serializeGate(cards, card)` — when coordination is enabled but unavailable (and `serializeWhenUnavailable`, default true), a card may dispatch only if no *other* same-project card is live (on an agent list with `status === "running"` or a minted runDir and non-terminal). Oldest ULID wins. Enforced at the same choke points as the waitingOn skip (tick, tickList, Start, auto-dispatch, batch acquisition). Blocked cards get a one-time `deferredReason`-style field (the `lastDispatchError` pattern, server.mjs:928-939) — "serialized: coordination degraded, one live card per project" — not an event per tick (no timeline spam). Cards without a touch-set at implement time get the same gate (Q1).

## Q9 — Mail abstraction

`lib/coord-mail.mjs`, `sendCoordMail({fromCard, toCard, subject, body})`:

1. **Always first** — durable records into **both** runDirs: `<runDir>/coordination/mail/<ulid>.json` (`{id, at, fromCardId, toCardId, subject, body, transport}`) via `atomicWriteJSON`. This is the evidence (D4) and it never depends on agent-mail.
2. **Then try agent-mail** — read `~/.garrison/ui-fittings/coord-agentmail.json` and POST `send_message` to its `mcpUrl` (the exact liveness/streamable-http pattern proven in coord-mcp's `agentmail.mjs:30-43,73-113`; identities `kanban:<cardId>`; 2.5s timeout). Success → `transport: "agent-mail"`, else `"file"` — recorded honestly in both copies.
3. Append a `mail` event to both cards and a `kind: "mail"` row to the intents ledger so external sessions' digests surface it.

So the courtesy notice (light overlap), the interference notice, and the offender notification all function with agent-mail absent (which it is on this box — A1); nothing mail-related degrades to D9 serialization. The one thing lost without agent-mail is push visibility to non-kanban sessions, which the ledger row partially covers.

## Q10 — Unit tests (vitest, repo-root `tests/`, `.mjs` imports with `@ts-ignore`, env-sandboxed via `GARRISON_KANBAN_DIR`/`GARRISON_HOME`/`GARRISON_RUNS_DIR`/`GARRISON_POLICY_PATH` + `mkdtempSync` — the exact conventions of `tests/kanban-dispatch.test.ts`)

| File | Covers |
|---|---|
| `tests/coordination-overlap.test.ts` | scoreOverlap grades (none/light/medium/heavy), threshold overrides, dir-prefix vs exact-file, exclusive escalation, touch-set schema validation, no-touch-set → serialize predicate |
| `tests/coordination-ordering.test.ts` | S1 end-to-end: two cards + fake runFn; plan completion scores vs live card, medium→waits-for-stability, heavy→waits-for-terminal, events on both cards, `cardSummary` surfaces waitingOn/stabilityAt, tick skips waiting cards, `reevaluateWaiting` releases, D9 broken-substrate serializes |
| `tests/coordination-stability.test.ts` | `stabilityFields` at all three seams (processCard / advanceCardPhase / processBatch), idempotence, review→implement does NOT emit |
| `tests/coordination-fences.test.ts` | real temp git repo: scoped staging leaves the foreign dirty file unstaged, trailer format, empty-fence HEAD anchor, touch-set growth re-registration event |
| `tests/coordination-attribution.test.ts` | scripted trailer commits: own/foreign/unattributed partition, failing-path→offender mapping, victim gets interference wait + iteration refund (never loops to implement), offender mail lands in both runDirs, red-batch (D7) path |
| `tests/coordination-revert.test.ts` | descriptor = exactly the trailer commits, conflictRisk, `{confirm:true}` required, revert executes / conflict aborts cleanly, abandon releases intents + terminal-waiters |
| `tests/coordination-mail.test.ts` | file-fallback writes both runDir records + ledger row, transport honesty; agent-mail path against a stub HTTP server honoring the status-file contract |

Slice split: **S1** = Q1-Q4 + Q8 (tests 1-3 + ordering); **S2** = Q5-Q7 + Q9 (tests 4-7). New event kinds: `stability`, `coordination`, `interference`, `fence`, `mail` — all within the existing `withEvent`/`MAX_EVENTS` mechanics.

---

## Critical Files for Implementation

**New:**
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/coordination.mjs` — touch-set IO/validation, scorer, ordering, wait predicates, availability probe, serialize gate, ledger writer, repoPathForProject, stabilityFields
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/fences.mjs` — commitFence, attributeBreakage, prepareRevert/executeRevert (all git via execFileSync arg-vectors)
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/coord-mail.mjs` — sendCoordMail with agent-mail/file-record dual transport
- `tests/coordination-{overlap,ordering,stability,fences,attribution,revert,mail}.test.ts`

**Modified:**
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/engine.mjs` — hooks at processCard moved branch (~L610), fail-edge attribution (~L545/610), advanceCardPhase (~L811), processBatch (~L1008), buildCardPrompt plan/implement coordination lines (~L296), waitingOn early return
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/board.mjs` — move/expose the CAS-retry `updateCard` helper for cross-card event writes
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/scripts/kanban.mjs` — tick/tickList waiting-skip + reevaluateWaiting + serialize gate
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/scripts/server.mjs` — cardSummary projection, create-time provisional overlap, Start override, `/abandon` + `/revert` endpoints, dispatch gates
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/ui/main.tsx` + `ui/styles.css` — waiting callout/chips (parked-callout precedent at main.tsx:168, 210-215)
- `~/.garrison/orchestrator/policy.json` — new `coordination` section (code defaults in coordination.mjs; composer surfacing is S6)

**Read-only contracts to honor:**
- `/home/ggomes/dev/garrison/fittings/seed/coord-mcp/scripts/lib/intent-store.mjs` — ledger wire format (rows appended must parse for `intentsOverlap`)
- `/home/ggomes/dev/garrison/fittings/seed/coord-mcp/scripts/lib/repo.mjs` — repoSlug derivation
- `/home/ggomes/dev/garrison/fittings/seed/coord-mcp/scripts/lib/agentmail.mjs` — agent-mail status-file + streamable-http pattern to replicate
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/discover.mjs` — project→repo-path source
- `/home/ggomes/dev/garrison/fittings/seed/kanban-loop/lib/policy.mjs` — loadPolicy/policyLoadState pattern for the coordination section
- `/home/ggomes/dev/garrison/docs/autothing/runs/20260710-171608-7bf26feb/RUN_SPEC.md` — assumptions A1-A4 this design implements
