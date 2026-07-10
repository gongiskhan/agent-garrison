# Manifest & Idempotency

How this skill decides what already exists and what to create. The **Detect** step reads this (it is autothing's Phase 0). Detection is **read-only**; it never edits.

## The manifest — a project's foundation is COMPLETE when all hold
| # | Element | Present means… | Detect by |
|---|---------|----------------|-----------|
| 1 | Root `CLAUDE.md` | exists | `test -f CLAUDE.md` |
| 2 | Living `/docs` | each role is covered (a file may cover a role under a different name) | see role map below |
| 3 | Area skills | the warranted set exists under `.claude/skills/` | list `.claude/skills/*/SKILL.md` |
| 4 | Run/verify | `/run` + `/verify` resolve **and** the dev command + base-URL/port are known | check skills exist; read `package.json` scripts + `docs/architecture.md` |
| 5 | Walkthrough preflight *(only for projects that will record video evidence)* | `walkthrough/scripts/preflight.sh` passes (node, ffmpeg, playwright-cli, vhs, **asciinema**, **agg**) and `.walkthrough/config.json` exists | run preflight |
| 6 | Git repo | the repo is a git work tree (enables `git diff` flow-selection + workflow worktree isolation + rollback) | `git -C <repo> rev-parse --is-inside-work-tree` |

Element 5 is only required when the foundation is for a gated build that proves slices with `walkthrough` videos (autothing's use). For a plain foundation scaffold, treat it as optional. `docs/autothing/` (evidence-index.json, slices/) is build bookkeeping — created on first build, not part of "complete".

### Role map for /docs (match by content, do not duplicate)
- `product-overview` ← any doc describing the product + primary flows.
- `architecture` ← e.g. an existing `*-architecture.md`, `deployment-*.md`. **Reference these by path; never re-author.**
- `conventions`, `governance` ← the two canonical @imports. If absent, create from `assets/docs/`.
- `decisions` ← an ADR/decision log.
- `FLOW_PLAN` ← the build plan (owned by the build orchestrator, e.g. autothing's Phase 2 — this skill does not generate it).

A role is "covered" if a file fills it. When covered by an existing differently-named file, **add a pointer to it** (in CLAUDE.md's reference list) rather than creating a duplicate.

## Idempotency rules (binary — there is no operator to ask under autonomy)
- **Missing element → create it** from the template/exemplar.
- **Existing canonical file → NEVER rewrite or refactor it autonomously.** Not CLAUDE.md, not any /doc the user already wrote.
- The ONLY permitted edits to existing files are **additive and clearly-owned**:
  - append a `## Routing index` / `## Canonical docs` section to CLAUDE.md **if that section is absent**,
  - append an entry to `docs/decisions.md`,
  - add a **new** area-skill file or a **new** nested CLAUDE.md (creating files ≠ editing existing ones).
- Anything that would improve an existing file by rewriting it is a **recommendation, not an action**.

## Staleness is REPORTED, never acted on
Detection may notice: CLAUDE.md is long (e.g. >250 lines) and could be slimmed into /docs; a doc predates large code change; an area skill's description overlaps another. Write these to `docs/REFRESH-RECOMMENDATIONS.md` (or `docs/autothing/REFRESH-RECOMMENDATIONS.md` inside an autothing build) and continue. Do not slim, rewrite, or reorganise existing files on your own — that is a judgement-heavy destructive change and must not happen unattended.

## Output of detection
A gap list: for each manifest element, `present | missing | partial`, plus the role-map pointers and any refresh recommendations. The generate step bootstraps **only** the `missing`/`partial` gaps.
