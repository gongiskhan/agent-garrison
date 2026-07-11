# LANDING — GARRISON-RUNTIMES-V1 (run 20260711-194226-168684d3)

Verdict: **passed** · 8/8 slices · full-bar (no gates disabled) · profile: build
Commit range: `ea871d7..4e132b4` on `main` (33 commits, all local — not pushed).

## What shipped

Runtime agnosticism for Garrison. Claude Code is now a first-class Runtime
Fitting; providers are policy data; the primary runtime is selectable from the
composer with no operative running; Quarters is a per-runtime configuration
surface driven by descriptors — the Claude Code deep surface unchanged.

| Slice | Sentinel | What landed |
|---|---|---|
| S1 | RUNTIME-CC-FIT-OK | `claude-code-runtime` declares the D3 provider mechanism + D5 Quarters descriptor; seed composition selects it; strict-validated parser blocks (discriminated unions). |
| S2 | PROVIDERS-POLICY-OK | `providers` is a policy section; `compilePolicy` carries it; both hardcoded registries (stage-b `PROVIDERS`, runtime-selection `PRIMARY_PROVIDERS`) deleted; loud missing/unknown/locked-vs-absent. |
| S3 | PRIMARY-SELECT-OK | `primaryRuntime` in the policy file; composer Primary picker fed by `/runtime-fittings` (works gateway-down); uninstalled runtime unselectable in UI + 422 in file; per-mechanism provider editor. |
| S4 | PRIMARY-WIRED-OK | Gateway pool warms the policy-named engine as the operative; claude-code byte-for-byte; agent-sdk/codex/gemini via their adapters + warm-time bridge probe; loud on missing fitting / failed probe. |
| S5 | QUARTERS-DESCRIPTOR-OK | Descriptor-driven generic Quarters tier: allowlist-contained file API, realpath-contained log tails, format-validated + sha-guarded + projection-refusing writes; claude-code deep tier registered untouched. |
| S6 | QUARTERS-CODEX-GEMINI-OK | codex + gemini descriptors over their REAL native surfaces (`~/.codex/config.toml`, `~/.gemini/settings.json`), render-verified live. |
| S7 | QUARTERS-SECTIONS-OK | Composition-driven Quarters sections: single-runtime = classic expanded; >1 = all-collapsible, all collapsed; localStorage-persisted. |
| S8 | PROJECTION-PRIMARY-OK | Per-primary orchestrator prompt: claude-code unchanged; agent-sdk via SDK systemPrompt; codex/gemini projected to AGENTS.md/GEMINI.md (marker-guarded, never clobbers hand-authored); committed gated live smoke asserts the `[route:]` token. |

## Gate summary

- typecheck 0 · lint 0 · **full vitest 1972 passed / 0 failed** · isolated production build green.
- Every slice: deterministic wall + committed test + securityWall (gitleaks/semgrep clean) + fresh-context Anthropic review + cross-model Codex slice pass (all `needs-work → fixed → re-verified`, ratchet tests added) + independent Anthropic test.
- UI slices (S3/S5/S7): ux-qa (contrast/tap measured) + **verified evidence videos** (2 recordings, 13/13 beats, gallery http://100.88.165.46:8099/).
- Run-level: **deliberate-red** (guard neutered → its tests red → restored) · **mutation 8/8 killed, 0 survivors** · batched API adversarial test (4 surfaces, 23/23) · **built-in security-review clean** · **Codex checkpoint clean**.

## Assumptions / deltas (decided autonomously)

- **A1** claude-code-runtime pre-existed → extended in place (not authored). **A7 / FINDING-E7 delta**: no AGENTS.md/GEMINI.md projection path existed in the repo (invalidated D7 as written) → `orchestrator-projection.ts` became the single per-primary writer, prompt delivered via the native context convention. Intent preserved.
- **Five seed providers, not four** (brief said four): live seed targets also reference `anthropic` (the agent-sdk spelling of the Max-OAuth path); seeded so existing routing resolves identically.
- **SDK_PROVIDERS retained** as the agent-sdk runtime's capability/auth-mode catalog (D3 runtime-level metadata: capability records, minimax/llm-proxy exist nowhere else) — connection data is policy `providers`; no mirror.
- New deps (all registry-verified before install): `yaml@2.9.0` (orchestrator server manifest reads), `smol-toml@1.7.0` (generic-tier TOML validation), `fast-check@4.9.0` devDep (boundary property tests).

## DEVIATIONS logged (see RUN_LOG)

- The first codex slice-review call ran with repo MCP servers enabled and basic-memory stamped note frontmatter onto CLAUDE.md + 152 markdown files, and registered two rogue basic-memory projects. **Fully remediated**: frontmatter stripped/reverted, projects removed, CLAUDE.md restored. All subsequent codex gates use an isolated `CODEX_HOME` with no MCP.
- An in-repo `next build` corrupted the dev server's `.next` (dev server was restarted clean); the build gate now runs in an isolated hardlink clone.

## Needs human eyes (non-blocking)

- **D8 experiment path**: a non-claude primary hosts a working operative session for prompt delivery, but the interactive turn path (slash-inject / respawn) still assumes a Claude PTY — it now degrades LOUDLY (`route-switch-skipped` log) rather than crashing. Full non-PTY turn wiring is explicitly future work, flagged by the S4 review.
- **agent-sdk prompt read-timing**: the assembled prompt is read to bytes at gateway warm time (vs the claude-code file-path re-read); a mid-run soul reassembly would keep stale bytes on an agent-sdk primary. Recorded for the P8/turn-wiring follow-up.
- 33 commits are on local `main`, unpushed — the user pushes when ready.
- The stuck `security-review` identification sub-task never wrote its file (this session's agent-notification anomaly); the review was completed by direct read of every security-critical surface + the run-level Codex checkpoint. Both clean.

## Session anomaly (friction-logged)

Subagent COMPLETION notifications were never delivered this entire session (agents ran fine — a probe proved a Haiku agent wrote a file in seconds). Every reviewer/explorer/advtest verdict was recovered via scratchpad-file side-channels. Suggested skill fix: gate skills should ALWAYS write results to a runDir file as the primary return channel.
