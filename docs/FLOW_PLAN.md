# FLOW_PLAN — Garrison as the Config Plane for Claude Code

Authoritative plan of record: `~/.claude/plans/brief-garrison-zippy-sparrow.md`. This file is the build's slice table + resume substrate.

Dev: `npm start` → http://127.0.0.1:7777. Gates: `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` · `npm run test:e2e`.

## Slices

| id | title | kind | route | group | status |
|----|-------|------|-------|-------|--------|
| S1-settings | Settings surface over `~/.claude/settings.json` (merge-managed, never-clobber) | ui | /settings | A | pending |
| S2-install | Global install/ownership backend + lockfile + skills→`~/.claude/skills/` + adopt | mixed | /armory | A | pending |
| S4-memory | CLAUDE.md editor (user + project); memory-compiler untouched | ui | /memory | A | pending |
| S3-hooks | Hook fittings via the shared writer (owner-scoped tags); delete dead claude-hooks.ts; migrate session-view | mixed | /settings | B | pending |
| S5-importer | `scripts/import-claude-install.ts` — scan `~/.claude` → emit fittings (+`--adopt`) | automation | (cli) | B | pending |

## Parallel groups (disjoint-file reasoning — logged, not silent)
- **Group A (S1, S2, S4):** disjoint owned file sets — S1 owns `settings.*`/`claude-settings-file.ts`; S2 owns `claude-install*.ts`; S4 owns `claude-md.ts` + memory UI. Only shared file is `src/components/chrome/Sidebar.tsx` (S1 + S4 each add one NavLink) → the LEAD serializes those one-line NavLink edits at integration.
  - **Honest execution choice for this run:** S1 and S2 are the keystone libs (the single settings writer + the ownership backend) whose semantics are delicate and consumed by S3/S4. The lead authors them **serially** for correctness; parallel-authoring one delicate ownership contract risks integration churn for little gain. S4 is independent and may be authored in a parallel burst (agent team is enabled).
- **Group B (S3, S5):** run AFTER group A. S3 edits S1+S2 files (shared) → serial w.r.t. them. S5 owns only its script and merely *imports* S2's `adoptFitting` (no edit) → S5 is disjoint from S3 and may run parallel to it.

## Acceptance per slice
- **S1:** `/settings` renders documented keys as typed controls and bespoke keys (`advisorModel`/`autoMode`/…) in an Advanced passthrough; edit→save patches only changed keys; unknown keys byte-preserved; external drift surfaced; unit test proves merge-not-clobber + own-write does not self-report drift. Sidebar shows Settings.
- **S2:** install a skill fitting → files land in `~/.claude/skills/` + lockfile records sha256; uninstall removes exactly those; a pre-existing unowned target is refused (writes nothing); brown-field **adopt** records existing bytes then manages/uninstalls; Armory exposes install/adopt/uninstall + inventory/drift.
- **S4:** `/memory` reads+edits user `~/.claude/CLAUDE.md` and a project CLAUDE.md; never-clobber on external change; `fittings/seed/memory` + compiler untouched.
- **S3:** two hook fittings with different owners coexist; uninstalling one leaves the other + untagged hand-authored groups intact; `src/lib/claude-hooks.ts` + its test deleted; session-view scripts migrated to owner-scoped tags; hooks shown read-only-with-provenance in `/settings`.
- **S5:** run emits N skill + hook fittings, skips existing seeds, each passes `tsx scripts/validate-fitting.ts`; `--adopt` records emitted artifacts at current bytes; no existing seed mutated.

## Status legend
pending · in_progress · passed · blocked
