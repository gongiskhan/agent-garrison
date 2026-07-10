# Cross-model checkpoint (Codex) — operational reference

Adapted from `~/.claude/skills/autothing/references/codex-verification.md` (the old per-slice 3A/3B reference, now superseded for cross-model duty — that file covered a Codex pass on every slice diff; this one covers a handful of high-effort, whole-repo-scoped passes run once, in the final phase). The hard operational rules below (serialize, `</dev/null`, preflight/auth) are unchanged from that file because they are properties of the `codex` CLI itself, not of how often it is called.

## Why the CLI, not `/codex:adversarial-review`
The `codex` plugin's slash commands are `disable-model-invocation: true` — a skill running autonomously cannot trigger them. This skill drives `codex exec` directly (self-contained, no dependency on the plugin's `${CLAUDE_PLUGIN_ROOT}`). The plugin is still useful to the operator interactively; this skill just doesn't route through it.

## SERIALIZE every Codex call — hard rule (empirically required)
Codex uses one shared token per credential. **Two `codex exec` processes running at the same time rotate and REVOKE a shared ChatGPT OAuth refresh token** ("your refresh token was revoked. Please log out and sign in again") — which kills the gate for the rest of the run. One `codex exec` in flight at a time, run-wide, for the whole autothing run. **Codex is now called at TWO points in a run** — the conditional per-slice `codexSliceReview` (build-loop step 3b) and this final-phase checkpoint — so they MUST serialize against each other (and never overlap two checkpoint invocations, nor a standalone invocation running elsewhere). The API-key auth below (not ChatGPT sign-in) both avoids the interactive account's usage pool AND sidesteps the OAuth-refresh-revocation footgun.

## Always redirect Codex stdin from /dev/null — hard rule (empirically required)
`codex exec` reads stdin when it is not a TTY; in a non-interactive context it will otherwise block forever on "Reading additional input from stdin...". Every invocation ends with `</dev/null`. Capture the result via `--output-last-message <file>` and read that file — never pipe Codex stdout into `tail`/`head` (the pipe re-triggers the stdin-read hang and can truncate the JSONL).

## Keep each invocation FOCUSED on its named scope — hard rule (empirically required)
An unfocused review listing many files with an open-ended "review this" empirically spun `codex exec` into a runaway (50+ live processes, 14+ minutes, zero output); a focused single-concern prompt over a small, named file set completes reliably. Every checkpoint prompt names its invariant list AND its file scope explicitly — never a directory dump, never "review the codebase."

## Preflight — once per run
```bash
codex --version            # present?
codex login status         # must print "Logged in ..."
codex exec -m gpt-5.5 -c model_reasoning_effort=low 'reply OK' </dev/null   # cheap ping; confirms exec actually works, not just login status
```
- **Missing binary** → self-unblock: `npm i -g @openai/codex`, then re-check. Only a FAILED install is a blocker.
- **Not logged in / token revoked** → external blocker; needs operator credentials. `codex login status` can falsely report "Logged in" while `codex exec` still 401s, so the exec ping above is the real confirmation. Log a blocker in `docs/decisions.md` naming the exact failed command, and let the global gate fall to `completed-with-blockers` — never silently skip the checkpoint and report a clean pass.

## Authenticate via API KEY for unattended runs — NOT ChatGPT sign-in
autothing's Codex usage (both this checkpoint AND the per-slice `codexSliceReview`) runs **unattended**, so it MUST authenticate with a **Codex/OpenAI API key**, not an interactive `codex login` against the ChatGPT account. Why this is a hard rule, not a preference:
- **The G8 credit-death failure mode.** A ChatGPT sign-in shares the interactive account's **5-hour and weekly** usage pool. An unattended run at high effort drains that pool and then dies mid-run on quota — while also cutting off the human's own interactive Codex. Run `20260706` hit exactly this at G8.
- **Set the API key** in the environment Codex reads (e.g. `OPENAI_API_KEY` / the key path in `~/.codex/config.toml`) so `codex exec` uses key-based billing on a **separate meter** from the ChatGPT plan. Confirm with the preflight exec ping.
- **Set a budget cap** on that key (a hard spend limit at the provider) so a runaway loop cannot exhaust the account — the checkpoint runs at the most expensive tier, and the per-slice pass can fire on every `build`-profile slice.
- **Credit/availability death is survivable, never faked.** If `codex exec` fails on quota/auth/availability mid-run, the caller records the gate slot `degraded (codex-unavailable)`, emits the mid-run notification, logs a `DECISION`, and CONTINUES — the run is never blocked on a dead meter, and a degraded slot is never reported as a clean verdict (per-slice policy in autothing/SKILL.md "Per-slice Codex adversarial pass"; checkpoint policy in the Preflight blocker rule above).

## Verify the model + effort flags against the installed CLI — do not assume
Confirmed once against `codex-cli 0.142.0` (2026-07-06): `codex exec -c model_reasoning_effort=high -m gpt-5.5 'reply OK' </dev/null` succeeds and reports `reasoning effort: high`. `~/.codex/config.toml` also shows a `model_migrations` entry (`"gpt-5.4" -> "gpt-5.5"`), i.e. gpt-5.5 is the CLI's own forward path, not a guess. **Re-run this same check** (`codex --help`, and the `-c model_reasoning_effort=high -m gpt-5.5 'reply OK' </dev/null` ping) if the installed CLI version has changed since, and record whatever model/effort combination actually worked in `codexCheckpoint.scopes[].by`/`.effort`.

## Per-scope invocation (read-only — never workspace-write)
Every scope is a single `codex exec` call:
```bash
echo "CODEX CALL: gate=codex-checkpoint scope=<name> model=gpt-5.5 effort=high files=[<scope files>]"
codex exec -s read-only -m gpt-5.5 -c model_reasoning_effort=high \
  --skip-git-repo-check -C "<projectDir>" \
  --output-schema "$HOME/.claude/skills/autothing-codex-checkpoint/assets/codex-checkpoint.schema.json" \
  --output-last-message "<runDir>/codex-checkpoint-<scope>.json" \
  "Checkpoint scope: <scope name>. Inspect ONLY these files/dirs: <scope files>.
   Find violations of EXACTLY these invariants — nothing else, this is not a general review:
   <invariant list>.
   Return ONLY JSON matching the schema. verdict=clean only if you cannot support any
   material, defensible violation from the named files; otherwise issues-found with
   grounded findings citing file:line." </dev/null
```
Read the JSON (`verdict`, `findings[]`) per SKILL.md's Triage section.

## Output schema
`assets/codex-checkpoint.schema.json` — one `verdict` (`clean`/`issues-found`) + `findings[]` per scope, each finding naming which invariant it violates (not a free-form review comment).
