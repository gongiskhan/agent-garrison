# Project Viewer

A codebase explained as **end-to-end flows** instead of a file tree. Each unit of
content is a real code sample on one half of the screen and a plain-language
description on the other. No diagrams, no screenshots, no graphs.

The expensive part happens once. After that, a human or an agent that needs to
understand this project reads the viewer instead of trawling files.

## The guarantee this fitting is built around

**Every code sample is extracted mechanically from the repository at a pinned
commit, and the renderer verifies it before showing it.**

A sample records the sha256 of the exact bytes that were sliced out of
`git show <sha>:<path>`. At render time the server re-extracts and re-hashes. On a
mismatch the step renders an integrity-failure panel **instead of code** — never a
best guess, never stale lines presented as current.

This is enforced in three places, not asserted in a doc:

| Where | What it does |
|---|---|
| `lib/samples.mjs` | the only way to produce a sample; reads git, hashes what it read |
| `lib/manifest.mjs` | refuses to accept a sample with no `extractedSha256` |
| `scripts/build-flow.mjs` | throws if a flow spec tries to carry literal code |

The model's write surface is exactly: which file, which lines, which lines to
highlight, and the prose. That is it.

## Layout

```
apm.yml                     manifest (faculty: knowledge, own_port, port 8087)
schema/                     the flow manifest JSON schema — the human-readable contract
lib/
  extract.mjs               slicing + hashing + highlight normalisation (pure)
  git.mjs                   the only module that shells out
  samples.mjs               materialises span and diff samples
  manifest.mjs              the executable copy of the schema
  store.mjs                 where data lives; atomic writes with read-back
  highlight.mjs             dependency-free deterministic syntax highlighter
  diff.mjs                  unified-diff rendering, GitHub style
  render.mjs                the deterministic renderer (pure: manifest + bytes → HTML)
  invalidate.mjs            rebase / stale / invalidated decisions after a commit
  file-index.mjs            derived indexes, never stored
  prompts.mjs               prompt-button templates
  dispatch.mjs              server-to-server dispatch to kanban / gateway
scripts/
  server.mjs                HTTP server, renders on request
  start.mjs                 entrypoint Garrison spawns
  probe.mjs                 verify surface, prints "ok"
  setup.sh                  idempotent, builds nothing (see below)
  build-flow.mjs            materialise a manifest from a spec or a commit
assets/                     viewer.css + viewer.js (no build step)
dist/index.html             the declared view entry
.apm/skills/garrison-project-viewer/SKILL.md
```

### Why there is no build step

Two reasons, and the second is the real one.

1. The pages are server-rendered documents. The only client-side work is folding a
   step, stepping between states, triaging a finding and posting a button — about
   200 lines of vanilla JS. React would earn nothing here.
2. **Setup runs with its cwd in `apm_modules/_local/<id>`, while the runtime serves
   from `fittings/seed/<id>`.** Anything `setup.sh` built would be built in the
   tree that is not being served. This fitting sidesteps that by having nothing to
   build: no bundler, no `node_modules`, no committed bundle to go stale.

That is also why the highlighter is hand-written rather than Shiki, and the diff
renderer hand-written rather than diff2html. The brief lists those as *candidate*
libraries; taking them would mean two new root dependencies and a ~2 MB committed
bundle living in exactly the tree where committed build output is fragile.

## Where data lives

| Data | Location | Why |
|---|---|---|
| flow manifests, findings, intake | `<repo>/viewer/` | durable, diffable, reviewable — a manifest and the commit it narrates travel together through clone, branch and revert, exactly like the drillbook |
| runtime captures | `~/.garrison/project-viewer/<projectKey>/captures/` | run-scoped, per the rule that nothing run-scoped lives in the repo |
| rendered HTML | nowhere | a pure function of manifest plus repo; committing it would add a drift channel, and render-time verification only means something if rendering actually happens |

## Running it

The server needs a port and a git repository. It never picks a port itself.

```bash
GARRISON_PROJECTVIEWER_PORT=8087 \
GARRISON_PROJECTVIEWER_TARGET_REPO=/path/to/repo \
node scripts/start.mjs

node scripts/probe.mjs --probe        # prints "ok"
```

Routes: `/` (flows by source), `/flow/:id/state/:n`, `/findings`, `/files`,
`/files/*`, `/uncommitted`, `/commits`, `/commit/:sha`, `/docs`, `/compare`,
`/health`, plus `/api/flows`, `/api/flow/:id`, `/api/findings`,
`PATCH /api/findings/:id`, `POST /api/render`, `POST /api/prompt/:mode`.

Keyboard: `←`/`→` (or `k`/`j`) step between states, `e` expands every folded step.

## Building a flow

The skill does this, but the tool is usable by hand:

```bash
# from a spec of coordinates and prose (never code)
node scripts/build-flow.mjs --repo /path/to/repo --spec pilot/spec-manifest-validation.json

# a commit walkthrough, generated whole and mechanically
node scripts/build-flow.mjs --repo /path/to/repo --commit <sha> --max-hunks 12

# an un-narrated skeleton per test, taken from a real run
node scripts/build-flow.mjs --repo /path/to/repo --from-run <runId>
```

A spec that includes a `code` or `sampleText` field is rejected. Samples come from
the repository or they do not exist.

`pilot/spec-manifest-validation.json` is a real, working spec against this repo's
own manifest-validation path. Regenerate it after pulling — it is anchored to
whatever HEAD you build it at, so a spec built on another machine's HEAD will
correctly refuse to render on yours.

## Capturing what actually ran

```bash
node scripts/capture-runtime.mjs --repo /path/to/repo \
  --spec tests/e2e/quarters.spec.ts --grep "edits a hook"
```

