---
name: garrison-project-viewer
description: Analyse a codebase into end-to-end flow manifests and serve them in the Project Viewer — a navigator organised by flows rather than by file structure, with no diagrams and no screenshots. Modes: full-run (first analysis, intake-gated), update (re-anchor after commits, re-narrate only what moved), fix-findings, compare (static reading vs what actually executed), generate-tests, walkthrough (narrate one commit), cleanup (consolidate docs then remove originals — always asked). Use for "analyse this project", "explain this codebase", "update the project view", "walk me through this commit", or when a Project Viewer button dispatches a card naming a mode.
---

# Project Viewer

You turn a repository into a set of **end-to-end flows** a human or an agent can
read quickly, and you keep them honest as the code moves.

A flow is a narrative: the start of an operation through to its end. Not a graph,
not a file tree, not a diagram. Graphs show everything at once and are unreadable;
a flow shows only what matters, in order.

## The four rules

These are not style preferences. Breaking any of them makes the output worse than
nothing, because a reader who cannot trust one sample cannot trust any.

**1. Never type code. Ever.**
Every code sample is extracted mechanically by `lib/samples.mjs`, which reads
`git show <sha>:<path>`, slices the lines, and records the sha256 of exactly what
it extracted. You choose the file, the line range, and which lines to highlight.
You write the prose. You do not produce code text, not even to "fix up" an
indentation. The renderer re-computes that hash against the repository before it
displays anything, and shows an integrity error instead of code when it does not
match — so a hand-written sample does not become documentation, it becomes a
visible failure with your name on it.

**2. The spine comes from execution, not from your reading.**
Run the thing, then narrate what ran. Reading code and guessing the call order is
how you get a confident, wrong document. See "Getting a spine" below.

**2b. Highlight the climax, not the setup.**
The band is your one editorial act on a sample, so spend it on the line where the
thing actually happens — the call that can throw, the branch that decides, the
assignment the rest depends on. Lines that merely set up the interesting line are
context: leave them visible in the window, unbanded. A band spread over the whole
window says "all of this matters equally", which is the same as saying nothing.
Rule of thumb: if you cannot say in one clause why a banded line is banded, unband
it.

**3. Collapse, never omit.**
Trivial plumbing gets `kind: "glue"` and `collapsed: true`, which renders as a
one-line row that expands on click. It stays in the document. An agent following
a flow must never reach a dead end because you decided a step was boring.

**4. No diagrams, no screenshots.**
Not anywhere. Instead of a screenshot of a page, show the view code with a
description. Anyone who wants a diagram can generate one separately.

## Where things live

```
<repo>/viewer/
  viewer.json            nav order + the anchor of the last refresh
  flows/<flowId>.json    one manifest per flow
  specs/<flowId>.json    un-narrated skeleton from a capture, with the spine frozen
  findings.json          ONE findings collection — status survives re-analysis
  intake.json            intake answers (never credentials, only a reference)
  docs-manifest.json     consolidated docs
  cleanup-allowlist.json explicit deletion list, never a glob

~/.garrison/project-viewer/<projectKey>/
  captures/<runId>/      traces + ordered runtime events
  cache/                 derived, disposable
```

Manifests live **in the repo** for the same reason the drillbook does: a manifest
and the commit it narrates must travel together through clone, branch and revert.
Run-scoped captures stay out of the repo.

Read and write them through `lib/store.mjs` only — it validates before writing and
reads back after, so a crashed write cannot poison the next run. The schema is
`schema/flow-manifest.schema.json`; the executable copy is `lib/manifest.mjs`.

## Modes

Parse `mode: <m>` from the prompt. No mode named means `full-run`.
Every mode except `full-run` and `cleanup` skips intake when `viewer/intake.json`
already exists.

### full-run

1. Run intake (below).
2. Discover flows, in this source order — **the drillbook wins** wherever it and a
   test describe the same flow:
   - `drills/drillbook.yml` + `drills/pages/*.yml` — hand-authored steps, so these
     are the flows the team actually cares about. Start here.
   - `tests/e2e/*.spec.ts` — real execution, real assertions.
   - the live UI, by vision, for anything neither covers. **A flow with no test is
     itself a finding** — record it with `category: "missing-test"`.
   - recent commits, for walkthroughs.
