---
name: ekoa-auth-watchdog
description: Poll prod cortex /health, alert via Slack + macOS notifier on auth state transitions.
---

Run the Ekoa auth watchdog and report the result.

Execute exactly this command and capture stdout + exit code:

  node /Users/ggomes/dev/ekoa-dev/scripts/auth-watchdog.mjs

The script polls https://api.ekoa.io/health, diffs claudeAuth state against ~/.ekoa/data/auth-watchdog.json, and posts to Slack + macOS terminal-notifier on state transitions or every 24h while broken. It is silent when state is unchanged-ok.

After running, output one short line summarizing what happened — for example "state=ok prev=ok notify=false" or "state=broken prev=ok notify=true kind=transition". Do not call any other tools, do not investigate further, do not attempt remediation. The script handles all alerting; your job is just to invoke it.

If the script exits non-zero or the command itself errors, report the exit code and the last 5 lines of output. Otherwise just echo back the script's state line.