---
name: cortex-automations
description: Drive a REMOTE automation runner from this session through the `cortex` CLI - list what you may start, start a run under an idempotency key, poll it to a conclusion, and read its logs. Use when the work is a long, gated or integration-heavy job that already exists as an automation on a runner you hold a user-scoped key for, or when you are asked how a run of one went. Do NOT use for local YAML automations (that is the local automations engine, a different Fitting), and do NOT reach for it to CREATE an automation, mint a key, or approve a gated run - none of those are on this surface.
---

# Remote automations

An automation runner that is not this machine. It stays up while the session does not, it keeps
each run's state, and it holds its own integrations - so long, gated, multi-step work belongs
there rather than in the session. What belongs HERE is the decision to start that work, the
following of it, and acting on the outcome. This skill is that seam, and `cortex automations`
is the whole of it: a run lifecycle over a public contract, authenticated by one user-scoped key.

**Three things to know before the first call**, because each one is a wrong assumption waiting
to be reported as fact:

1. **`watch` polls.** It calls `status` on an interval until the run settles. It is not a stream
   and it is not tailing anything - the run event stream is not on the key-reachable surface, so
   there is no live feed to prefer. Never describe a watch as live output.
2. **This surface starts automations; it does not author them, key them, or unblock them.** There
   is no `create`, no key minting (you are handed a key, you never bootstrap one), and no way to
   approve a run that parks on a consent gate. Those live on the provider's own surface.
3. **A replayed run was already accepted.** `run --idempotency-key <k>` is at-most-once per
   (automation, key). If the JSON says `"created": false`, the run already existed and nothing
   new was started - so retrying a failed network call with the SAME key is safe and cannot
   double-execute.

## Before you can call anything

The binary comes from an install receipt, never from a hardcoded path:

```bash
receipt="${GARRISON_HOME:-$HOME/.garrison}/cortex-client/install.json"
if [ -f "$receipt" ]; then
  cortex_bin="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).bin||""))' "$receipt")"
else
  cortex_bin="$(command -v cortex || true)"     # PATH is the fallback, not the source of truth
fi
```

**If neither resolves, the capability is simply not installed on this machine.** That is the
shipped default, not a fault: say the remote runner is not available here and stop. Do not try to
install it, and do not treat it as an error to debug.

Configuration is environment-only - there is no config file and no `--key` flag:

- `CORTEX_BASE_URL` - which deployment to talk to. If it is not already exported, read `base_url`
  from the same receipt and export it for the call.
- `CORTEX_API_KEY` - a user-scoped key, delivered from the Vault. Never echo it, never write it
  into a file, a note, a log line or a command you print back.

A missing variable exits **2** naming it, before anything is sent. Exit codes are worth knowing
before you script: `0` the call succeeded, `1` the provider refused it or the request failed
(including a watch that ran out of patience), `2` the invocation was wrong and **nothing was
sent**. `--json` prints exactly one JSON document on stdout, and nothing on stdout on failure.

## The five patterns worth knowing

### 1. Find out what you may start

```bash
cortex automations list                  # id, status, name
cortex automations show <automationId>   # description, step count, last update
```

Do this first when you are asked to "run X" and you do not already hold an id. The list is
scoped to the key: what it does not show, you cannot start.

### 2. Start a run, and always with an idempotency key

```bash
key="nightly-$(date +%Y-%m-%d)"          # something stable and meaningful, not a random UUID
cortex automations run "$id" --input cliente=ACME --idempotency-key "$key" --json > /tmp/run.json
rc=$?
```

Never read that exit code through a pipe - `cortex ... --json | jq` reports `jq`'s status, not
the CLI's, and a failed call writes an EMPTY stdout that `jq` will happily choke on. Redirect,
capture `$?`, then parse.

`--input k=v` repeats; `--inputs-json '{...}'` passes the whole object at once. They are mutually
exclusive.

### 3. Tell a fresh start from a replay

```bash
created=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0,"utf8")).created))' < /tmp/run.json)
# true  -> this invocation started the run
# false -> the run already existed for that key; nothing new was started
```

The `runId` is identical either way, so the flag is the only signal. This is what makes retrying
safe: on a timeout or a network failure, run the SAME command again with the SAME key rather than
inventing a new one - at most one run will ever exist for that pair. Report a replay honestly
("that run was already started") instead of claiming you started it.

### 4. Follow it, then read the status yourself

```bash
cortex automations watch "$runId" --interval-ms 2000 --timeout-ms 300000 --json > /tmp/watch.json
rc=$?    # 0 = polling concluded; 1 = still unsettled when the timeout expired (WATCH_TIMEOUT)
```

**Exit 0 does not mean the work succeeded** - it means the polling concluded. The run's own
`status` field is the answer, and there are nine of them:

| status | what it means | what to do |
|---|---|---|
| `idle` | accepted, not started yet | keep polling |
| `running` | in progress | keep polling |
| `completed` | finished, successfully | read the outcome, report it |
| `failed` | finished, unsuccessfully | `logs` for the failing step |
| `cancelled` | stopped deliberately | report it; do not silently re-run |
| `awaiting_consent` | parked on a human approval gate | hand it back to the principal |
| `paused_for_user` | parked, needs a human decision | hand it back to the principal |
| `awaiting_integration` | parked on an external system | report the block |
| `awaiting_daemon` | parked on a worker that is not up | report the block |

`watch` stops on any of the last six. The four parked states are **blocked, not failed, and not
finished** - saying "the run failed" when it is waiting for someone to approve it is a wrong
report, and you cannot clear the gate from here.

A long run does not need a long watch: it is legitimate to watch with a short timeout, tell the
principal the run is in progress with its id, and check `status` later. Do not hold a session
open polling for an hour.

### 5. Explain a failure

```bash
cortex automations status "$runId"
cortex automations logs "$runId"         # per-step logs, in order, possibly truncated
```

Read the failing step's log before theorising. If the logs are truncated, say so rather than
presenting a partial log as the whole story.

## Reporting rules

- A non-zero exit means the call did not do what it says. Never report a run as started, finished
  or successful on the strength of having typed the command - check the exit code, then the run's
  `status`.
- Distinguish the three "not a success" shapes when you report: **failed** (the work ran and did
  not work), **blocked** (parked on a gate; someone else must act), and **not reachable** (the CLI
  is absent, the key is missing, or the provider refused the request).
- Quote the `runId`. It is the only handle the principal has for following up, and it survives the
  session.
- The key never appears in output you produce. If a command you are about to print would contain
  it, print the variable name instead.
