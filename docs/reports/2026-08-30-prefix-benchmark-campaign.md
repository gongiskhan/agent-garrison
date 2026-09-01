# Prefix benchmark campaign

Garrison commit under test: `05de0adad20e70e957bc7c1342bf4d3fbee0d9a5`
Seed repo: `bench/prefix-campaign-2026-08-30/seed` at tag `seed-v1` (`a395683960f84cc4627c32b9145dbff346730ee1`)
Spec: `bench/prefix-campaign-2026-08-30/TASK.md`, md5 `252f37f2bcdf6bd460dce95a1eb306f3`, unchanged for every run
Raw per-run JSON: `bench/prefix-campaign-2026-08-30/runs/*.measure.json`. Arm B also has `*.proxy.jsonl` (one line per API exchange).

## How each arm was measured

**Arm B** is routed through `bench/prefix-campaign-2026-08-30/harness/measure-proxy.mjs` via `ANTHROPIC_BASE_URL`, as specified. The proxy reads the provider's own usage block off each `/v1/messages` response (merging `message_start` and `message_delta` for streamed replies) and was checked against the CLI's own `total_cost_usd` before the campaign: on a one-word probe it reported `in=2 out=4 cw=0 cr=107,582`, matching the CLI exactly. Each run's `cliReportedCostUsd` field is the same cross-check repeated per run.

**Arm A is NOT routed through that proxy, and could not be.** Garrison's gateway starts its own logging proxy on an ephemeral port and sets `ANTHROPIC_BASE_URL` for its spawned stretches from it; redirecting that would be a Garrison configuration change, which this task forbids. Arm A is therefore read from the conversation ledger, whose `usage` events are the provider's own blocks captured per API call at the runtime adapter.

Both arms are priced by the same function (`priceUsage` over `data/model-rates.json`) over provider-reported usage, and both count one API request per provider response. The capture POINT differs. That is the one asymmetry in this campaign and no number below is free of it.

## Every run

| run | cache | cost | input | output | cache read | cache write | API req | assistant turns | tool calls | tool searches | wall | models (requests) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-1 | cold | $1.5658 | 120,025 | 34,264 | 1,662,223 | 191,400 | 62 | 119 | 282 | n/a | 461s | claude-haiku-4-5 1, claude-sonnet-5 48, gpt-5.6-sol 9 |
| A-2 | cold | $1.6547 | 132,970 | 35,845 | 1,854,302 | 149,719 | 75 | 159 | 199 | n/a | 602s | claude-haiku-4-5 2, claude-sonnet-5 43, gpt-5.6-sol 24 |
| A-3 | cold | $2.8310 | 209,141 | 60,204 | 3,764,138 | 207,273 | 134 | 221 | 378 | n/a | 1113s | claude-haiku-4-5 1, claude-sonnet-5 91, gpt-5.6-sol 36 |
| A-4 | cold | $2.5812 | 230,092 | 56,353 | 3,091,107 | 215,534 | 106 | 193 | 344 | n/a | 832s | claude-haiku-4-5 1, claude-sonnet-5 73, gpt-5.6-sol 27 |
| B-1 | warm | $3.1916 | 2,141 | 42,451 | 9,697,349 | 205,828 | 65 | 65 | 72 | 0 | 537s | claude-sonnet-5 65 |
| B-2 | warm | $2.3214 | 113 | 29,195 | 8,601,018 | 77,256 | 57 | 57 | 62 | 0 | 339s | claude-sonnet-5 57 |
| B-3 | warm | $1.9827 | 99 | 26,107 | 7,408,118 | 59,957 | 50 | 50 | 56 | 0 | 358s | claude-sonnet-5 50 |
| B-4 | warm | $2.2417 | 2,443 | 44,287 | 6,891,436 | 103,915 | 47 | 47 | 53 | 0 | 450s | claude-sonnet-5 47 |

Cache state is inferred from cache-read tokens on the first API request of the run: zero means cold.

The design expected runs 2-4 of each arm to be warm. Arm A's are not, and cannot be:
a fresh checkout per run is part of the design and the working directory is inside the
cached prefix, so a new directory forks it. Arm B's are warm on arrival because a plain
Claude Code session's prefix is identical across every session on this account, so the
machine keeps it hot. The arms are not on equal cache footing.

