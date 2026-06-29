# FLOW_PLAN — Rename "Automatizar" label in ekoa-site initial app sample

## Context

The ekoa website (`~/dev/ekoa-site/`, a static HTML site) home page (`index.html`)
contains a hero composer demo — the "initial app sample" — that shows the AI's
selected engine as: `motor escolhido: Automatizar`. The user wants this changed
to `Automático`.

## Exploration findings

The home page is `~/dev/ekoa-site/index.html`. There is exactly ONE occurrence
of the string `motor escolhido: Automatizar` on the home page (line 361), inside
the hero's composer auto-tag span (class `auto-tag`, inside `.composer .foot`).
This unambiguously matches the "initial app sample" description.

Other occurrences of `Automatizar` exist on the home page and elsewhere — but
they are NOT the initial app sample:
- `index.html:403` — `<h3>Automatizar</h3>` inside the MOTORES grid (the name
  of one of the five engine cards).
- `plano-flexivel.html` — pricing page mode list (not home page).
- `temp-legal-vertical/`, `previous-site/`, `_standalone-src.html` — staging /
  legacy artifacts, not the live home page.

The MOTORES grid card name (`Automatizar` is the engine NAME, line 403) is
intentionally out of scope: the user named the "initial app sample" specifically.
Renaming the engine itself would touch the whole site's terminology (the engine
appears across pages, in JS translation maps, in copy, etc.) — a much bigger
change than the user asked for.

## Decision — assumption resolved (autonomous)

The card description text says `Automatico` (no accent). The original user
intent (per the upstream message visible in this conversation) was `Automático`
(WITH accent). The site is written in Portuguese with consistent diacritics
throughout (e.g. `automaticamente` line 374, `aplicações`, `Olá`). Going with
**`Automático` (with accent)** to match site conventions and the original
intent. If the implementer or reviewer disagrees, the literal-text alternative
is `Automatico`.

## Slices

| id | title | files | acceptance |
|----|-------|-------|------------|
| s1 | rename Automatizar → Automático in initial app sample | `~/dev/ekoa-site/index.html` | line 361 changes from `motor escolhido: Automatizar` to `motor escolhido: Automático`; no other lines in the file modified; the file remains valid HTML (loads in a browser, no broken tags). |

## Acceptance (machine-checkable)

Run from `~/dev/ekoa-site`:

1. `git diff --stat index.html` → exactly 1 file, net `+1`/`-1` line delta (one
   line changed).
2. `git diff index.html` → only the `motor escolhido:` line changes. The minus
   side is `motor escolhido: Automatizar`; the plus side is
   `motor escolhido: Automático`. Indentation preserved.
3. `grep -c "motor escolhido: Automatizar" index.html` → `0`.
4. `grep -c "motor escolhido: Automático" index.html` → `1`.
5. `grep -c "Automatizar" index.html` → still `1` (the MOTORES grid card on
   line 403 is intentionally untouched).
6. The file parses as valid HTML — a quick smoke check is enough; no tooling
   change beyond opening the file in a browser would catch a syntax break.

## Critical files

- `~/dev/ekoa-site/index.html` — the ONLY file edited. Line 361 specifically.

## Out of scope

- The MOTORES grid card title (`<h3>Automatizar</h3>` line 403). Renaming the
  engine itself is a separate, much larger change.
- `plano-flexivel.html`, `temp-legal-vertical/`, `previous-site/`,
  `_standalone-src.html` — none are the home page.
- The JS translation maps in `previous-site/js/main.js` (legacy code).
- Any rebuild / deploy pipeline — the implement step ships the source edit only.

## Verification recipe (for implement + review)

```bash
cd ~/dev/ekoa-site
git --no-pager diff --stat index.html
git --no-pager diff index.html
grep -c "motor escolhido: Automatizar" index.html
grep -c "motor escolhido: Automático" index.html
grep -c "Automatizar" index.html
```