3. Get a spine per flow (below), then narrate.
4. Fill gaps: where the drillbook and the tests together miss something, decide
   per gap whether a drillbook step or an e2e spec is the right instrument, and say
   why in one line.
5. Validate every manifest, verify every sample by hash, then report the Views link.

Respect the detail level. At the maximum level it means *everything worth knowing
for a developer or an agent, minus the trivial* — it never means every file top to
bottom. Trivial end-to-end actions (saving a form field through to the database)
get **one representative example per page and no more**.

### update

The mode that makes this affordable. Do not re-analyse the project.

Run the script first — it does the whole mechanical half and tells you exactly what
is left:

```
node scripts/update.mjs --repo <path> [--to <sha>] [--flow <id>]
```

Each flow is diffed from **its own** anchor, not from one global one, because flows
drift apart. Untouched spans are rebased by the hunk offsets above them, re-extracted
and hash-verified, then re-stamped `fresh` **with no model call**. The run prints how
many steps were carried forward for free and which ones need you.

Then: re-narrate only the steps it listed as `stale` or `invalidated`, re-extract
their samples, save, and `POST /api/render`.

Two things not to route around:

- A flow's anchor **does not advance** while anything in it is stale, so a flow never
  claims to describe a commit it only half describes. Do not set the anchor by hand.
- `the span moved in a way the rebase could not follow` is the hash safety net
  working. Re-extract that step properly; do not widen the span until it matches.

If a rebase produced a hash mismatch, the step is already marked `stale` — that is
the safety net working, not a bug to route around. Re-extract it properly.

### fix-findings

Input is finding ids from the card, or every finding with status `accepted`.
Read the flow before fixing: the flow tells you how the code is actually used,
which is usually what the finding is about. Run the repo's own gates
(`npm run typecheck`, the relevant tests). Set each fixed finding to `fixed` via
`store.setFindingStatus`. Then run `update` for the affected flows.

### compare

Static reading versus what actually executed. **The whole mode is mechanical** —
run the script, then read its output; do not hand-assemble the report.

```
node scripts/compare.mjs --repo <path> --all-runs [--scope src,packages]
```

It writes `compare-report.json` into the store's cache dir, with the markdown block
the viewer's copy button serves. Then `POST /api/render`.

What you must understand before quoting any of it:

- **Candidates, never conclusions.** References are counted by matching text, so
  comments and strings count too. That inflates counts, which means the scan errs
  towards calling code live. It misses dead code; it does not confidently condemn
  live code. Do not delete on its word alone.
- **The buckets answer different questions.** A value export nothing references is
  deletable. A symbol used inside its own file has a surplus `export`, not dead
  code — those are different repairs and the report says which. An unreferenced
  TypeScript type changes nothing that ships.
- **Read `blindSpots` and `byArea` before summarising.** `byArea` will usually show
  most candidates sitting in vendored packages or an archive; saying "800
  dead-code candidates" without that split is a scary number that means nothing.
- **Never read the unexercised bucket as a coverage verdict.** It lists pages no
  capture landed on, and if you captured one spec out of twenty, that is a
  statement about your captures, not about the test suite. The report says so in
  `blindSpots`; repeat it whenever you quote the number.

File what is actionable as findings, with `evidence` set to `static`, `runtime` or
`both`.

### generate-tests

Write the test the flow deserves, not a test for the coverage number. Assert
behaviour a user would notice. If the new test fails because the code is wrong,
that is a finding — do not bend the test to match a bug.

### walkthrough

Narrate one commit as a flow whose spine is its diff hunks, via
`samples.commitDiffSamples`. Group hunks into states by theme rather than by file
so it reads as a narrative. Fold mechanical hunks into collapsed steps; every hunk
of the commit must be present somewhere.

**No sha in the card means the uncommitted working tree.** Same job, different
spine source: `samples.workingTreeDiffSamples`. Anchor at HEAD with
`anchoredAt.dirty: true`, `source: "commit"`, and no `provenance.commitSha` —
there is no commit yet. Say in the summary that this narrates work in progress;
refresh skips dirty flows by design, and the real commit walkthrough supersedes
this one when the changes land. If the tree turns out clean, say so and stop.

### cleanup

**Destructive. Always asked, never a default.** See "Cleanup" below.

## Getting a spine