`n/a` under tool searches: not visible in the conversation ledger; Arm A tool-search counts are unavailable from this instrument.

## Per arm, the three comparison runs (run 1 excluded as the warmup)

### Arm A — Garrison, current config

Runs 2, 3, 4, all measured **cold**. Run 1 excluded as the warmup.

| metric | median | min | max | spread as % of median | CV |
|---|---|---|---|---|---|
| cost | $2.5812 | $1.6547 | $2.8310 | 45.6% | 26.3% |
| API requests | 106 | 75 | 134 | 55.7% | 28.1% |
| wall clock (s) | 832 | 602 | 1,113 | 61.4% | 30.1% |
| tool calls | 344 | 199 | 378 | 52.0% | 31.0% |

### Arm B — plain Claude Code

Runs 2, 3, 4, all measured **warm**. Run 1 excluded as the warmup.

| metric | median | min | max | spread as % of median | CV |
|---|---|---|---|---|---|
| cost | $2.2417 | $1.9827 | $2.3214 | 15.1% | 8.1% |
| API requests | 50 | 47 | 57 | 20.0% | 10.0% |
| wall clock (s) | 358 | 339 | 450 | 31.0% | 15.5% |
| tool calls | 56 | 53 | 62 | 16.1% | 8.0% |

## Is three runs enough to detect a 20% difference between arms?

Two-sample t-test, alpha 0.05 two-sided, power 0.80. The minimum detectable
effect at n per arm is `(t(0.975,df) + t(0.80,df)) * s * sqrt(2/n)`; as a
fraction of the mean that is a multiple of the coefficient of variation above.

| arm | metric | n | CV | smallest difference detectable at this n | detects 20%? | n needed for 20% |
|---|---|---|---|---|---|---|
| A | cost | 3 | 26.3% | 80% | **no** | 29 |
| A | API requests | 3 | 28.1% | 85% | **no** | 33 |
| B | cost | 3 | 8.1% | 25% | **no** | 4 |
| B | API requests | 3 | 10.0% | 30% | **no** | 6 |

**No. Three runs per arm is not enough, and the two arms are not equally noisy.**

Arm A's cost varies by 45.6% of its median across three runs (CV 26.3%). At three
runs per arm the smallest difference a two-sample test could detect is about 80%.
Detecting a 20% difference at Arm A's observed variance needs **29 runs per arm**;
on API requests, 33; on wall clock, 37.

Arm B is roughly three times steadier - cost CV 8.1%, spread 15.1% - and would
need only 4 runs. The binding constraint is Arm A, so **29 runs per arm** is the
figure for a 20% cost comparison at this variance, and the campaign as specified
is under-powered by about a factor of ten.

Arm A's variance has a visible mechanical source in the data: stretch count. The
three comparison runs used 6, 8 and 7 stretches and cost $1.65, $2.83 and $2.58.
Arm B has no equivalent - it is one session every time. That is a description of
where the variance sits, not a claim about what to do.

## Built apps and checklists

| run | directory | start | checklist |
|---|---|---|---|
| A-1 | `/home/ggomes/dev/armA-1` | `cd /home/ggomes/dev/armA-1 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armA-1.checklist.md` |
| A-2 | `/home/ggomes/dev/armA-2` | `cd /home/ggomes/dev/armA-2 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armA-2.checklist.md` |
| A-3 | `/home/ggomes/dev/armA-3` | `cd /home/ggomes/dev/armA-3 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armA-3.checklist.md` |
| A-4 | `/home/ggomes/dev/armA-4` | `cd /home/ggomes/dev/armA-4 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armA-4.checklist.md` |
| B-1 | `/home/ggomes/dev/armB-1` | `cd /home/ggomes/dev/armB-1 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armB-1.checklist.md` |
| B-2 | `/home/ggomes/dev/armB-2` | `cd /home/ggomes/dev/armB-2 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armB-2.checklist.md` |
| B-3 | `/home/ggomes/dev/armB-3` | `cd /home/ggomes/dev/armB-3 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armB-3.checklist.md` |
| B-4 | `/home/ggomes/dev/armB-4` | `cd /home/ggomes/dev/armB-4 && npm install && npm start` | `bench/prefix-campaign-2026-08-30/runs/armB-4.checklist.md` |

