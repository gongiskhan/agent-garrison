# GARRISON-MARATHON-V1 — run-level security review

Run `20260712-173530-81e1c448`. Diff scope: `f8f9166..HEAD` (169 files,
+17,113 / -626). Deterministic wall (gitleaks + semgrep + `npm audit`) run over
the finished tree; per-slice codex adversarial passes already ran during the
build loop and their findings were fixed + rechecked (containment guards,
loud-failure gaps — see each slice `review.md`).

## Verdict: clean — no security regression introduced by this run.

## 1. Secrets — gitleaks (`gitleaks.json`)
6 findings across the full 548-commit history; **0 real credentials, 0
introduced by the marathon as live secrets.**

| # | File | Introduced | Assessment |
|---|------|-----------|------------|
| 1 | `…/phase0-e7-e14.md:61` | this run (doc) | **False positive** — the generic-api-key entropy rule tripped on the phase-0 prose describing the `ollama-local` provider config (`ANTHROPIC_API_KEY=""`, `dummyToken "ollama"`). No credential; it documents that the local provider runs keyless. |
| 2 | `…/20260710-…/slices/S9/evidence.json:24` | prior run (2026-07-11) | Pre-existing demo `GARRISON_TOKEN` in a *previous* run's evidence artifact. Out of this run's scope; not a live credential. |
| 3 | `docs/phases/spike-resume-model.md:10` | 2026-05-16 | Pre-existing. Literal "secret phrase" example in a spike doc. |
| 4-5 | `docs/phases/PHASE_6_PROTOCOL.md:98,1011` | 2026-05-11 | Pre-existing. Example `"token"` values in protocol documentation. |
| 6 | `fittings/seed/dev-env/dist/dev-env.bundle.js:27035` | 2026-07-01 | **False positive** — a minified webpack bundle variable (`FourKeyMap = <hash>`) matching the entropy heuristic. |

No new `.env`, no vault material, no live token entered the tree. The vault
(`data/vault.json`, 0600, AES-256-GCM) and crypto were untouched this run
(deferred-stays-deferred).

## 2. SAST — semgrep (`semgrep.txt`)
`p/javascript` + `p/typescript` over the **38 security-boundary source files**
the marathon added/modified (`src/lib/*.ts`, `src/app/api/**`,
`fittings/seed/**/lib/*.mjs`, `…/scripts/*.mjs`). **0 findings.**
The containment-sensitive additions (clone symlink-escape guard in
`src/lib/clone.ts` + `fitting-files.ts`, index symlink-skip in
`garrison-assistant/lib/index-store.mjs`, citation realpath-containment in
`improver/lib/shadcn-patterns.mjs`, external-pointer reject in
`composition-switch.ts`) were the codex per-slice targets and carry their own
regression tests.

## 3. Dependencies — `npm audit` (`npm-audit.txt`)
4 vulnerabilities (1 high, 2 moderate, 1 low): `next` (high), `postcss`
(moderate, transitive via next), `dompurify` (moderate, via monaco-editor),
`monaco-editor` (low, via dompurify). **`package.json` had a 0-line diff this
run — none introduced by the marathon.** All are pre-existing framework/editor
transitive deps whose fix requires a breaking major bump (`next@16.2.10`).
**Deferred** — a closing evidence phase does not ship a breaking framework
upgrade; recorded here, not silently passed.

## Boundary posture confirmed this run
- The non-Anthropic probe path is fenced: `ollama-local` launches with
  `ANTHROPIC_BASE_URL→localhost` and `ANTHROPIC_API_KEY` cleared
  (`runtime-selection.ts:187-190`), verified live by final-gate FINDING 3 + the
  probe-acceptance FINDINGs 3-4 (zero Anthropic calls on the probe path).
- Clone / assistant-index / improver-citation file access is realpath-contained
  to the repo root; symlink escape is rejected (codex-reviewed + tested).
- Localhost-only, single-user, no-auth posture unchanged.