The brief asks for per-test coverage. Be honest about what is reliable here.

**What does not work:** V8 line coverage through a Next dev server. Coverage
flushes once per process on exit, so per-test attribution needs inspector calls
between every test, and mapping byte offsets back through dev bundles and their
source maps is brittle in exactly the way that produces a confident wrong answer.
Do not build the spine on it.

**What also does not work: parsing the trace zip.** That was the obvious plan and
it is a trap. The zip's internals are an implementation detail with no
compatibility promise, so a parser for it breaks on a version bump — and it breaks
in the worst way, still producing *a* spine, just a wrong one.

**What to do instead.** One command does the whole mechanical part:

```
node fittings/seed/project-viewer/scripts/capture-runtime.mjs \
  --repo <path> --spec tests/e2e/<file>.spec.ts \
  [--grep "<test title>"] [--project desktop-chromium]
```

Pass `--project` when the repo defines several viewport projects, or you capture the
same flow once per viewport for nothing.

That runs the test under `runtime/pv-reporter.mjs` — a Playwright *reporter*, which
is public API, so a breaking change is a load error you can see rather than a
silent wrong answer. Then it:

1. records every meaningful action in order, with its selector and timing;
2. stitches each action to the URL it happened on (a `goto` sets it, later actions
   inherit it);
3. resolves each URL to the file that served it with `lib/route-resolve.mjs` —
   Next's app router is a pure function of the filesystem, so `/api/quarters/hooks`
   is `src/app/api/quarters/[type]/route.ts` by derivation, not by guessing. An
   unresolvable URL is recorded as unmapped; it is never guessed;
4. walks that file's imports two levels deep with `lib/import-graph.mjs` and ranks
   them, giving you a short ordered candidate list;
5. writes one capture per test to
   `~/.garrison/project-viewer/<projectKey>/captures/<runId>/`.

**The drillbook, when the project has one.** It is the source to prefer, because it
is the one place a human already wrote down what each page is FOR — a ranked import
list tells you which files are nearby, a drillbook step tells you what matters.

```
node scripts/capture-drillbook.mjs --repo <path> [--page <id>]
```

Nothing is executed: it reads `drills/drillbook.yml` and the page files, resolves each
declared path to the file that serves it, and records the author's own words as the
step's `intent`. The capture comes out `status: "not-executed"`, which is the truth —
do not narrate it as though a run had passed. Each declared page state becomes its own
state in the spec even though they share a path, because a page empty and the same
page full are two things worth reading about.

The run prints the book's `globalRules`. Read them before you write about any page.

**Then turn the capture into a spec, and narrate the spec.** Do not hand-write a
spec from a capture you read — one command does it, and doing it by hand is how a
step goes missing:

```
node scripts/build-flow.mjs --repo <path> --from-run <runId> [--test <key>]
```

That writes `viewer/specs/<flowId>.json`: one state per page in first-visit order,
one step per action in the order it happened, every description empty, and a frozen
`spine`. Each step carries a `hints` block — the route file, its layouts, the ranked
candidates, the spec line that caused the action, and any admissions the capture made
about itself.

Your job starts there: pick, from the candidates, the file and span that explains
each step, and write the prose. You are choosing between real imports that really
exist — not reconstructing a call graph from imagination.

Fill in `description`, and `file` / `startLine` / `endLine` / `highlights` per step.
Delete nothing from the spine.

**Also write `logic` on every state** — the functional narration for the logic view
(the code-free flowchart a reader can toggle to). One or two sentences on what this
stage ACHIEVES in the domain's terms and why it exists: no file names, no function
names, no code talk. It is not a summary of the step descriptions — those say how;
this says what and why, for the reader who has not opened the code view yet. Written
in the same language as the descriptions. A state without it renders mechanically
and the page says the narration is missing, so skipping it is visible, not silent.

Then build the manifest:

```
node scripts/build-flow.mjs --repo <path> --spec viewer/specs/<flowId>.json
```

The build **checks the manifest against the frozen spine and refuses it** if a
recorded action is missing or reordered. Adding steps is fine and expected — folding
trivial glue into a one-line step is the instruction. Losing one is not. If it
refuses, the fix is to put the step back, collapsed; it is never to edit the spine.