Quality was not assessed here. Each checklist has its rows blank.

## Recorded along the way, not acted on

- Port 3000 was already held by a tailnet listener on this machine, so the seed's default port is 3100 via settings.js. Not investigated further.
- Garrison resolves a card's `project` as a NAME under ~/dev that must contain `.git`; a path or a non-repo silently degrades the stretch to the composition directory. The arm runners clone into ~/dev/armA-N so it resolves. The round-two benchmark runs degraded this way without it being noticed at the time.
- The conversation ledger does not carry the `server_tool_use` block a tool search produces, so Arm A tool-search counts are unavailable from that instrument and are reported as n/a rather than 0.
- Every Arm A run started COLD despite running back to back. A fresh checkout per run is part of the design, and the working directory is inside the cached prefix, so a new directory forks it. Cross-run prefix sharing measured on 2026-08-29 held only because those runs all shared one working directory (the project failed to resolve and every stretch ran in the composition dir).
- Every Arm B run started WARM on its first request (run 1 read 92,754 tokens before doing anything). A plain Claude Code session's prefix is identical across sessions on this account, so the machine keeps it hot; Garrison's is not, because it contains the composition's assembled prompt and the project directory. The arms are therefore not on equal cache footing, and Arm B is favoured by it.
- Arm A run 3 and run 4 each ran an extra implement/adversarial-review cycle (8 and 7 stretches against run 2's 6). Not investigated.

## Raw per-run JSON

### A-1

```json
{
 "arm": "A",
 "run": 1,
 "conversationId": "01M18R4D8NT0ZTYEKQ9GD8NPB3",
 "dir": "/home/ggomes/dev/armA-1",
 "startCommand": "npm install && npm start",
 "measuredFrom": "conversation ledger (per-API-call usage events)",
 "started": "2026-08-30T07:11:22.851Z",
 "ended": "2026-08-30T07:19:04.268Z",
 "wallClockSeconds": 461,
 "costUsd": 1.5658368500000002,
 "unpricedModels": [],
 "inputTokens": 120025,
 "outputTokens": 34264,
 "cacheReadTokens": 1662223,
 "cacheWriteTokens": 191400,
 "apiRequests": 62,
 "assistantTurns": 119,
 "toolCalls": 282,
 "toolCallsByName": {
  "tool": 20,
  "Bash": 63,
  "Read": 140,
  "Write": 40,
  "Edit": 19
 },
 "toolSearches": null,
 "toolSearchesNote": "not visible in the conversation ledger; Arm A tool-search counts are unavailable from this instrument",
 "stretches": 6,
 "requestsByModel": {
  "claude-haiku-4-5": 1,
  "claude-sonnet-5": 48,
  "gpt-5.6-sol": 9
 },
 "firstRequestCacheRead": 0,
 "cacheState": "cold",
 "ratesUpdated": "2026-08-29"
}
```

### A-2

```json
{
 "arm": "A",
 "run": 2,
 "conversationId": "01M18RMB8DTYZMH7G433PC2XD6",
 "dir": "/home/ggomes/dev/armA-2",
 "startCommand": "npm install && npm start",
 "measuredFrom": "conversation ledger (per-API-call usage events)",
 "started": "2026-08-30T07:20:05.084Z",
 "ended": "2026-08-30T07:30:06.977Z",
 "wallClockSeconds": 602,
 "costUsd": 1.65468185,
 "unpricedModels": [],
 "inputTokens": 132970,
 "outputTokens": 35845,
 "cacheReadTokens": 1854302,
 "cacheWriteTokens": 149719,
 "apiRequests": 75,
 "assistantTurns": 159,
 "toolCalls": 199,
 "toolCallsByName": {
  "tool": 12,
  "Agent": 4,
  "Bash": 85,
  "Read": 60,
  "Edit": 14,
  "Write": 24
 },
 "toolSearches": null,
 "toolSearchesNote": "not visible in the conversation ledger; Arm A tool-search counts are unavailable from this instrument",
 "stretches": 6,
 "requestsByModel": {
  "claude-haiku-4-5": 2,
  "claude-sonnet-5": 43,
  "gpt-5.6-sol": 24
 },
 "firstRequestCacheRead": 0,
 "cacheState": "cold",
 "ratesUpdated": "2026-08-29"
}
```

### A-3

```json
{
 "arm": "A",
 "run": 3,
 "conversationId": "01M18S6Q3R2H370VYNWNEJGJDA",
 "dir": "/home/ggomes/dev/armA-3",
 "startCommand": "npm install && npm start",
 "measuredFrom": "conversation ledger (per-API-call usage events)",
 "started": "2026-08-30T07:30:07.047Z",
 "ended": "2026-08-30T07:48:40.524Z",
 "wallClockSeconds": 1113,
 "costUsd": 2.8310484000000002,
 "unpricedModels": [],
 "inputTokens": 209141,
 "outputTokens": 60204,
 "cacheReadTokens": 3764138,
 "cacheWriteTokens": 207273,
 "apiRequests": 134,
 "assistantTurns": 221,
 "toolCalls": 378,
 "toolCallsByName": {
  "tool": 14,
  "Agent": 4,
  "Bash": 138,
  "Read": 122,
  "Write": 46,
  "Edit": 51,
  "TaskOutput": 3
 },
 "toolSearches": null,
 "toolSearchesNote": "not visible in the conversation ledger; Arm A tool-search counts are unavailable from this instrument",
 "stretches": 8,
 "requestsByModel": {
  "claude-haiku-4-5": 1,
  "claude-sonnet-5": 91,
  "gpt-5.6-sol": 36
 },
 "firstRequestCacheRead": 0,
 "cacheState": "cold",
 "ratesUpdated": "2026-08-29"
}
```

### A-4

```json
{
 "arm": "A",
 "run": 4,
 "conversationId": "01M18T8PJJRFQJZRQGAMKPH0Q2",
 "dir": "/home/ggomes/dev/armA-4",
 "startCommand": "npm install && npm start",
 "measuredFrom": "conversation ledger (per-API-call usage events)",
 "started": "2026-08-30T07:48:40.605Z",
 "ended": "2026-08-30T08:02:33.205Z",
 "wallClockSeconds": 832,
 "costUsd": 2.58124135,
 "unpricedModels": [],
 "inputTokens": 230092,
 "outputTokens": 56353,
 "cacheReadTokens": 3091107,
 "cacheWriteTokens": 215534,
 "apiRequests": 106,
 "assistantTurns": 193,
 "toolCalls": 344,
 "toolCallsByName": {
  "tool": 22,
  "Agent": 4,
  "Bash": 115,
  "Read": 111,
  "Write": 41,
  "Edit": 51
 },
 "toolSearches": null,
 "toolSearchesNote": "not visible in the conversation ledger; Arm A tool-search counts are unavailable from this instrument",
 "stretches": 7,
 "requestsByModel": {
  "claude-haiku-4-5": 1,
  "claude-sonnet-5": 73,
  "gpt-5.6-sol": 27
 },
 "firstRequestCacheRead": 0,
 "cacheState": "cold",
 "ratesUpdated": "2026-08-29"
}
```

### B-1

```json
{
 "arm": "B",
 "run": 1,
 "sessionId": "67b47085-6687-4779-b785-e530f69c69a1",
 "dir": "/home/ggomes/dev/armB-1",
 "startCommand": "npm install && npm start",
 "measuredFrom": "measurement proxy (per-request usage off the wire)",
 "started": "2026-08-30T08:03:46Z",
 "ended": "2026-08-30T08:12:43Z",
 "wallClockSeconds": 537,
 "costUsd": 3.1915738000000005,
 "unpricedModels": [],
 "inputTokens": 2141,
 "outputTokens": 42451,
 "cacheReadTokens": 9697349,
 "cacheWriteTokens": 205828,
 "apiRequests": 65,
 "assistantTurns": 65,
 "toolCalls": 72,
 "toolCallsByName": {
  "Bash": 52,
  "Read": 11,
  "Edit": 3,
  "Write": 5,
  "Skill": 1
 },
 "toolSearches": 0,
 "stretches": 1,
 "requestsByModel": {
  "claude-sonnet-5": 65
 },
 "firstRequestCacheRead": 92754,
 "cacheState": "warm",
 "cliReportedCostUsd": 3.1915737999999987,
 "cliNumTurns": 75,
 "cliIsError": false,
 "ratesUpdated": "2026-08-29"
}
```

### B-2

```json
{
 "arm": "B",
 "run": 2,
 "sessionId": "5ce9b043-1cb6-4be8-8fba-73101b2ac9ad",
 "dir": "/home/ggomes/dev/armB-2",
 "startCommand": "npm install && npm start",
 "measuredFrom": "measurement proxy (per-request usage off the wire)",
 "started": "2026-08-30T08:12:44Z",
 "ended": "2026-08-30T08:18:23Z",
 "wallClockSeconds": 339,
 "costUsd": 2.3214036,
 "unpricedModels": [],
 "inputTokens": 113,
 "outputTokens": 29195,
 "cacheReadTokens": 8601018,
 "cacheWriteTokens": 77256,
 "apiRequests": 57,
 "assistantTurns": 57,
 "toolCalls": 62,
 "toolCallsByName": {
  "Bash": 43,
  "Read": 10,
  "Edit": 3,
  "Write": 5,
  "Skill": 1
 },
 "toolSearches": 0,
 "stretches": 1,
 "requestsByModel": {
  "claude-sonnet-5": 57
 },
 "firstRequestCacheRead": 92754,
 "cacheState": "warm",
 "cliReportedCostUsd": 2.3214036000000005,
 "cliNumTurns": 64,
 "cliIsError": false,
 "ratesUpdated": "2026-08-29"
}
```

### B-3

```json
{
 "arm": "B",
 "run": 3,
 "sessionId": "1f948cac-b764-4f62-acd8-03bcb35203b6",
 "dir": "/home/ggomes/dev/armB-3",
 "startCommand": "npm install && npm start",
 "measuredFrom": "measurement proxy (per-request usage off the wire)",
 "started": "2026-08-30T08:18:25Z",
 "ended": "2026-08-30T08:24:23Z",
 "wallClockSeconds": 358,
 "costUsd": 1.9827196,
 "unpricedModels": [],
 "inputTokens": 99,
 "outputTokens": 26107,
 "cacheReadTokens": 7408118,
 "cacheWriteTokens": 59957,
 "apiRequests": 50,
 "assistantTurns": 50,
 "toolCalls": 56,
 "toolCallsByName": {
  "Bash": 37,
  "Read": 11,
  "Edit": 2,
  "Write": 5,
  "Skill": 1
 },
 "toolSearches": 0,
 "stretches": 1,
 "requestsByModel": {
  "claude-sonnet-5": 50
 },
 "firstRequestCacheRead": 104804,
 "cacheState": "warm",
 "cliReportedCostUsd": 1.9827196000000005,
 "cliNumTurns": 58,
 "cliIsError": false,
 "ratesUpdated": "2026-08-29"
}
```

### B-4

```json
{
 "arm": "B",
 "run": 4,
 "sessionId": "be173d5c-060b-477e-8e9d-9f7609452578",
 "dir": "/home/ggomes/dev/armB-4",
 "startCommand": "npm install && npm start",
 "measuredFrom": "measurement proxy (per-request usage off the wire)",
 "started": "2026-08-30T08:24:24Z",
 "ended": "2026-08-30T08:31:54Z",
 "wallClockSeconds": 450,
 "costUsd": 2.2417032,
 "unpricedModels": [],
 "inputTokens": 2443,
 "outputTokens": 44287,
 "cacheReadTokens": 6891436,
 "cacheWriteTokens": 103915,
 "apiRequests": 47,
 "assistantTurns": 47,
 "toolCalls": 53,
 "toolCallsByName": {
  "Bash": 35,
  "Read": 9,
  "Edit": 2,
  "Write": 6,
  "Skill": 1
 },
 "toolSearches": 0,
 "stretches": 1,
 "requestsByModel": {
  "claude-sonnet-5": 47
 },
 "firstRequestCacheRead": 92754,
 "cacheState": "warm",
 "cliReportedCostUsd": 2.2417032,
 "cliNumTurns": 56,
 "cliIsError": false,
 "ratesUpdated": "2026-08-29"
}
```

