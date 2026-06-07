---
name: garrison-architecture
description: Decide module boundaries and file/IO shape for Agent Garrison host-config libs (src/lib/*) and the surface-wiring pattern (page + component + api route + lib + Sidebar NavLink), keeping it consistent with the Vault template and the existing runner/capabilities/metadata model. Use when adding a new src/lib module or UI surface. Do NOT use for visual judgement (garrison-design-audit) or test authoring (garrison-testing).
---

# garrison-architecture

Verbs: bound modules, shape IO. Nouns: `CLAUDE.md` "High-level architecture", `docs/SPEC.md`, `docs/UI-FITTINGS.md`.

## The surface pattern (copy Vault verbatim)
`src/app/<x>/page.tsx` (server) → `src/components/<x>/<Panel>.tsx` (client, `useAppShell()`) → `fetch /api/<x>` → `src/app/api/<x>/route.ts` (`export const runtime = "nodejs"`, `dynamic = "force-dynamic"`, `jsonError` helper) → `src/lib/<x>.ts` (file IO). Add a NavLink in `src/components/chrome/Sidebar.tsx`.
Templates: `src/app/vault/page.tsx`, `src/components/vault/VaultPanel.tsx`, `src/app/api/vault/secrets/route.ts`, `src/lib/vault.ts`.

## Host-config IO rules (this feature)
All host-config libs (settings, install, claude-md) are direct `~/.claude` / `~/.garrison` IO like `vault.ts`/`hosts.ts` — **NOT Faculties, no new capability kind**. Inject base paths (`claudeHome`, `lockPath`, `settingsPath`) for testability. **Read-fresh → mutate → write whole document; never blind-overwrite; never clobber files Garrison does not own.** One writer per host file (the settings writer is shared by Settings UI + hook installs).
