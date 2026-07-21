# Conventions

<!-- Small, canonical, stable. This is one of the TWO docs CLAUDE.md @imports, so keep it genuinely short (under ~80 lines) — it loads into every agent's context. Verbs-in-skills / nouns-in-docs: procedure lives in area skills, not here. -->

## Code
- {{naming, file layout, module boundaries}}
- {{error handling pattern}}
- {{state/data-access pattern}}

## UI
- Design tokens are the source of truth: {{path}}. Do not hardcode colours/spacing.
- No emoji in UI code; use text labels or SVG/icon fonts.
- {{i18n requirement, if any}}

## Tests
- Unit: {{vitest}}. E2E: {{@playwright/test}} in `{{e2e dir}}`.
- E2E must assert no console errors.

## Commits / safety
- {{branching / commit rules}}
- Never commit secrets; `.env*` and `auth.json` stay gitignored.