Four mechanical stages, no model involved:

| Stage | Module | What it produces |
|---|---|---|
| record | `runtime/pv-reporter.mjs` | ordered actions per test, with selectors and timing |
| stitch | `scripts/capture-runtime.mjs` | each action tagged with the URL it happened on |
| resolve | `lib/route-resolve.mjs` | the file that served that URL, derived from routing rules |
| candidates | `lib/import-graph.mjs` | that file's imports, two levels deep, ranked |

Captures land in `~/.garrison/project-viewer/<projectKey>/captures/<runId>/`. A flow
manifest keeps only an opaque `captureRef`, so the repo never carries run output.

**A reporter, not the trace zip.** The zip's internals are a Playwright
implementation detail with no compatibility promise: a parser for it breaks on a
version bump, and it breaks badly — still producing *a* spine, just a wrong one. The
reporter API is public, so a breaking change is a load error you can see.

**Route resolution is derivation, not inference.** Next's app router is a pure
function of the filesystem, so a URL does not need instrumentation to name its file.
Static beats dynamic beats catch-all, route groups carry no segment, and layouts are
returned alongside a page because the chrome is usually part of the story. A URL
that does not resolve is recorded as unmapped — never guessed.

### The drillbook, without executing anything

```bash
node scripts/capture-drillbook.mjs --repo /path/to/repo
```

`drills/drillbook.yml` plus `drills/pages/*.yml` is hand-authored: someone wrote down
what each page is for. That prose is better narration guidance than anything derivable,
so it is carried into each step as an `intent`. Captures come out
`status: "not-executed"` — thinner than an e2e spine and honestly labelled, since a
drillbook step is a judgement about a page rather than a sequence of clicks.

`js-yaml` is the fitting's only dependency and it is **optional and lazily imported**:
every other mode works without it, and drillbook mode says plainly what is missing.
Hand-rolling a YAML parser was rejected — a misread folded block (`>-`) would silently
produce a wrong page path, and confidently wrong data is the one failure this fitting
exists to prevent.

Verified against this repo: all 7 drillbook pages resolved to real route files, and
`/vault` carried through the author's own sentence about what that page must
communicate.

### From a capture to a manifest

`--from-run` turns each capture into `viewer/specs/<flowId>.json`: one state per page
in first-visit order, one step per action, all prose empty, plus per-step `hints`
(route file, layouts, ranked candidates, the spec line that caused the action) and a
frozen `spine`.

Narrating the spec and building it with `--spec` then goes through a check: **the
manifest must still match the run.** Every recorded action has to appear exactly
once, in order. Extra steps pass — folding trivial glue into a one-liner is
encouraged — but a dropped or reordered action is refused. That makes
collapse-never-omit structural for runtime flows instead of a rule someone remembers.

A step whose URL resolved to no file arrives as `kind: "glue"`, not as `code` with an
invented file.

## Comparing what the code says against what ran

```bash
node scripts/compare.mjs --repo /path/to/repo --all-runs --scope src,packages
```

Three buckets, each scoped to what its instrument can actually see:

- **Dead-code candidates** — exported symbols nothing references. Ordered by how
  actionable each is: nothing-references-it-anywhere first, then test-only, then
  used-inside-its-own-file (a surplus `export`, not dead code), then TypeScript
  types, which change nothing that ships.
- **Pages never observed executing** — route files no capture landed on. Only route
  files, because route resolution is the only thing the runtime half observes;
  listing unvisited helpers would report a blindness as a finding. Empty when there
  are no captures at all — an absence of observation is not an observation of
  absence.
- **The same name in more than one place** — the cheapest available proxy for the
  same job solved twice.

`--scope` narrows what is reported. It never narrows the search for uses: a
reference in `tests/` or in a package outside the scope still counts, because a use
nobody looked for reads exactly like no use at all.

## Keeping it current

```bash
node scripts/update.mjs --repo /path/to/repo
```

Each flow is diffed from **its own** anchor, since flows drift apart. Untouched spans
are rebased by the hunk offsets above them, re-extracted, hash-verified and
re-stamped `fresh` with no model call; the run prints how many steps were carried
forward free and which need re-narration. A flow's anchor does not advance while
anything in it is stale.

Observed on this repo: a flow anchored 100+ commits back carried 5 of 5 code steps
forward for nothing — `parseGarrisonMetadata` had moved from line 478 to 465 and its
body was byte-identical. Against a commit that edited inside a sampled span, the same
flow reported 3 stale and refused to advance its anchor.

## Known limits, stated plainly

- **No V8 line coverage.** Per-test line coverage through a Next dev server needs
  inspector calls between every test plus source-map resolution through dev bundles
  — two brittle layers whose failure mode is a confident wrong answer. Line-level
  coverage is feasible against a production build; it is a separate milestone, not a
  prerequisite.
- **The reporter sees actions, not network requests.** So a route is resolved from
  the page URL rather than from the requests an action fired. Accurate for
  navigations, good enough for in-page actions. Sharpening it needs a Playwright
  fixture, which would mean editing the target repo's tests — not worth it for the
  precision gained.
- **Route resolution covers what Garrison uses:** static, `[param]`, `[...all]`,
  `[[...optional]]`, and `(groups)`. Not middleware rewrites, `basePath`, or
  parallel/intercepted routes.
- **The dead-code scan is reference-counting, not type-aware.** It reports
  *candidates*. Do not delete on its word alone.
- **The highlighter is line-scoped**, so a sample window starting inside a block
  comment does not tint the rest of the window. That is the deliberate trade for
  making a windowed slice colour independently of its surroundings.
