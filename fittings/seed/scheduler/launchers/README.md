# Scheduler launchers — same Node daemon, any supervisor

The scheduler is a plain, OS-agnostic Node process:

```
node scheduler.mjs daemon --health-port 7099
```

It depends on nothing from Claude Code and nothing OS-specific — it ticks cron
jobs and supervises listeners whether or not the operative is up. To make it
**always-on**, hand it to whatever process supervisor the host already runs. The
daemon is the same in every case; only the supervisor's unit file differs.

All units reference these env vars (set them to absolute paths for your install):

- `SCHEDULER` — absolute path to `scheduler.mjs`
- `GARRISON_SCHEDULER_JOBS` — jobs file (default `~/.garrison/scheduler-jobs.json`)
- `GARRISON_SCHEDULER_LOG` — log file (default `~/.garrison/scheduler.log`)
- `GARRISON_SCHEDULER_HEALTH_PORT` — `/health` port (default `7099`)

Health check (any platform):

```
curl -s http://127.0.0.1:7099/health
# {"status":"ok","startedAt":"…","ticks":N,"pid":…,"listeners":[…]}
```

| Supervisor | Unit | Install |
|---|---|---|
| systemd (Linux) | `systemd/garrison-scheduler.service` | `systemctl --user enable --now garrison-scheduler` |
| launchd (macOS) | `launchd/io.garrison.scheduler.plist` | `launchctl load -w ~/Library/LaunchAgents/io.garrison.scheduler.plist` |
| PM2 (any) | `pm2/ecosystem.config.cjs` | `pm2 start pm2/ecosystem.config.cjs` |
| Docker (any) | `docker/Dockerfile` | `docker run -d --restart=always …` |

SIGTERM/SIGINT trigger a graceful shutdown (listeners stopped, `/health` closed,
exit 0), so every supervisor's stop/restart is clean.
