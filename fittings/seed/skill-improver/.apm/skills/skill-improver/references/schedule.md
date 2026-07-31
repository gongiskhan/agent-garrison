# Nightly schedule — INSTALLED

The nightly pass is wired on this machine via launchd.

- **Job:** `com.ggomes.skill-improver` (`~/Library/LaunchAgents/com.ggomes.skill-improver.plist`)
- **Runs:** daily at **03:30** local (`StartCalendarInterval`; if the Mac is asleep, launchd runs it at next wake). `RunAtLoad` is false so loading never fires an immediate edit pass.
- **Wrapper:** `~/.claude/skill-improver/nightly.sh` → `claude -p "/skill-improver run tonight's pass" --dangerously-skip-permissions`
- **Auth:** headless `claude` authenticates in the launchd context via the stored login (verified with a launchd probe at install). If it ever stops authenticating (e.g. after a re-login), drop `export CLAUDE_CODE_OAUTH_TOKEN=...` (or `ANTHROPIC_API_KEY=...`) into `~/.claude/skill-improver/.token` — the wrapper sources it.
- **Logs:** `~/.claude/skill-improver/state/cron.log` (per-run start/end + the agent's stdout), plus `state/cron.out` / `state/cron.err` (launchd). **Reports:** `state/reports/<date>.md`.

## Manage
```
launchctl unload ~/Library/LaunchAgents/com.ggomes.skill-improver.plist   # disable
launchctl load -w ~/Library/LaunchAgents/com.ggomes.skill-improver.plist  # enable
launchctl start com.ggomes.skill-improver                                 # run once now (FULL pass — auto-edits per apply-mode)
launchctl list | grep skill-improver                                      # status (PID, last exit)
```
Change the time by editing `StartCalendarInterval` in the plist, then unload + load.

## Caveats
- `launchctl start` triggers a real pass that auto-applies prose fixes (shadow-backed-up, in the report). Use it to see tonight's behavior on demand.
- Idempotent via `state/ledger.json` — extra runs are harmless (already-processed sessions are skipped unless they grew).
- Headless/cron runs may lack interactively-authenticated MCP servers; this skill needs none.
- To stop permanently: `launchctl unload` then delete the plist.
