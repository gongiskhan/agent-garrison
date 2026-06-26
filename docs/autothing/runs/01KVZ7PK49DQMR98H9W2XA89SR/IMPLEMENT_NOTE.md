# Implement note — Rename Automatizar label (s1)

## What changed

`~/dev/ekoa-site/index.html` line 361: `motor escolhido: Automatizar` →
`motor escolhido: Automático` (with accent, matching Portuguese site
conventions per the plan's decision).

## Acceptance — all 5 checks pass

| # | check | result |
|---|-------|--------|
| 1 | `git diff --stat index.html` shows 1 file, +1/-1 | pass |
| 2 | only the `motor escolhido:` line changes, indentation preserved | pass |
| 3 | `grep -c 'motor escolhido: Automatizar' index.html` → 0 | pass |
| 4 | `grep -c 'motor escolhido: Automático' index.html` → 1 | pass |
| 5 | `grep -c 'Automatizar' index.html` → 1 (MOTORES grid card preserved) | pass |

## Files touched

- `~/dev/ekoa-site/index.html` — one line changed.
