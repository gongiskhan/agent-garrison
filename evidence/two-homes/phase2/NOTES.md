# Phase 2 — two homes

11 September 2026. Implementation owner: dev-madrid, shared main.

Phase 1's restore and live screenshot gate passed before phase 2 began. The phase 2 backend is committed; launcher activation and live migration have not happened.

Confirmed differences from the brief:

- The existing default composition includes Basic Memory but does not station coord-agentmail. The latter still declares the single Memory faculty. Current stationing is preserved: Basic Memory has explicit `shared: [claude-code, codex]`; coord-agentmail receives its sharing hint when equipped. The operator was asked about adding it and has not answered.
- Compose and Muster do not render their config through ConfigForm in this tree. The Sharing section must be reused in their actual forms as well as fitting views.
- The default memory selection has `register_codex_gemini: false`. Explicit user sharing is independent of that old all-or-none setting. Its user setup pass installs only selected runtime primitives, without re-registering vault projects or scheduler duties.
- APM force install can overwrite existing content. Shared reconciliation first installs into a temporary project to identify prospective paths, then refuses changed or unowned collisions. Identical pre-existing user files retain a preservation record and cannot later be removed by unshare.
- Modified lock-owned files are preserved and exempted from subsequent name-based quarantine. Otherwise a retained `garrison-*` file would immediately be removed by the next legacy sweep, contradicting the preservation requirement.
- The legacy-name sweep runs after the user composition lock is available, so a shared legacy-named skill is recognized as shared. Owned-file and hook/MCP cleanup still begins only after the Garrison APM install succeeds.
- Migration retries reuse the pristine snapshot and durable quarantine progress. An install failure before that barrier performs no user-config cleanup.
- Existing memory tests exposed a copied Archive helper whose new `../label.mjs` dependency was missing. Retaining its `archive/src/paths.mjs` and `archive/label.mjs` layout restores its fail-closed predicate without changing policy.

Verification so far: 58 focused backend tests passed (one opt-in coordination integration skipped), including the actual memory sharing script, collision refusal, quarantine, native TOML ownership, clean leak checks and interrupted migration recovery. The 74 memory backend/shadow tests passed. Typecheck passed. Lint exits successfully with an existing ListeningControl effect-cleanup warning; the whole phase gate is not yet claimed.

All materialization fixtures use temporary homes. No node's user configuration has been migrated. Required inventory, live home reports and screenshots will be captured during the guarded sequential rollout.
