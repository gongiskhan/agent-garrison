---
name: autothing-codex-checkpoint
model: sonnet
effort: medium
description: Targeted CROSS-MODEL security checkpoint — a small number of SERIAL, high-effort OpenAI Codex (`codex exec`) passes over the security-critical surfaces of the whole repo (authz/tenant/injection, the shared/ contract, the anonymisation/egress pipeline, auth middleware + session handling), each scoped to a narrow invariant rubric, not an open-ended review. Invoked ONCE by autothing's final phase (default ON); real findings loop the affected scope back to autothing-implement as an ad-hoc fix. Standalone, run it against any repo and report the verdict per scope. Use for "run the codex checkpoint", "final security pass with Codex", "cross-model check before shipping", or as the run-level cross-model gate of a build. NOT the per-slice gate (the conditional per-slice cross-model pass is codexSliceReview in the build loop — build/boundary-feature only; this checkpoint is the run-level whole-repo pass, unchanged) and NOT a general-purpose code review (Codex here only hunts the named invariants, never free-ranges).
---

# autothing-codex-checkpoint

The genuine cross-model check in the autothing pipeline, repositioned: instead of a cheap Codex pass on every slice diff (which mostly re-derived opinions Claude already had — see `~/.claude/skills/autothing/references/decisions.md`), Codex now runs a **small number of expensive, narrowly-scoped, high-effort passes over the security-critical surfaces of the whole build**, once, at the end. Per-slice decorrelation is now handled by fresh Anthropic context (`autothing-adversarial-review`, `autothing-adversarial-test`); this skill is what still needs a genuinely different model.

## When it runs
Invoked **ONCE**, by autothing's Phase 5 (the final phase), after `buildable-remaining == 0` and before the terminal `GLOBAL GATE:` line — the run-level analogue of a per-slice gate. **Default ON**; the operator can disable it with `--no-codex` (recorded openly as `codexCheckpoint:off`, never a silent skip). Standalone, run it any time against a finished (or in-progress) repo.

