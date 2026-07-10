# Architecture

<!-- NOUNS doc. The system shape and where things live. The build keeps this current: when a slice changes structure, update the relevant section in the same change. Referenced by path. Keep under ~200 lines. -->

## Stack
- Framework: {{e.g. Next.js 16 App Router}}
- Language/build: {{TypeScript, build/typecheck/lint commands}}
- Data: {{db / store, e.g. Supabase}}
- Test: {{unit: vitest; e2e: @playwright/test}}
- Package manager / layout: {{npm workspaces monorepo, etc.}}

## System shape
<!-- Services / workspaces and how they relate. A small diagram in text is fine. -->
- {{workspace/service}} — {{responsibility}} — path: `{{path}}`
- {{workspace/service}} — {{responsibility}} — path: `{{path}}`

## Key modules (by path)
<!-- The paths an agent edits for each area. These back the CLAUDE.md routing index + path-scoped rules. -->
| Area | Paths |
|------|-------|
| {{UI/routes}} | `{{path/**}}` |
| {{automations/integrations}} | `{{path/**}}` |
| {{api/backend}} | `{{path/**}}` |

## Integration points
<!-- External systems (e.g. Microsoft 365 Graph: mail/SharePoint/SSO), auth model, webhook endpoints, how secrets are provided. Never inline secrets here. -->
- {{integration}} — auth: {{model}}; endpoints: `{{path}}`; secrets via: {{env var names, not values}}.

## Running locally
- Dev: `{{command}}` (port: {{fixed or how it is resolved, e.g. read from ../app.port}})
- Seed/auth needed to drive flows: {{command / stored-session approach}}
