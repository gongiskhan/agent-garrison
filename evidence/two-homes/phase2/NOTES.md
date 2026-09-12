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

## 12 September checkpoint

Source checkpoint 7d698b3d includes launcher activation (1b90b52c) and all Phase 2 code. It has not been deployed. No production user config was migrated, and the Phase 2 gate remains pending live runtime acceptance and the ordered node rollout. Phases 3 and 4 have not started; the single final review has not run.

Verification is green: 8,618 tests in 748 suites; 26 pre-existing opt-in tests in 9 suites remain gated. Typecheck and lint pass without warnings. The 12 required browser journeys pass on desktop and phone. The real APM migration in a fresh temporary home quarantines one synthetic legacy skill and reports zero leaks; the real terminal CLI connects shared Basic Memory. Three final live screenshots were inspected directly against the exact copy and layout, with image-hash-bound verdicts beside the PNGs. These are dev-profile fixture checks, not production rollout evidence.

The actual CLI rewrites settings and removes unknown `_garrison` tags. The user provenance ledger therefore also records a normalized complete hook-group hash. That preserves the Shared chip and cleanup ownership after normalization; an edited or expanded user group is left untouched. The fresh CLI receipt records one shared hook before and after the real CLI call, Basic Memory Connected, and zero leaks. Tests verify that the original removed group is archived verbatim.

The visual journey exposed obsolete home descriptions and an indistinguishable selected tab. Both are corrected. Existing install controls remain until Phase 4; their labels now describe the Garrison home. The earlier whole-suite races were test readiness assumptions: WebKit's asynchronous render and Drill's post-health boot sweep are now awaited. The capture cleanup uses its mounted reference, eliminating the lint warning.

Additional confirmed adaptations: original Quarters APM dependencies are retained unless an equipped-selection receipt proves they were deselected; auth-home setup alone does not enable a Sharing switch; Basic Memory's explicitly Shared `garrison-memory` name remains, while unshared discipline skills do not. No remote provider configuration was changed.

Madrid's metadata-only pre-migration inventory has 98 entries (07:57:48Z). Refresh it immediately before that node's eventual deployment. Peer inventories and migration reports must be recorded on their owner nodes during the prescribed Mini, Air, Pro, then Madrid-last sequence; the fifth live CSG node is included before Madrid.

The direct scoped account-token delivery proposed for SDK runtime acceptance was rejected by automatic approval review. No credential file was created and no token was sent. The screenshot checks were completed without that action using the repository's existing direct-inspection pattern. The separate live model smoke still awaits the user's scoped account approval. Automatic main deployment remains paused to prevent activation outside the prescribed rollout. Bounded stable Capture deployment has been coordinated separately; it must not restart the shell/gateway or invoke composition setup.
