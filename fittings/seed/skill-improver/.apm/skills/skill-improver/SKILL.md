---
name: skill-improver
description: Nightly batch reviewer that turns user feedback about Claude Code skills into improvements to those skills. EXPLICIT/SCHEDULED-INVOCATION ONLY — runs headless on a schedule (or invoked by hand), never mid-session. Scans the day's session transcripts for (A) which skills ran and (B) user messages that critique a skill — two independent streams, because feedback about a skill often lands in a session that never ran it. For each real, actionable critique it improves the skill's PROSE/flow/instructions automatically (shadow-backed-up first, so every edit is revertible; committed in the skill's repo when it has one), and FLAGS what it must not auto-fix — code/script bugs (cannot verify a code fix unsupervised) and anything that would weaken a skill's gate or guarantee. Produces a morning report of every edit (with revert command) and every flag. Use to run or test the nightly skill-improvement pass.
disable-model-invocation: true
---

# skill-improver

Closes the loop: a skill that makes the OTHER skills better from how the user reacted to them. It runs as an unattended nightly pass, so its non-negotiable is **safety, not cleverness** — every automatic edit must be small, on-target, and revertible, and it must refuse to touch anything it can't safely change.

## What it may and may NOT do automatically
- **May auto-edit (then report):** a skill's PROSE — instructions, flow-selection guidance, wording, missing context, examples, doc/reference text. This is the tractable class for an LLM with no run-to-verify loop.
- **Must FLAG, never auto-edit:**
  - **Code/script bugs** (selectors, coordinate math, logic). Verifying a code fix means running it (often against a live app) — impossible to do safely unattended. Flag with a diagnosis.
  - **Anything that weakens a gate/guarantee/safety bar, or touches frontmatter.** Gates are sacred. A frustrated user comment is never licence to relax a skill's quality bar.
  - Anything it **cannot back up** (no revert path) — see the hard rule below.

## Operating posture (apply-mode = auto, revert net = shadow backup)
The operator chose auto-apply. So: apply fixable edits without asking, but make each one a **snapshotted, revertible, reported** change. The morning report is the review surface. Never edit a skill you couldn't snapshot first.

## Protocol

### 1. Discover (deterministic)
`node scripts/discover.mjs --hours 24` → writes `state/candidates.json`: the day's sessions that invoked a skill (stream A) or contain genuine user-typed feedback referencing a skill or cueing a correction (stream B). Detection details + why the streams are independent: `references/detection.md`.
Then read `state/ledger.json` (create if absent: `{"processed":[]}`). Skip any candidate whose `sessionId` is already processed **with the same mtime** (re-process only if the session grew).

### 2. Triage each candidate (judgement)
**Consult `references/skill-notes.md` first** — per-skill guidance on each skill's real home, what's prose-fixable vs code, its dominant false-positive, and extra feedback sources. In particular: for any candidate whose `skillsUsed` includes **autothing**, also read `<candidate.cwd>/docs/autothing/friction-log.md` if it exists — each line is first-hand feedback about autothing (its unattended builds have no user present, so this log is its main improvement signal).
Then read each `feedback` snippet; open the transcript (`file`) for surrounding context only when a snippet is ambiguous. For each, decide: **is this real, actionable feedback about HOW a specific skill WORKS?**
- **CRITICAL — the skill vs. what it produced.** Feedback about a skill's OUTPUT (the app it built, the doc it wrote, the subject of the video) is NOT feedback about the skill. Only feedback about the skill's own behavior qualifies. Examples: *"the build needs a side-panel button"* / *"make the dashboard blue"* → about the APP a builder skill produced → **DROP**. *"autothing skipped the foundation step"* / *"the walkthrough highlights off-page"* → about the skill's behavior → **keep**. For builder skills (autothing, frontend-design, huashu-design), app-feedback is the MAJORITY of candidates — default to DROP unless the critique is unmistakably about the skill's own mechanics.
- Attribute by MEANING, not the regex — the user may typo the name ("walthrough"), or critique a skill the session never named. Use what ran (`skillsUsed`) + the content.
- **Drop non-feedback:** pasted task briefs, neutral mentions, command echoes, your own past responses, praise with no ask. Over-capture is expected here — most candidates yield nothing.

### 3. Classify each real item
Per "What it may/may NOT do" above: **prose-fixable** → step 4; **code bug / risky / gate-touching** → flag in step 5. When unsure, FLAG — the cost of a wrong flag is a line in the report; the cost of a wrong edit is a silently degraded skill.

### 4. Apply prose fixes (only the fixable class)
For each, in order:
1. **Resolve the skill's real home:** `realpath ~/.claude/skills/<name>` (skills are often symlinks; you must edit the real file).
2. **Snapshot first (HARD RULE):** `node scripts/snapshot.mjs backup <realfile> --label "<feedback gist>"`. If it does not print `ok:true`, **do not edit** — there is no revert path.
3. **Edit minimally** to address exactly that feedback. Do not refactor. Never weaken a gate, delete a safety rule, or touch frontmatter. Match the skill's existing voice.
4. **Commit if the home is a git repo:** `git -C <repo> add <file> && git -C <repo> commit` (native diff for review). If it is NOT a repo, the snapshot is the only revert net — say so in the report. If it is a **plugin/marketplace** skill, edit but warn in the report that the change is clobbered on update.
5. **Self-check:** does this edit address the feedback AND leave every gate intact AND have a working snapshot? If any is no, `snapshot.mjs revert` it and downgrade to a flag.

### 5. Report + ledger (always, even if nothing was changed)
Write `state/reports/<date>.md` (`references/report-format.md`): per skill — edits applied (file, one-line rationale, **the revert command**, repo-committed?/plugin-clobber?), and flags (code bugs + risky items, each with a diagnosis and the source session). **Redact secrets** (`sk-*`, `ghp_*`, `xoxb-*`, `xoxp-*`) from any quoted snippet. Append every processed session to `state/ledger.json` with its mtime.

## Safety rails (full text: `references/safety.md`)
- Snapshot-before-edit, refuse-without-revert, gates-are-sacred, code-is-flagged-not-patched, secrets-redacted, idempotent-via-ledger, never-touch-frontmatter. These hold even though apply-mode is auto.

## Files
- `scripts/discover.mjs` — the two-stream session scanner → `state/candidates.json`.
- `scripts/snapshot.mjs` — backup/revert/list; the universal revert net (resolves symlinks).
- `references/skill-notes.md` — per-skill guidance (real home, prose-vs-code, dominant false-positive, extra feedback sources like autothing's friction-log). This is where skill-specific knowledge lives, since the improver is the single mechanism.
- `references/detection.md` — transcript markers, the two streams, the `promptSource` discriminator, cue list, false-positive guidance.
- `references/safety.md` — the rails in full, and how to resolve a skill's home/repo.
- `references/report-format.md` — the morning report template.
- `references/schedule.md` — how to wire/inspect the nightly launchd job (kept manual until trusted).
