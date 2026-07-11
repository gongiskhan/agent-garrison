# Foundation Generation

How the **Generate** step creates the per-project foundation (autothing's Phase 1). Create **only the gaps** detection found (see `manifest.md`). Delegate; do not reinvent.

**Git first:** if the repo is not already a git work tree, run `git init` + an initial commit before anything else — even for an existing non-git codebase. Flow-selection diffs (`walkthrough`), workflow `isolation: 'worktree'`, and rollback all depend on it.

## Contents
- New-project bootstrap (research → prototype → repo)
- Generating /docs
- Generating the lean CLAUDE.md
- Authoring the area skills (the set + how)

## New-project bootstrap (only when the repo is empty/new)
1. **Research brief** → invoke the `deep-research` skill with the product idea; save the synthesis to `docs/product-overview.md` as the seed. Skip for an existing codebase.
2. **Prototype + design tokens** → invoke `frontend-design` (and `huashu-design` for hi-fi/interactive) to produce the prototype and the design tokens that become the design source of truth. Record its path in `docs/product-overview.md` and CLAUDE.md.
3. **Repo** → init git if absent; create the standard dirs; do not scaffold the whole app here — the build fills it in later (autothing's slice loop).

## Generating /docs
- Copy each **missing** role's skeleton from `assets/docs/` into the project's `docs/`, filling placeholders from repo facts (package.json scripts, framework, paths) — not guesses. Keep each under its line budget.
- For a role already **covered by an existing file**, do not create a duplicate — add a pointer to it in CLAUDE.md's reference list.
- `architecture.md` and `decisions.md` are **living**: the build updates them as it changes structure or makes decisions.

## Generating the lean CLAUDE.md
- If `CLAUDE.md` is **absent**, instantiate `assets/CLAUDE.md.template`: summary, stack, 2-3 IMPORTANT rules, design source of truth, definition of done, `@import` ONLY `docs/conventions.md` + `docs/governance.md`, reference the heavier docs by path, and fill the **routing index** with the actual generated skill names.
- If `CLAUDE.md` **exists**, do not rewrite it. If it lacks a routing index, **append** a `## Routing index` section pointing at the area skills. Log any "this file is long, consider slimming" as a refresh recommendation (see `manifest.md`).
- **Path-scoped loading**: for area guidance that should load only when matching files are touched, drop a **nested `CLAUDE.md`** in that directory (e.g. a mobile path) that references the area doc/skill by path. This keeps the root lean and loads area detail on demand. Creating nested files is allowed (it is not editing an existing file).

## Authoring the area skills
Land them in the **target project's** `.claude/skills/<proj>-<area>/SKILL.md`. Use `assets/area-skills/testing.SKILL.md` as the worked exemplar for structure, then author each from the project's real commands/paths. **Do not ship generic copies** — each description must be pushy and non-overlapping *relative to this project's other skills*.

The set (include the first five always; add the last two when the stack warrants):
| Skill | Owns (verbs) | Backing doc (nouns) |
|-------|--------------|---------------------|
| `<proj>-planning` | break a goal into slices; write/update FLOW_PLAN; sequence + mark parallel groups | `docs/FLOW_PLAN.md` |
| `<proj>-architecture` | decide module boundaries, data/API shape; keep architecture.md current | `docs/architecture.md` |
| `<proj>-testing` | explore-first, write+run Playwright/unit tests, report exit codes (the exemplar) | `docs/governance.md` |
| `<proj>-design-audit` | drive the running app and judge it against design tokens via frontend-design/huashu-design; record a verdict | design source of truth |
| `<proj>-governance` | enforce the definition of done; write gate-status.json; gate slice/global advance | `docs/governance.md` |
| `<proj>-mobile` *(if mobile paths exist)* | mobile-specific build/test rules | `docs/architecture.md#mobile` |
| `<proj>-data-api` *(if a DB/API exists)* | safe data/API/schema changes, migrations, contract tests | `docs/architecture.md` |

Authoring rules:
- **Verbs in the skill, nouns in the doc** — the skill references its doc by path and never duplicates it.
- **Frontmatter description**: state what it does, when to trigger (specific work), and an explicit "do NOT use for … (that is `<other skill>`)" clause to prevent trigger collisions.
- Keep each SKILL.md tight; push detail into the doc it references.