A step whose URL resolved to no file arrives as `kind: "glue"` with an admission
saying so. Narrate it as glue or file a finding — do not promote it to `code` by
inventing a file for it.

**Read a capture's own admissions before you narrate from it.** Three fields are
there specifically to stop you writing something confident and wrong:

- `via` on a route event — the reader passed through a redirect stub to get here.
  Narrate the destination, and mention the hop only if it matters to the story.
- `redirects: "dynamic"` — the page redirects somewhere the tool could not derive,
  so the resolved file is the *stub*, not the destination. Do not narrate it as the
  destination. Say the target is computed, or open the file and find out.
- `requestedUrl` differing from `url` — the test asked for one path and landed on
  another. `url` is where the reader actually was. It appears only on the navigation
  that was actually redirected, never on the actions that followed it.
- `intent` in a step's hints — a person's words about what this page is for. It
  outranks every candidate ranking underneath it.
- `runStatus` — `not-executed` means nothing ran (a drillbook), and a failing run
  still yields a real spine. Neither may be narrated as a passing one.

If a step's route looks wrong to you, file a finding. Narrating around a wrong route
is how a viewer loses the trust it exists to hold.

**Known limit, state it rather than hide it.** The reporter sees actions, not
network requests, so a route is resolved from the page URL rather than from the
requests an action fired. That is accurate for navigations and good enough for
in-page actions; sharpening it needs a Playwright fixture, which would mean editing
the target repo's tests. If a step's route looks wrong, say so in a finding instead
of narrating around it.

**Vision fallback**, for flows with no test: drive the live pages, record the same
ordered actions, and emit a capture with `source: "ui"`. The shape is identical on
purpose, so everything downstream is indifferent to how the spine was obtained.
Also file the missing-test finding — `captures.mjs` has `noCoverageFinding` for it.
A `source: "ui"` capture goes through `--from-run` and the spine check exactly like an
e2e one; nothing downstream cares how the spine was obtained.

## External systems

Represent them as samples, so both a human and an agent grasp them at a glance:

- **Database** — `kind: "db"`, `asciiSample` holding an ASCII table with real rows
  where you can read them, plausible ones where the table is empty. Say which.
- **File writes** — `kind: "filewrite"`, `asciiSample` showing the shape (the JSON
  structure, say) with the important parts present.
- **Dependencies** — `kind: "dep"` with a short `note`. Do not explore a dependency
  in depth; explain only why it matters to the code at hand.

## Intake

Ask these at the start of a `full-run`, and at the start of `cleanup`. Keep it
short — this is five questions, not an interview.

1. **Level of detail.** Offer `overview`, `standard`, `deep`. **Never offer "cover
   every file from top to bottom"** — that option does not exist. Explain that the
   user picks the level and you decide what it means for this codebase.
2. **Flows or corner cases they especially care about.** Free text. Empty is fine.
3. **Whether to spend tokens on real runs when the app's own functionality calls an
   LLM**, and if so a ballpark budget per run. This cap applies **only** to
   exercising the app's LLM features. The analysis itself is not capped by it.
4. **Test credentials** for the system and its dependencies. **Inspect the project
   first** — `.env.example`, seed scripts, the README, the drillbook — and present
   what you found, so the user confirms rather than remembering. Credentials go to
   the vault or wherever the user says. **Never into `intake.json`, never into a
   manifest, never into a prompt.** Store a reference only.
5. **Whether to do the documentation consolidation and cleanup.** Always asked.
6. **Which language to write the descriptions in** — English or Portuguese.
   Ask because it is not inferable: the interface is bilingual and flips with a
   toggle, but the prose you write is stored in the manifest and does not.
   Default to the language the repository's own docs are written in, and say which
   you picked. Write in ONE language: a `{en, pt}` map is valid in the schema, but
   filling both means writing every description twice, which doubles the single
   most expensive part of this whole job. Only do that if the user asks outright.

Persist to `viewer/intake.json`:
`{answeredAt, detailLevel, flowsOfInterest[], llmRunBudget: {perRun, used}, credentialsRef, cleanupArmed, proseLanguage}`.
Also write the chosen language as `proseLang` into `viewer/viewer.json` — that copy
is the one the SERVER reads, so the viewer can tell a reader whose interface
language differs that the prose will not follow the toggle. **Preserve it when you
rewrite the index**: `viewer.json` may carry fields you did not set this run, and
rebuilding it from scratch silently deletes them. Read, modify, write back.
On a later run, ask **one** question instead of five: summarise what is on file and
offer to reuse it, re-asking only what the user names. Increment
`llmRunBudget.used` so the budget survives across runs.

