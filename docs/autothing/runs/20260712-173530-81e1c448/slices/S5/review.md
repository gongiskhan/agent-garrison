# S5 — Garrison Assistant Fitting — fresh-context adversarial review

**Reviewer:** review-s5 (fresh context, own evidence, no access to implementer notes)
**Commits under review:** 9cb023b (fitting), ea9dab4 (tests), e52ca37 (own-port fix), + lint-fix
**Verdict: APPROVE**

## Acceptance (D7) — all met, verified live

A Fitting under the `sessions` role with three modes, all driven over its own port (booted at PORT=7098, GARRISON_REPO_ROOT=$PWD, IMPROVER_DATA=tmpdir).

### ANSWER — grounded Q&A with real sources, re-indexable
Three questions, each cited real, on-disk source files (verified every path with `readFileSync`/`test -f`):

1. `what is the runtimes faculty` → sources: `docs/autothing/runs/20260624-211241-c4fdc52a/FLOW_PLAN.md`, `docs/FACULTIES.md`
2. `how do I use the taste Fitting` → sources: `docs/autothing/runs/.../S1/review.md`, `fittings/seed/taste/apm.yml`, `docs/RUNTIME_MATRIX.md`
3. `how does composition switching work` → sources: `docs/autothing/runs/.../S4/impl.md`, `.../S4/review.md`, `docs/GARRISON_ROADMAP.md`

Adversarial nonsense query (`zzxqwjklborglefunctron qwzzz`) → `sources: []`, `"No indexed material matched ..."`. **Answer never fabricates a source.** Cited paths are always `path.relative(repoRoot, abs)` where `abs` is walked only under `root/docs` and `root/fittings/seed` (`index-store.mjs:48-58,72,79`), so they are structurally confined to the repo. `POST /reindex` → `{reindexed:2301}` (re-indexable confirmed live).

### GUIDE — launches tours by name, fails loud on unknown
- `POST /guide/launch-tour {name:"switch-composition"}` → `{"launch":true,"name":"switch-composition","route":"/","fitting":"shell","mode":"guided","url":"/?tour=switch-composition"}`
- `POST /guide/launch-tour {name:"totally-made-up-tour"}` → **HTTP 404** with `known:["quarters-basics","compose-a-fitting","clone-a-fitting","switch-composition"]` (`tours.mjs:36-46` throws with the known list; server maps to 404).

### BUILD — adaptive interview → provenance-`assistant` proposals, never mutates artifacts
Drove `POST /interview/next` through a full loop (CI-flavored answers). **4 adaptive questions asked**: `daily`, `byhand`, `repeat`, then the branched `byhand_detail` = *"For that check, should it run on every commit, on a schedule, or only when you ask?"* — the CI branch triggered by `byhand="ran lint and tests manually"`. Independently confirmed the follow-up genuinely branches (4 distinct outputs live): report answer → *"who reads it and how often"*; deploy answer → *"what has to be TRUE before it's safe"*; generic answer → the default trigger question.

Filed exactly **2 proposals**, both `provenance:"assistant"`, `status:"pending"`, all standard fields (`id,rule,targetClass,claim,diff,decision,applyVia,status,at`):
- `assistant-skill-assist-run-the-test-suite-and-review-dif-000000` — `targetClass: quarters/skill`
- `assistant-automation-auto-ran-lint-and-tests-manually-before--000000` — `targetClass: automations/job`

Both landed in `$IMPROVER_DATA/review-queue.json` (queue length 2, both provenance=assistant, both pending) plus per-proposal `proposals/<id>.json`. `find $IMPROVER_DATA -type f` shows **only** those 3 files — the interview wrote nothing else.

### Approvable in the Improver UI
`GET /api/queue` returns `loadQueue()` verbatim (`improver/scripts/server.mjs:274-279`; `loadQueue` just JSON-parses — `review-queue.mjs:13-20`), so the assistant's directly-written proposals pass through with every field including `provenance`. The UI's `ProposalCard` renders each queue item with **Approve/Reject** driven by `status` (`improver/ui/main.tsx:63-102`): a `pending` item enables both. The assistant bypasses the Improver's `enqueue` (which would drop `provenance`) by writing the queue file directly; `saveQueue`/`markApplied`/`markRejected` spread-preserve extra fields, and Run Now only `enqueue`s NEW proposals, so provenance survives a subsequent Improver cycle.

## Adversarial checklist
- **Answer cites a non-existent source?** No — every cited path verified on disk; sources structurally confined to repo.
- **Interview mutates an artifact?** No — `proposals.mjs` only writes `review-queue.json` + `proposals/<id>.json` under `improverDataDir()` (`IMPROVER_DATA` or `~/.garrison/improver`). The proposal `diff` is an inert JSON blob describing the draft; nothing applies it. Confirmed: only 3 files written, all under IMPROVER_DATA.
- **proposals.mjs writes outside the improver dir?** No — `queueFile()`/`proposalsDir()` both under `improverDataDir()`; `atomicWriteJson` mkdir's the dirname of targets that are always under it.
- **Server touches an Anthropic/any endpoint?** No — grep across `lib/scripts/dist` finds only comments saying "no Anthropic endpoint". The only HTTP is `node:http` `createServer` (serving); no `fetch`/`http.request`/`undici`/`axios`. Answer is deterministic keyword+section retrieval.
- **Index build leaks files outside the repo?** No — `walkMarkdown` descends only under `root/docs` + `root/fittings/seed`, reads only `.md` and `apm.yml` summaries.

## Gate evidence I ran myself
- `npm run typecheck` → **exit 0**
- `npm test -- tests/garrison-assistant.test.ts tests/own-port-canonical-port.test.ts tests/own-port-start.test.ts tests/seed.test.ts` → **49 passed (4 files)**
- `npx tsx scripts/validate-fitting.ts fittings/seed/garrison-assistant` → **Overall PASS** (architecture/security/prompt-injection/quality)
- Registered in `data/library.json:514` and `compositions/default/apm.yml` (dep + selection).

## Non-blocking observations (do NOT gate S5)
1. **UI surface is a placeholder stub, and `GET /` returns health JSON, not the HTML.** `dist/index.html` (6 lines) only *describes* the API — no forms/fetch/buttons — and the own-port server's `GET /` returns the health JSON (`server.mjs:63-65`), so the sidebar's live link to the own-port root shows raw JSON rather than a usable surface. garrison-assistant is also not in the static fitting-views registry. The interactive UI + tour engine are explicitly deferred to WS6 (`tours.mjs:2-5`), and D7 requires the three *modes* to work (they do, via API + `for_consumers`), so this is a UI-completeness gap, not a functional miss. Worth closing in WS6/WS9.
2. **Shared-file write race with the Improver server (low severity).** Both the assistant and the improver server do read-modify-write on the same `review-queue.json`; each write is atomic (temp+rename) but an interleaving could lose an update. Inherent to the Improver's existing file-queue design and single-user/local, so low risk — but the assistant does introduce a second writer.
3. **Approving an assistant proposal isn't fully wired.** `applyVia` says "Quarters skill authoring after approval", but the Improver's `doApply` runs the generic `applyWithRetry` against `targetFileFor()` with the JSON-blob `diff`. Worst case it returns 409 and stays pending — it never causes the assistant to edit an artifact — but the actual skill/automation authoring-on-approval is a future wiring gap. Acceptance only requires the proposal be visible/approvable, which holds.

None of the three change the verdict: the D7 acceptance is functionally complete and independently verified.
