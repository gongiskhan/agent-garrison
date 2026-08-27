# Per-skill notes

The improver is the SINGLE mechanism that improves skills, so skill-specific knowledge lives here (not inside the skills themselves). Read this during triage. Add a section when you learn how a particular skill tends to fail or where its feedback hides. Keep each entry to: where its real home is, what's prose-fixable vs code(flag), its dominant false-positive, and any extra feedback source.

## autothing  (builder skill — `~/.claude/skills/autothing/`, real dir)
- **Dominant false positive:** autothing builds web apps, so most feedback in its sessions is about the **built app** ("add a side-panel button", "make the dashboard blue") — that is app-feedback → **DROP** (safety rail 10). Only "autothing skipped the foundation", "it didn't init git", "the gate logic is wrong" etc. is about the skill.
- **Extra feedback source — the build friction-log.** autothing records its own friction (no user is present during an unattended build) to `<cwd>/docs/autothing/friction-log.md` in the repo it built. For any candidate whose `skillsUsed` includes `autothing`, read `<candidate.cwd>/docs/autothing/friction-log.md` if it exists — each line ("had to X because the skill Y") is first-hand feedback about autothing. This is the primary signal for autothing, since its builds have no user in the loop. A sibling file `docs/autothing/known-flakes.md` may also exist — that one records infra/test flakes in the BUILT APP's suite (app-level, not skill feedback); read it only to rule signal in/out, don't mine it for edits.
- **Large skill:** edits live across `SKILL.md` + `references/*.md`. Route a prose fix to the right reference file, not always SKILL.md.
- **Never touch:** its non-negotiables, the gate definitions, or the Phase-4 handover-before-`GLOBAL GATE:`-verdict ordering (that ordering is load-bearing for `/goal`). Those are flag-only.

## walkthrough  (`~/.claude/skills/walkthrough`, REAL dir since 2026-07-07 — vendored out of `~/dev/walkthrough` at the user's request, commit `af052f7` in the `~/.claude` repo; no longer a symlink)
- **Commit in `~/.claude`** for a native diff (snapshot still required first, as always). The old `~/dev/walkthrough` repo still exists but no longer holds the skill — never edit there.
- **The working tree may carry uncommitted drift from other sessions** (e.g. `scripts/record.mjs`). `git add` ONLY the files you edited — never `-A` — and diff your commit afterwards; on 2026-06-11 a pass swept pre-existing prose into its commit and had to split it.
- **Prose-fixable:** flow-selection guidance (SKILL.md step 4), caption rules, what-to-show/avoid, `.walkthrough/notes.md` conventions.
- **Code → FLAG (do not auto-edit):** anything in `scripts/` — highlight coordinates / cursor / recording pipeline (`scripts/lib/browser.mjs`, `scripts/record.mjs`). Verifying these needs recording against a live app.

## frontend-design / huashu-design  (design skills)
- **Dominant false positive:** "make it blue / move the button" is about the OUTPUT → drop. Keep only feedback about how the skill audits/generates (its process, its tokens handling, what it checks).

## skill-creator, update-config, etc. (meta skills)
- Mostly prose. Standard rules apply. No special-casing yet.

## skill-improver (this skill)
- Excluded from mining by `discover.mjs` (self-reference guard). If the user critiques the improver itself, handle it as a normal flag for human review — do not auto-edit your own running protocol.