## Findings

Record problems as you go, each tied to the flow and the span it concerns, in
`viewer/findings.json`. A finding's `status` is the reason there is one collection
rather than a copy per flow: **a dismissed finding must not come back on the next
analysis.** Never resurrect a `dismissed` finding; if you believe it was wrongly
dismissed, say so in the report instead of silently reopening it.

## Cleanup

Part of the product, not a side feature — and the destructive half is enforced in
code, like every other guarantee here: **the only way a doc leaves the repo is
`scripts/cleanup.mjs`, and it refuses to delete anything whose content the machine
cannot prove already lives in the viewer.** You never `rm` a doc. Not once.

1. **Refuse** unless intake recorded `cleanupArmed: true` (cleanup.mjs checks this
   too, but you refuse first — do not make the tool do your saying-no for you).
2. **Propose** `viewer/cleanup-allowlist.json`: `{entries: [{path, reason}]}` — an
   explicit list of literal paths. **Never a glob. Never an extension pattern.**
   (cleanup.mjs rejects glob characters outright.) In this repo, roughly half of
   all `.md` files are `SKILL.md` and `README.md` inside `fittings/seed/` and
   `.codex/skills/` — executable payload, not documentation; a `*.md` sweep would
   delete dozens of working fittings.
3. **Hard exclusions**, enforced by cleanup.mjs, no exceptions: anything under
   `fittings/seed/**`, `.codex/skills/**`, `site/**`, `public/icons/**`; and
   `README.md`, `CLAUDE.md`, `AGENTS.md`, `SKILL.md` are slimmed, never deleted.
4. **Consolidate before destroying — through `store.consolidateDoc` only.** It
   copies the doc into `viewer/docs/`, registers it in `docs-manifest.json` with
   the sha256 of the exact bytes it copied, and that hash is the deletion gate:
   cleanup.mjs deletes a file only when the recorded hash matches the file's
   *current* bytes and the copy still renders. A doc edited after consolidation is
   undeletable until you consolidate it again — by design. Verify each doc renders
   at `/docs` before going on.
5. **Ask.** Present the list with counts and reasons. On approval, record
   `approvedAt` on the allowlist. No `approvedAt`, no deletion — cleanup.mjs
   refuses an unapproved list.
6. **Delete**: `node scripts/cleanup.mjs --repo <path>` first (dry run — show the
   user its output), then with `--apply`. The run is all-or-nothing: one entry
   failing any gate refuses the whole run, so the removal set always equals the
   approved list exactly.
7. **Slimming rules.** `CLAUDE.md` and `AGENTS.md` keep the most important rules,
   not the decisions, plus a pointer to the viewer. The README keeps setup and the
   ordinary basics, then links to the viewer for everything else. Remove only what
   now lives in the viewer; never restructure surviving guidance. Slimming is an
   edit, not a deletion — it never goes through cleanup.mjs, and it still keeps
   the original readable in the viewer first via `store.consolidateDoc`.
8. **Keep deletions out of any feature commit.** And note the standing repo rule:
   **do not create a git branch unless the user explicitly tells you to.** If the
   separation needs a branch, ask for it.

## Prompt buttons

The viewer is the control surface: its buttons POST to the fitting's own server,
which composes a prompt from `lib/prompts.mjs` and dispatches it. Long work goes
to a kanban card, because a chat turn caps out around five minutes and an analysis
run takes longer than that. Only a short question goes to a gateway turn.

When you are picked up from such a card, the prompt names the mode and points at
`viewer/` rather than inlining content. Read the store; do not expect the prompt to
carry the data.

## Before you say you are done

- Every manifest passes `validateFlow`.
- Every sample verifies by hash — check, do not assume.
- No step describes code the reader cannot see, and no sample is shown without a
  description.
- Collapsed steps are collapsed, not missing.
- The findings you filed point at spans that exist.
- If you could not do part of the job, say which part and why. A gap you name is
  useful; a gap you paper over destroys the trust the whole tool runs on.