**Order within the final phase — this runs AFTER the built-in security review, not instead of it.** Claude Code's own built-in security review runs ONCE earlier in Phase 5, **BEFORE** this checkpoint. So this cross-model pass adversarially checks a surface the built-in review has already cleaned — **two decorrelated passes, not two overlapping ones**: same-model Anthropic first, cross-model Codex second, each catching what the other's blind spots miss. (Profile gating of the built-in review, for context: **build** always runs it; **feature** runs it when the slice touched security-boundary surfaces; **patch** never un-escalates into it. This checkpoint's own default-ON gating is unchanged by that.) This checkpoint's own findings are **recorded and triaged alongside the built-in review's verdict** — one final-phase security picture from two models, not a separate silo. Its mechanics below are unchanged; only the ordering is fixed.

## Default scopes — overridable by the run brief
Each scope is ONE `codex exec` invocation with a **narrow rubric**: the invariant list plus the files in scope, "find violations" — never an open-ended "review this repo."

| Scope | Invariants (find violations of) | Files in scope |
|---|---|---|
| **(a) Whole-repo security review** | Authz/tenant-isolation bypass, cross-tenant or cross-user data leakage, injection paths (SQL/command/template/SSRF), secrets logged or committed | `git ls-files` for the project's source (excluding vendored/generated/build output) |
| **(b) The `shared/` contract** | A breaking change to a type, exported signature, or versioned schema that other packages/services depend on, shipped without being flagged as breaking | The project's `shared/` (or equivalent common/lib) directory |
| **(c) The anonymisation/egress pipeline** | PII crossing an external egress point unmasked; an anonymisation transform applied after (not before) egress; a code path that bypasses the anonymiser entirely | The project's anonymisation/data-egress modules |
| **(d) Auth middleware + session handling** | A protected route not actually covered by the auth middleware; session fixation/replay; logout that does not invalidate the session server-side | The project's auth/session middleware files |

- **(a) always applies** to any repo. **(b)/(c)/(d) assume specific architecture** (a shared contract package, an anonymisation pipeline, auth middleware) that not every target project has — **if a scope's named files/directories do not exist in this repo, record it `skipped (reason: not-applicable)` and move on; do not invent an invocation to hit a quota.**
- **The run brief can override or add scopes** — read it for anything naming a different or additional focus area (e.g. "focus the security checkpoint on the payments module") and fold that in as its own scoped invocation.
- **Budget: 3-5 invocations total**, a cost guideline (checkpoint calls run at high effort — the most expensive tier in the whole pipeline), not a hard quota to fill or shrink to. Run every scope that genuinely applies; if the brief adds enough scopes to exceed 5, keep the highest-risk ones and fold the rest into a combined invocation rather than dropping them silently.

## Hard rules (same reasons as the old per-slice gates, still true)
- **Serialize every `codex exec`** — one at a time, run-wide (and never concurrently with any other Codex call elsewhere in the run). Concurrent codex processes rotate and REVOKE the shared OAuth token.
- **Always redirect stdin from `/dev/null`.** Read the result from `--output-last-message <file>`; never pipe stdout into tail/head.
- **Preflight once per run:** `codex --version`; confirm auth with `codex exec -m gpt-5.5 -c model_reasoning_effort=low 'reply OK' </dev/null` (a cheap ping, distinct from the real high-effort calls below). **Auth via API KEY, not ChatGPT sign-in** (unattended runs must not drain the interactive account's 5-hour/weekly pool — the G8 credit-death mode — set a budget cap; see `references/codex-checkpoint.md`). Missing binary → self-unblock (`npm i -g @openai/codex`). A genuine auth failure is an **external blocker** for this gate — never silently skip and report clean; a mid-run quota/auth death is recorded `degraded (codex-unavailable)` and the run continues.
- **Pin model + effort on every real call — verified against the installed CLI, do not assume:** `codex exec -c model_reasoning_effort=high -m gpt-5.5 …` (confirmed working against `codex-cli 0.142.0`; re-verify with `codex --help` / `~/.codex/config.toml` if the installed version differs, and record what was actually used). Unlike the old per-slice gates, effort here is fixed at `high` — there is no escalation ladder, because every scope is already the highest-value, most-scrutinized check in the run.
- **Sandbox:** `-s read-only` — every scope here is static inspection of committed/working-tree code, never a live app drive (that decorrelation is `autothing-adversarial-test`'s job now).

## Per-invocation recipe
```bash
DIFFSTAT="$(git --no-pager diff --stat 2>/dev/null | tail -1)"
echo "CODEX CALL: gate=codex-checkpoint scope=<a|b|c|d|custom> model=gpt-5.5 effort=high files=[<scope files>]"
codex exec -s read-only -m gpt-5.5 -c model_reasoning_effort=high \
  --skip-git-repo-check -C "<projectDir>" \
  --output-schema "$HOME/.claude/skills/autothing-codex-checkpoint/assets/codex-checkpoint.schema.json" \
  --output-last-message "<runDir>/codex-checkpoint-<scope>.json" \
  "Checkpoint scope: <scope name>. Inspect ONLY these files/dirs: <scope files>.
   Find violations of EXACTLY these invariants — nothing else, this is not a general review:
   <the scope's invariant list from the table above>.
   Return ONLY JSON matching the schema. verdict=clean only if you cannot support any
   material, defensible violation from the named files; otherwise issues-found with
   grounded findings citing file:line." </dev/null
```
Full auth/preflight/serial-call background this skill adapts from: `references/codex-checkpoint.md` (adapted from the old per-slice reference, `~/.claude/skills/autothing/references/codex-verification.md`, which this skill supersedes for cross-model duty).

## Triage — Claude is the deciding authority
Same principle as the old adversarial-review loop: Codex findings are advisory, not directives.
- **Claude independently agrees it is a real, material violation** → hand it to `autothing-implement` as an **ad-hoc fix** (a described change — file/line + the violated invariant + recommendation; this is not a FLOW_PLAN slice, so it does not consume any slice's retry ceiling). Re-run **that scope's invocation only** after the fix.
- **Claude does not agree** — false positive, out-of-scope, or immaterial → do not apply it; record a one-line rebuttal (file:line + why).
- **Ceiling: 2 re-checks per scope that had a real finding.** If a real, agreed violation is still unfixed after 2 fix-and-recheck passes, the scope is `issues-open` — this is a genuine unmet gate (not a quiet pass), and forces the global gate to `completed-with-blockers` with the violation named in `docs/decisions.md`.

## Verdict per scope
- **`clean`** — no material finding survives (or Codex returned `clean` outright).
- **`issues-fixed`** — real finding(s) found, applied, and the scope re-checked clean within the 2-recheck ceiling.
- **`issues-open`** — a real, agreed finding survives past the ceiling. Blocks a clean `passed` global verdict.
- **`skipped`** — either `reason: not-applicable` (the scope's files don't exist in this repo) or `reason: operator-disabled` (`--no-codex`).

## Durable record (evidence-index.json — run-level, schema: `~/.claude/skills/autothing/assets/evidence-index.example.json`)
```jsonc
"codexCheckpoint": {
  "status": "clean",              // clean | issues-fixed | issues-open | skipped
  "scopes": [
    { "scope": "a-security", "verdict": "clean", "by": "codex/gpt-5.5", "effort": "high", "at": "<iso>", "report": "<runDir>/codex-checkpoint-a-security.json" },
    { "scope": "b-shared-contract", "verdict": "skipped", "reason": "not-applicable", "at": "<iso>" }
  ],
  "overrides": [],                 // per-finding rebuttals, same shape as the old codexReview.overrides
  "at": "<iso>"
}
```

## Loop role + output
- **In an autothing build:** run once in Phase 5. Print `GATE codex-checkpoint: <clean|issues-fixed|issues-open|skipped(operator-disabled)> — <summary>` in the lead context, per the family's lead-print invariant. `issues-open` forces `completed-with-blockers`.
- **Standalone:** run all applicable scopes against the target repo and report each scope's verdict + findings; do not auto-fix unless asked.

## Files
- `references/codex-checkpoint.md` — the adapted operational reference: preflight/auth, the serial-call rule, the per-scope invocation recipe, output-schema handling. Adapted from `~/.claude/skills/autothing/references/codex-verification.md`, which this skill supersedes for cross-model duty (that file is retained for history but marked superseded).
- `assets/codex-checkpoint.schema.json` — the JSON Schema passed to `codex exec --output-schema` for every scope invocation.
