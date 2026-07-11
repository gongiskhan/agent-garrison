---
name: autothing-report
description: Send a Slack notification when an autothing run finishes — a summary of the work, a Tailscale URL to the walkthrough video gallery, and Tailscale links to the session logs + run artifacts served IN PLACE (no duplication, via a small standing Node server). autothing calls this as its final step once the global gate is decided; also usable standalone to report on a finished run. Sends via a Slack incoming webhook (AUTOTHING_SLACK_WEBHOOK_URL), falling back to the Slack MCP when interactive. NOT for mid-run progress (that is the PROGRESS line) and NOT for recording the videos (that is autothing-walkthrough).
---

# autothing-report

## Policy-read preamble (soft - D5/D12)

At the start of every invocation, look for the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`).

- **Policy present** (a Garrison run): it is the single authority. This skill
  carries NO model/effort pins - its execution parameters come from the policy
  matrix cell for its phase (`matrix[<phase>][<tier>]`), and its gate duties
  from the bindable phase-skill contract (the Orchestrator fitting's
  PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
  (runDir, card, phase), write the phase's gate-status entry under the runDir,
  and print the phase's `GATE <phase>: <verdict>` line before choosing the next
  list.
- **Policy absent** (standalone, any repo): proceed with the caller-supplied
  context and sensible defaults - NEVER stop. Report to the caller rather than
  writing gate-status/run artifacts, and skip any board/run-engine steps.


Notifies the operator on Slack that an autothing run is done, with a work summary, the **walkthrough video gallery** (Tailscale URL), and the **session logs + run artifacts** as Tailscale links served **in place** (symlinked, never copied). The final step of an autothing run, and a standalone "report on this run" skill.

## When it runs
- **In an autothing build:** Phase 5, AFTER the handover prose and AFTER `globalGate.status` is decided, but **BEFORE** the terminal `GLOBAL GATE:` line (that line releases the goal-loop hook and ends the session, so nothing after it runs). Sending the Slack message is a side-effect, so it is safe to do before that final print.
- **Standalone:** invoke any time against a finished run dir to (re)send the report.

## Inputs
- `<runDir>` = `~/.garrison/runs/<project>/<runId>/` (the evidence home, GARRISON-UNIFY-V1 D19 — nothing run-scoped lives inside the project repo; the repo keeps only work products + committed re-runnable tests), `<runId>`, `<project>`.
- `globalGate.status` + per-slice video links from `<runDir>/evidence-index.json`.
- This session id: `$CLAUDE_CODE_SESSION_ID`.

## Steps

### 1. Gather the summary + gallery URL
- Read `<runDir>/evidence-index.json`: take `globalGate.status`, the per-slice `video.link` values, and the **gallery base URL** (the common `http://<tailscale-ip>:<port>/` prefix of those links — this is what the `walkthrough` skill already publishes; this skill does NOT re-serve the videos).
- Compose a concise **summary** (slices passed/blocked, what was built, any blockers with their cause). Write it to `<runDir>/report-summary.md` so it can be passed by path.
- **Gather EVERY evidence link for the run (D20)** — all slices, all phases, including which phases were OFF and why (rail off / card toggle / operator flag — from the card's `phases` map and each gate-status `skipped` slot) — regardless of how the run was started (chat, board, or skill). Links use the `/runs/<project>/<runId>/...` scheme; the prune (scripts/prune-runs.mjs: newest 20 runs per project or 30 days, whichever retains more; JSON kept indefinitely) may age out heavy media, so the JSON record is the durable spine.

### 2. Publish the logs over Tailscale — WITHOUT duplicating them
Build a per-run directory of **symlinks** to the real files (symlinks reference the originals — no content is copied), then start the standing server:
```bash
mkdir -p ~/.autothing/report/<runId>
# The evidence home is served DIRECTLY at /runs/ (D20) — no per-run symlink
# needed for run artifacts; the canonical link is
#   http://<tailnet>:8091/runs/<project>/<runId>/
# (symlinks under ~/.autothing/report remain supported for extra artifacts)
TRANSCRIPT="$(find ~/.claude/projects -name "$CLAUDE_CODE_SESSION_ID.jsonl" 2>/dev/null | head -1)"
[ -n "$TRANSCRIPT" ] && ln -sfn "$TRANSCRIPT" ~/.autothing/report/<runId>/session-transcript.jsonl
node ~/.claude/skills/autothing-report/scripts/serve.mjs   # prints the Tailscale base URL, e.g. http://100.x.y.z:8091/
```
`serve.mjs` is **idempotent + standing** (self-daemonizes, reuses an already-running instance, survives the session so the links stay live). The per-run logs URL is `<base>/<runId>/`.
- **Default to the curated `run/` artifacts** (plan + gate-status + evidence-index + friction-log — no raw secrets). Symlinking the **raw session transcript** is optional: it is the full session log but **may contain secrets** — only include it if that is acceptable on your tailnet, or redact (`sk-*` / `ghp_*` / `xoxb-*`) first.

### 3. Send the Slack notification
```bash
node ~/.claude/skills/autothing-report/scripts/notify.mjs \
  --project "<project>" --status "<globalGate.status>" \
  --summary "<runDir>/report-summary.md" \
  --gallery-url "<gallery base URL>" \
  --report-url "<base>/<runId>/" \
  --landing-url "<base>/<runId>/run/LANDING.md"
```
- Requires a **Slack incoming webhook** in `AUTOTHING_SLACK_WEBHOOK_URL` (env) or `~/.config/autothing/.env` (`AUTOTHING_SLACK_WEBHOOK_URL=...`). This is the headless-safe path (plain HTTPS POST, no MCP, PTY-safe).
- **Fallback when no webhook is set AND you are interactive:** `notify.mjs` prints the composed Block Kit payload and exits 0; send that same content via the Slack MCP (`mcp__claude_ai_Slack__slack_send_message`). A missing webhook never fails the run.
- **The completion message LINKS the run's `LANDING.md` — the audit packet.** Alongside the walkthrough gallery URL and the logs/artifacts link, the message carries a Tailscale link to `<runDir>/LANDING.md`, served in place at `<base>/<runId>/run/LANDING.md` (the `run/` symlink already exposes it — no extra copy). The operator opens one message and has the summary, the video gallery, the raw logs/artifacts, AND the full audit packet.

## Mid-run event notifications
The completion message above is the end-of-run report. Beyond it, autothing-report also fires **immediate, lightweight alerts** the moment certain events happen mid-run — so the operator watching from Slack learns of a degradation the second it happens, not from a status bar at 1am, and never has to open a second session to find out what changed. These are **separate, lightweight notifications** over the SAME webhook / MCP-fallback path as the end-of-run one (a one-line message, not the full report) — and they are NOT the routine PROGRESS line (still not this skill's job); only these exceptional events fire one:
- **`ABORT`** — the run aborted; name the cause.
- **A model-fallback** — a slice or phase dropped to a different model, **naming the cause**: usage limit, capacity, or classifier-redirect. This is the highest-value alert here — a mid-run model degradation reaches the operator the second it happens, not at the end.
- **`PAUSED`** — a turn-cap landing (the run parked at its turn ceiling).
- **A blocked slice** — a slice that could not clear its gates and blocked.
- **A detected busy-loop** — repeated stop-blocks without progress.
- **`--notify-gates` (optional flag)** — when set, ALSO send a one-liner per gate PASS. Off by default (keeps Slack quiet); turn it on for a run you want to watch gate-by-gate.

Each is a `notify.mjs` call carrying the event's one-liner (same webhook, same interactive MCP fallback, same PTY-safe path); a missing webhook never fails the run, exactly as for the completion message.

## Setup (one-time)
Create a Slack incoming webhook (Slack app → Incoming Webhooks → Add to a channel) and store it (secret — never commit):
```bash
mkdir -p ~/.config/autothing && printf 'AUTOTHING_SLACK_WEBHOOK_URL=%s\n' '<your webhook url>' >> ~/.config/autothing/.env
```

## Notes
- **Tailscale-only exposure.** `serve.mjs` binds `0.0.0.0` and advertises the `tailscale ip -4` address; the links are reachable only on your tailnet (your own devices). If `tailscale` is absent it falls back to a LAN IP (note this in the message).
- **No duplication.** Logs/artifacts are served via symlinks to the originals; nothing is copied. The video gallery is served by `walkthrough`, not here.
- Honest: if the gallery URL is missing (no verified videos) or the webhook is unset, say so in the report rather than omitting silently.

## Files
- `scripts/serve.mjs` — standing, Tailscale-bound, read-only static server (self-daemonizing + idempotent) that serves the per-run symlink dir.
- `scripts/notify.mjs` — composes the Slack Block Kit message and POSTs it to the incoming webhook (prints the payload for the MCP fallback when no webhook is set).
