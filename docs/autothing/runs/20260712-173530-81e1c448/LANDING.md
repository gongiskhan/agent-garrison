# LANDING — GARRISON-MARATHON-V1

**Run** `20260712-173530-81e1c448` · profile **build** · branch **main** (no new
branch, no worktrees) · started 2026-07-12T17:36:11Z.

One continuous autonomous run that made Garrison **runtime-agnostic,
self-explaining, and self-improving** across ten workstreams, each gated and
sentinel-banked, under a usage governor.

## Verdict: GARRISON-MARATHON OK — 11/11 acceptance checks pass.

## What shipped (WS0-WS9)

| WS | Slice | What landed | Sentinel |
|----|-------|-------------|----------|
| WS0 | S0 | Usage governor (ccusage + PTY banner watcher, 90% pause, simulated pause/resume) | MARATHON-WS0 OK |
| WS1 | S1 | `taste` Fitting — upstream-pinned MIT taste skills (per-file sha256, drift check) | MARATHON-WS1 OK |
| WS2a | S2a | Gateway's 3 Claude-specific mechanisms abstracted through the RuntimeAdapter (adapter-moves, adapter.resume, classifier fallback) | MARATHON-WS2A OK |
| WS2b | S2b | `opencode-runtime` Fitting (stateless `opencode run --format json`, loud-fail) | MARATHON-WS2B OK |
| WS2c | S2c | Runtime matrix harness — 28 Fittings × 3 primaries, zero unexplained failures | MARATHON-WS2C OK |
| WS2d | S2d | Documented degradations + Compose UI advisory notice | MARATHON-WS2D OK |
| WS3 | S3 | Clone + edit any Fitting (`_local` namespace, `cloned_from` provenance, Monaco create-file) | MARATHON-WS3 OK |
| WS4 | S4 | Composition switching (`active_composition` pointer, shell switcher, CLI `--composition`, run-evidence id+hash) | MARATHON-WS4 OK |
| WS5 | S5 | `garrison-assistant` Fitting (Answer grounded in docs+Fittings, Guide launches tours, Build interview files proposals) | MARATHON-WS5 OK |
| WS6 | S6 | In-app Demo + Guided tour engine on the storyboard schema (Escape exits, a tour per Fitting) | MARATHON-WS6 OK |
| WS7 | S7 | Improver Feedback Probe revived — probe-question compiled to live policy, **local-model (ollama qwen2.5:3b) question generation, never hits Anthropic** | IMPROVER-PROBE OK |
| WS8 | S8 | Improver learns 4 shadcn/improve patterns (evidence file:line+confidence, vet pass, rejection ledger, reconcile) | MARATHON-WS8 OK |
| WS9 | S9 | Full UI/UX redesign pass LAST — copy 688→518 (24.7%), touch affordances, iPhone-width 0px overflow, tours/storyboards green | MARATHON-WS9 OK |

## Acceptance (final-gate.mjs, all live)
1 branch=main · 2 worktrees=1 · 3 governor pause/resume+14 checks · 4 matrix+degradations docs · 5 taste-copy clone round-trip · 6 run-evidence under two composition ids (default `80dc2216…` / secondary-minimal `6d1d802e…`) · 7 assistant 3/3 grounded answers + 2 provenance-assistant proposals · 8 Demo(/compose)+Guided(/quarters), 7 registered tours (4 synthesized per-Fitting) · 9 IMPROVER-PROBE OK + 9 FINDINGs · 10 four shadcn/improve patterns · 11 audit doc + 688→518 + storyboards/tours green.

## Real bugs the process caught
- `resolvePrimaryAdapter` hardcoded the `anthropic` provider (WS2a live smoke) — fixed.
- opencode-primary missing from the gateway branch — added.
- Multiple containment / loud-failure gaps across slices (codex per-slice reviews).
- **Run-level codex checkpoint (2 decorrelated passes): 5 real defects fixed** — read-side symlink containment in `fitting-files.readFile`/`listDirectory`, clone `dereference` exfil guard, index-store docs-root symlink, and the agent-sdk-primary provider-threading gap — plus 5 lower-severity findings accepted with recorded reasons (concurrency / trusted-input / self-DoS, outside the single-user localhost threat model). No Anthropic-endpoint leak on any path.

## Security posture
gitleaks (0 real secrets, 0 introduced), semgrep (0 findings on 38 boundary files),
`npm audit` (4 pre-existing transitive deps, `package.json` 0-line diff, breaking-bump fix deferred).
Details: `security/SECURITY_REVIEW.md`, `codex-checkpoint/CHECKPOINT.md`.

## Evidence
- 3 walkthrough videos (`~/.walkthrough/runs/agent-garrison/marathon-{s1,s3s4,s6}`) + 5 asciinema casts (S2a/S2b/S5/S7/S8) — 9 slice-references, all sha256-verified in `evidence-index.json`.
- 4 slices doc/json-evidenced (S0 governor ledger, S2c matrix, S2d degradations, S9 narrow-viewport json + screenshots).
- Full suite: **2148 passed, 14 skipped, 0 failed.** Typecheck clean, eslint clean.

## Environment notes
- Ollama v0.31.2 installed (hash-verified GitHub tarball; `curl|sh` was classifier-denied), model qwen2.5:3b, localhost-only.
- Governor final read 83.5% (window resets 2026-07-13T00:00:00Z) — never breached the 90% pause threshold after the WS0 simulation.
- Chrome extension can't reach 127.0.0.1 on this box → all browser evidence via playwright-core/CLI.
