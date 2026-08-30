# The boot prefix, the three layers, and what round two actually changed

**Date:** 2026-08-29 · **Round one:** [`2026-08-29-conversation-cost-benchmark.md`](./2026-08-29-conversation-cost-benchmark.md)
**Evidence:** `bench/prefix-2026-08-29/` (decomposition) and `bench/round2/` (benchmark)

---

## 1. Verdict

**The prefix work succeeded at what it targeted and did not move the bill.** Every stretch's
boot prefix fell by **58-61%** — 105,188 tokens to 43,248 on an `implement` stretch, 77,571 to
29,943 on `triage` — and the measurement is exact, reproducible, and reconciles to the provider's
own token counter at 99.8-100.0%. The conversation's total cost did not follow: **$2.11 in round
one, $2.96 and $2.07 in round two**, against baselines of **$1.35, $1.51 and $1.89**. The
mechanism still costs more than a plain Claude Code session on this task, by roughly the same
factor as before.

The reason is not subtle and it is the finding worth keeping: **the boot prefix is not where the
money is.** It is paid once per stretch; the bill is paid per API call, and the call count moved
far more than the prefix did. Round two's two Garrison runs made 132 and 90 calls against round
one's 68 — on the identical prompt, with no steering, on the same machine. **Run-to-run variance
on this task is larger than everything I changed put together**, which is exactly what round one
warned would happen and is now measured rather than asserted.

Confidence: **high** in the prefix decomposition and the size of the cut (directly measured, twice,
two independent ways). **High** that the cut did not reduce total cost on this task. **Low** in any
claim about what the cut is worth in general, because n=2 against a variance band this wide
supports no such claim.

One round-one caveat is retired outright: **the disputed Sonnet rate is resolved**, and the
published $2/$10 is correct (§7).

---

## 2. Headline numbers

| run | cost | API calls | wall | stretches | input | output | cache write | cache read | cache-read share | compactions |
|---|---|---|---|---|---|---|---|---|---|---|
| **R1 Garrison** | $2.1111 | 68 | 449s | 6 | 59,560 | 23,519 | 268,339 | 4,578,893 | 93.3% | 0 |
| **R2 Garrison A** (prefix cuts only) | $2.9576 | 132 | 974s | 7 | 106,272 | 40,700 | 278,637 | 6,465,617 | 94.4% | 0 |
| **R2 Garrison B** (everything) | $2.0654 | 90 | 543s | 6 | 84,997 | 30,673 | 285,093 | 3,162,091 | 89.5% | 0 |
| R1 `claude -p` opus | $1.3493 | 19 | 246s | 1 | 38 | 19,373 | 47,900 | 771,504 | 94.1% | 0 |
| **R2 `claude -p` opus** | $1.5114 | 23 | 289s | 1 | 46 | 20,492 | 53,431 | 929,100 | 94.6% | 0 |
| **R2 `claude -p` sonnet** | $1.8905 | 61 | 524s | 1 | 122 | 43,491 | 125,190 | 4,772,828 | 97.4% | 0 |

All at published list rates from `data/model-rates.json` (`rates_updated: 2026-08-29`), the same
`priceUsage` on every row.

**Read the baselines first.** The same baseline, same model, same prompt, twelve hours apart:
**$1.3493 then $1.5114** — 12% apart with nothing changed. And the *cheaper* model was the *more
expensive* run: Sonnet cost $1.89 against Opus's $1.51 because it took 61 calls and 43k output
tokens to Opus's 23 and 20k. A model's rate does not predict a task's bill.

Against that band, Garrison B at $2.07 versus round one's $2.11 is **not a change**. Garrison A at
$2.96 is a bad draw, and §5 says exactly which draw it was.

---

## 3. Task 1 — where the boot tokens actually go

Route A worked, so Route B became the cross-check rather than the method. The gateway's own
logging proxy (`session_log_proxy`, off by default) captured the **literal request bodies** of a
live conversation; each section was then counted with the provider's `/v1/messages/count_tokens`
endpoint, never a local estimator.

Two defects surfaced getting there. `session_log_proxy` and its dump directory were read by the
gateway but **never projected into its environment by the runner**, so turning the proxy on in a
composition had done nothing at all; and the session log caps payloads, which is right for a log
and useless for auditing a 155,000-character system prompt, so the proxy grew an opt-in raw dump.

### The decomposition, reconciled

| section | triage / haiku-4-5 | share | implement / sonnet-5 | share |
|---|---|---|---|---|
| Fitting capability catalogue (inside the assembled prompt) | 28,128 | 36.3% | ~39,000 | 37.1% |
| Rest of the assembled Orchestrator prompt | 5,365 | 6.9% | ~7,300 | 6.9% |
| Tool schemas (37 tools: 28 built-in + 9 MCP) | 31,238 | 40.3% | 41,275 | 39.2% |
| `claude_code` preset system prompt | 6,012 | 7.8% | 8,228 | 7.8% |
| Injected system-reminders (memory index, skills list, agent types) | 5,640 | 7.3% | 7,870 | 7.5% |
| The brief itself | 980 | 1.3% | 1,462 | 1.4% |
| request floor | 8 | 0.0% | 7 | 0.0% |
| **sum of parts** | **77,371** | | **105,151** | |
| **counted whole request** | **77,433** | | **105,236** | |
| **observed billed prefix** (input + cache write + cache read, first API call) | **77,571** | | **105,188** | |
| **reconciliation** | **99.7%** | | **100.0%** | |

Far above the 85% checkpoint, so Task 2 proceeded.

**The brief is 1.3% of the prefix.** The plan said so from the code and the measurement agrees:
whatever is expensive about a stretch, it is not the brief.

Three things dominate, and two of them are ours:

1. **The capability catalogue is 87% of the assembled prompt** — 109,601 of its 126,101 characters
   were every Fitting's full `for_consumers` guidance, carried by every stretch of every duty
   whether it consulted them or not.
2. **The tool inventory is 40%** — 37 tool schemas, of which `Workflow` alone is 6,393 tokens.
3. The `claude_code` preset, at 6-8k, is the *small* term. The repo's own note that the preset
   carries "a ~14k-token floor, 20-30k with tool schemas" understates today's reality by 2-3x, and
   almost all of the excess is Garrison's own material rather than the harness's.

### An unrelated finding with a large price attached

Counting the **byte-identical** 126KB prompt under four models:

| model | tokens for the same 126KB | tokens for the same 8.8KB of English |
|---|---|---|
| claude-haiku-4-5 | 32,638 | 2,201 |
| claude-sonnet-5 | 45,160 | 3,602 |
| claude-opus-5 | 45,160 | 3,601 |
| claude-opus-4-8 | 45,160 | 3,602 |

**1.384x** on real prompt text, **1.64x** on plain English. Anthropic's pricing page documents this
("Claude 4.7 and later models use a newer tokenizer... approximately 30% more tokens for the same
text"); I measured it before reading it. It means a rate-card ratio understates what a Claude 5
model costs for identical text, and it is now recorded in the rate table.

### Tool usage per duty, measured

Across **33 recorded conversations and 5,829 tool calls**, duties invoked **nine distinct tools**:

| duty | stretches | tools actually invoked |
|---|---|---|
| implement | 30 | Bash 1463, Edit 1018, Write 942, Read 411, Agent 63 |
| writing | 7 | Edit 369, Bash 178, Write 131, Read 44 |
| test | 23 | Bash 407, Write 123, ToolSearch 8, Read 6, Edit 5, TaskOutput 3 |
| plan | 6 | Bash 184, Write 158, Agent 22, Read 20 |
| triage | 11 | Write 87, Read 13, Bash 13, AskUserQuestion 2 |
| ops / discuss / review / other / research / responder | 1 each | Bash, Write, Read only |

**Never called once, by any duty, in any conversation:** `Workflow`, `DesignSync`, `Monitor`, the
three `Cron` tools, `EnterPlanMode`/`ExitPlanMode`, `EnterWorktree`/`ExitWorktree`,
`ScheduleWakeup`, `SendMessage`, `PushNotification`, `RemoteTrigger`, `Skill`, `WebFetch`,
`WebSearch`, `NotebookEdit`, the five `Task*` tools, **and all nine `mcp__garrison__*` tools.**
Full table: `bench/prefix-2026-08-29/tool-usage.json`.

---

## 4. Task 2 — the cut, and what it bought

Two changes, both driven by the tables above rather than by intuition.

**A per-duty tool allow-list.** The Agent SDK's `tools` option takes a positive `string[]`, which
is the only lever that shrinks the schemas *and* survives a CLI upgrade — `disallowedTools` has to
name every tool the installed CLI happens to offer, and silently re-admits anything new. Profiles
live in `harness.mjs` beside the evidence; the duty mapping lives in the gateway's
`harness-profiles.mjs`. Everything uncertain resolves generously: an unmapped duty gets the full
coding profile, and every profile keeps `Write` and `Read` because every duty ends by writing its
handoff.

**The capability catalogue as an index.** `capabilities_detail: index` carries one line per
capability — so a stretch still cannot invent one — and drops the bodies, which are what cost the
tokens. The full guidance did not disappear: it is written to
`.garrison/capability-docs.json` from the same entries at the same moment, and
`mcp__garrison__garrison_capability_doc` returns it verbatim on demand.

The assembled prompt went from **126,539 to 45,803 characters**.

### Measured effect on the boot prefix

| duty / model | before (same day, pre-cut) | after (run A) | after (run B) | cut |
|---|---|---|---|---|
| triage / haiku-4-5 | 77,571 | 29,943 | 29,959 | **−61.4%** |
| implement / sonnet-5 | 105,188 | 43,248 | 43,276 | **−58.9%** |
| test / sonnet-5 | 105,478 | — | 41,352 | **−60.8%** |
| adversarial-review / gpt-5.6-sol | 16,243 | 16,804 | 16,871 | unchanged (codex lane, untouched) |

Exact-count attribution of the saving on a sonnet stretch: tool inventory 41,275 → **10,715**
(measured allow-list) and the catalogue ~39,000 → ~12,500.

**And the total bill did not fall.** Run A, with only these changes live, cost **$2.96 against
round one's $2.11**. §5 says why.

---

## 5. Why run A cost more, and what it was not

Run A made **132 API calls to round one's 68**. The digest of its first `implement` stretch
(`packages/claude-pty/src/conversation-digest.mjs`, built in Task 3, used here as a diagnostic)
shows what those calls were:

```
Bash  74   Write 13   Edit 9   Read 4      10 of them errors
```

The agent chose **vitest**; `npm install` produced `@vitest` but no `vitest` binary; it then spent
roughly thirty calls on `ls node_modules`, `find -iname "*vitest*"`, `npm config get registry`,
`rm -rf node_modules && npm install`, and reading `~/.npmrc`. Round one's Garrison chose jest and
it worked first time.

**That is a dependency-resolution accident, not a consequence of the cut.** Every tool the
allow-list removed was one the measured table says no duty has ever called; the agent's own
`Bash`/`Read`/`Write`/`Edit`/`Agent` set was untouched. Nothing in the removed set would have
diagnosed a broken npm install.

Run B — same task, same prompt, all changes live — made 90 calls and cost **$2.07**, with the
first `implement` stretch at 29 calls and $0.63 against run A's 65 and $1.34. Same code, same
prompt, **2.1x apart on the stretch that does the work**.

The honest reading: **on a task this small, which cut you made is unobservable underneath which
package manager mood you drew.**

---

## 6. Tasks 3 and 4 — the layers, and the number nobody had

**Layer 2** (`buildConversationDigest`) renders the conversation from `log.jsonl` on demand: user
messages whole, assistant prose whole, and every tool call as name, arguments, a one-line synopsis
of the result, its byte size, and a `seq:` pointer. **Never the result body.** Round one's whole
conversation digests to 22,917 characters while omitting 40,629 bytes of tool results (itself an
undercount — the ledger's own tee caps a result at 48,000 characters before the digest sees it).
It is not pushed into any brief; that would trade one prefix problem for another.

**Layer 3** is now an interface instead of a hint. The brief used to say "grep log.jsonl when you
need history", which a stretch with no shell in its profile cannot do and which nothing counted.
Two tools on the existing MCP gateway — `garrison_conversation_search` (filters by kind, duty,
stretch, text; returns pointers with a 240-character preview) and `garrison_conversation_fetch`
(one record by `seq`, or the digest) — read through gateway routes that append a **`layer3-access`
ledger event** carrying the query, the result size and the latency.

The MCP server also grew a `GARRISON_MCP_TOOLS` allow-list, so a duty carries the three tools it
might use instead of all eleven. Net cost of adding both layer-3 tools: **16-28 tokens** on the
boot prefix, because nine unused schemas left at the same time.

**The measurement that was previously unavailable:**

| run | layer-3 calls | digest fetches |
|---|---|---|
| R2 Garrison A | 0 | 0 |
| R2 Garrison B | **0** | **0** |

Zero. (Run B's ledger now carries three `layer3-access` records — a `digest` and two
`search` calls I made by hand afterwards to prove the routes and the instrumentation work
end to end. They are dated after the conversation closed and are not stretch activity.) On this task, with the tools attached and described in the prompt, no stretch reached into
history once. Two readings are available and the data does not choose between them: the briefs
were sufficient for a task this small, or the tools were not salient enough to be reached for. A
longer task is the test, and this round establishes the instrument for it rather than the answer.

---

## 7. Round-one corrections, all three

**The review gate.** `reviewBeforeDone` rewrote *every* `implement → done` into an adversarial
review on a second provider. It is now gated on what the stretch did, with thresholds from the
ledger (median implement stretch: 7,670 bytes across 33 conversations, so 12,000 is "more than
routine"): review if the handoff is not complete, if a sensitive path was touched, if the request
asked for one, if the change is ≥12,000 bytes or ≥5 files, or **if the change size cannot be read
at all** — unknown is not small. A repeat pass after a review already passed must clear 40,000
bytes. A skip is recorded as a `policy-rewrite`, never silent. The duty description now leads with
**explicit constraint checking**: the round-one reviews missed the only stated constraint either
side arguably violated (the dependency limit), because they read for correctness only.

Run B shows both halves honestly: the gate fired on the first pass with the reason
`review-before-done: 15063B across 11 file(s)`, and the second review still happened — **because
the implement stretch's own handoff named `adversarial-review` as its next duty.** The gate
governs the policy rewrite, not the model's own routing. Run A, ungated, ran three review passes
costing $0.79 of $2.96 (27%); run B ran two, at $0.74 of $2.07 (36%). The gate did not reduce
review spend on this task.

**The printed arithmetic.** Round one §6.4 printed
`(38·5 + 19373·25 + 47900·6.25 + 771504·0.5)/1e6 = 1.349267`, which computes to **1.169642**. The
total was right; the working applied the 5-minute cache-write rate to writes that were 1-hour
writes (2x base input, $10, not $6.25). It is no longer typed by hand: `--percall` prints the rows
with the TTL split and the per-class working, from the same rate table and the same aggregator the
total came from. Verified on all three round-two exports — each reproduces its own total to the
last digit (§9.4). Pinned by `tests/cost-instrumentation.test.ts`, including an assertion that the
wrong version does *not* reproduce it.

**The Sonnet rate — resolved, and the published page wins.** Two measurements the same day:

- A plain `claude -p --model sonnet` session (122 input / 43,491 output / 125,190 1h-cache-write /
  4,772,828 cache-read) reports `total_cost_usd = 1.8904796000000001`. At the published rates:
  `122·2 + 43491·10 + 125190·4 + 4772828·0.2 = 1.8904796`. **Identical to the last digit.**
- An Agent SDK stretch on the same model reports `modelUsage["claude-sonnet-5"].costUSD =
  3.34962775` for tokens this table prices at `1.3398511` — **exactly 2.500x** — while the *same
  envelope's* `claude-haiku-4-5` block (2,058 input, 17 output, `costUSD 0.002143`) matches this
  table to the cent (`2058·1 + 17·5 = 2143`).

So the same CLI prices Sonnet 5 correctly in its `-p` lane and at Opus rates in its Agent SDK lane.
**The rate used throughout this report is the published $2/$10**, re-read from the pricing page on
2026-08-29. Round one's "the headline is 1.6x or 3.35x depending on which source you believe" is
withdrawn: it is 1.6x, and the 3.35x came from a client-side cost field that is wrong for one model.

The account usage page could not arbitrate and was not used: these sessions bill against a
subscription and are not itemised per token in dollars.

---

## 8. Quality and scope — four outputs, nothing fixed

| | **Garrison A** | **Garrison B** | **`claude -p` sonnet** | **`claude -p` opus** |
|---|---|---|---|---|
| `npm install` | exit 0 | exit 0 | exit 0 | exit 0 |
| `npm test` | **exit 0 — 9/9** (vitest) | **exit 0 — 9/9** (jest) | **exit 0 — 7/7** (jest) | **exit 0 — 18/18** (`node --test`) |
| `tsc --noEmit`, `strict: true` | exit 0 | exit 0 | exit 0 | exit 0 |
| Server answers on :3000 | yes | yes | yes | yes |
| **18 behaviour checks** | **18/18** | **18/18** | **18/18** | **18/18** |
| files (excl. lockfile) | 11 | 10 | 11 | 10 |
| source lines | 271 | 266 | 283 | 440 |
| test lines | 101 | 91 | 90 | 223 |
| declared deps | 7 | 9 | 9 | **4** |
| installed packages | 123 | 283 | 282 | **68** |

**All four pass everything. Scope is confounded and the comparison must say so.** The Opus baseline
wrote 1.6x the source and 2.2x the test lines of either Garrison run, and 18 test cases to their 9
and 9 — while declaring **4 dependencies and installing 68 packages** against Garrison B's 9 and
283. Two of the four runs (Garrison B and the Sonnet baseline) took `jest`, `ts-jest`, `supertest`
and their transitive tail where the Opus baseline used the built-in `node --test` and nothing else.
The task said "no dependency beyond what the above requires"; a reasonable reader would call three
of these four outputs a violation of it and the Opus baseline compliant. **No side's cost figure
should be read as buying the same thing.**

One harness defect, found and fixed here rather than reported as an output failure: round one's
endpoint driver hard-required `createApp` from `dist/app.js`, and the Sonnet baseline exports a
default instead. The first pass reported it as a crash. The driver now discovers the app in
whatever shape a project exports it (`bench/round2/drive-endpoints.mjs`), and all four then scored
18/18. A harness that measures its own assumptions is not measuring the output.

---

## 9. Raw evidence

### 9.1 Identifiers

| run | id | output dir | transcript / ledger |
|---|---|---|---|
| R2 Garrison A | conversation `01M16AWMQ07935ER3XTH8064SG` | `~/dev/bench2-todo-gar-a` | `~/.garrison/conversations/01M16AWMQ07935ER3XTH8064SG/log.jsonl` |
| R2 Garrison B | conversation `01M16CXYWZ57RR478EJH6XFX8Z` | `~/dev/bench2-todo-gar-b` | `~/.garrison/conversations/01M16CXYWZ57RR478EJH6XFX8Z/log.jsonl` |
| R2 `claude -p` sonnet | session `78296ab7-29a9-4ec7-89d9-b9330790d29d` | `~/dev/bench2-todo-cc-sonnet` | `~/.claude/projects/-home-ggomes-dev-bench2-todo-cc-sonnet/78296ab7-29a9-4ec7-89d9-b9330790d29d.jsonl` |
| R2 `claude -p` opus | session `d0e2ac2c-8dcf-43f2-a559-d21689ca1b84` | `~/dev/bench2-todo-cc-opus` | `~/.claude/projects/-home-ggomes-dev-bench2-todo-cc-opus/d0e2ac2c-8dcf-43f2-a559-d21689ca1b84.jsonl` |

Prompt: `bench/cost-2026-08-28/task-prompt.txt`, md5 `8fbafd46f57b1d81b827f8f34582b399`, verified
unchanged before the round and used verbatim on all four sides.

Timings — A `2026-08-29T08:41:27Z → 08:57:51Z`; B `09:17:08Z → 09:26:20Z`; sonnet 525s wall;
opus 290s wall.

### 9.2 Per-stretch table — Garrison run A ($2.9576, 132 calls)

| # | duty | model | calls | input | output | cache write | cache read | cost |
|---|---|---|---|---|---|---|---|---|
| 1 | triage | claude-haiku-4-5 | 2 | 15 | 1,520 | 36,783 | 23,787 | $0.0582 |
| 2 | implement | claude-sonnet-5 | 65 | 1,181 | 20,309 | 130,601 | 4,039,483 | $1.3420 |
| 3 | adversarial-review | gpt-5.6-sol | 7 | 25,422 | 2,974 | 0 | 120,064 | $0.2092 |
| 4 | implement | claude-sonnet-5 | 16 | 615 | 3,733 | 83,575 | 685,460 | $0.3870 |
| 5 | adversarial-review | gpt-5.6-sol | 7 | 16,450 | 2,960 | 0 | 129,280 | $0.1767 |
| 6 | implement | claude-sonnet-5 | 26 | 635 | 5,846 | 27,678 | 1,244,567 | $0.3804 |
| 7 | adversarial-review | gpt-5.6-sol | 9 | 61,954 | 3,358 | 0 | 222,976 | $0.4042 |

### 9.3 Per-stretch table — Garrison run B ($2.0654, 90 calls)

| # | duty | model | calls | input | output | cache write | cache read | cost |
|---|---|---|---|---|---|---|---|---|
| 1 | triage | claude-haiku-4-5 | 11 | 77 | 4,539 | 71,877 | 266,878 | $0.1444 |
| 2 | implement | claude-sonnet-5 | 29 | 641 | 10,229 | 100,356 | 1,353,729 | $0.6274 |
| 3 | adversarial-review | gpt-5.6-sol | 12 | 37,477 | 4,403 | 0 | 232,448 | $0.3309 |
| 4 | implement | claude-sonnet-5 | 13 | 609 | 3,248 | 23,645 | 599,616 | $0.2153 |
| 5 | adversarial-review | gpt-5.6-sol | 14 | 46,171 | 5,151 | 0 | 305,664 | $0.4100 |
| 6 | test | claude-sonnet-5 | 11 | 22 | 3,103 | 89,215 | 403,756 | $0.3375 |

### 9.4 Worked arithmetic that reproduces its own total

Full per-call dumps: `bench/round2/percall-garrison-runA.txt`, `percall-garrison-runB.txt`,
`percall-cc-sonnet.txt`, `percall-cc-opus.txt` — all four reproduce their own totals
(`$2.9576335` / `$2.0653851` / `$1.8904796` / `$1.5113900`). Each is printed by `conversation-cost-export.mjs --percall` from the same
rate table and the same aggregator that produced the exported total.

Opus baseline, every class:

```
TOTAL                                              46      20492          0      53431     929100
  claude-opus-5
    input                 46 x $5      / 1e6 = 0.0002300
    output             20492 x $25     / 1e6 = 0.5123000
    cacheWrite1h       53431 x $10     / 1e6 = 0.5343100
    cacheRead         929100 x $0.5    / 1e6 = 0.4645500
    subtotal                                    $1.5113900
  TOTAL $1.5113900   (reported total_cost_usd: 1.51139)
```

Sonnet baseline — the arithmetic that resolves the disputed rate:

```
TOTAL                                             122      43491          0     125190    4772828
  claude-sonnet-5
    input                122 x $2      / 1e6 = 0.0002440
    output             43491 x $10     / 1e6 = 0.4349100
    cacheWrite1h      125190 x $4      / 1e6 = 0.5007600
    cacheRead        4772828 x $0.2    / 1e6 = 0.9545656
    subtotal                                    $1.8904796
  TOTAL $1.8904796   (reported total_cost_usd: 1.8904796000000001)
```

Garrison run A, three models:

```
  claude-haiku-4-5-20251001 (dispatch/routing inference)  subtotal $0.0093100
  claude-haiku-4-5
    input                 15 x $1      / 1e6 = 0.0000150
    output              1520 x $5      / 1e6 = 0.0076000
    cacheWrite5m       36783 x $1.25   / 1e6 = 0.0459787
    cacheRead          23787 x $0.1    / 1e6 = 0.0023787
    subtotal                                    $0.0559725
  claude-sonnet-5
    input               2431 x $2      / 1e6 = 0.0048620
    output             29888 x $10     / 1e6 = 0.2988800
    cacheWrite5m      241854 x $2.5    / 1e6 = 0.6046350
    cacheRead        5969510 x $0.2    / 1e6 = 1.1939020
    subtotal                                    $2.1022790
  gpt-5.6-sol
    input             103826 x $4      / 1e6 = 0.4153040
    output              9292 x $20     / 1e6 = 0.1858400
    cacheRead         472320 x $0.4    / 1e6 = 0.1889280
    subtotal                                    $0.7900720
  TOTAL $2.9576335   (reported total_cost_usd: 2.9576334500000003)
```

### 9.5 Export objects and the decomposition

Complete, verbatim: `bench/round2/export-garrison-runA.json`, `export-garrison-runB.json`,
`export-claude-code-sonnet.json`, `export-claude-code-opus.json`.
Prefix decomposition with every intermediate count:
`bench/prefix-2026-08-29/DECOMPOSITION.json` (per-section counts, per-tool counts, tool-subset
costs, differential probes, the tokenizer A/B, and the per-duty tool-usage table). Captured live
requests: `bench/prefix-2026-08-29/live-capture/`. Rate table: `data/model-rates.json`,
`rates_updated: 2026-08-29`, sources and the resolution note inline.

### 9.6 Instrument re-verification, before the round

| check | result |
|---|---|
| Throwaway conversation, every stretch priced | **PASS** — `01M168YRRNQ9QBJ2JRZ5VX6NK9`, 6/6 stretches, 18 rows, no duplicate callIds |
| Computed vs the provider's own figure, haiku | **PASS** — `$0.06297335` vs `$0.06297335`, **0.00%** |
| Computed vs the provider's own figure, sonnet | **59.8% — cause identified and resolved (§7); the published rate is correct** |
| Throwaway `claude -p`, transcript priced | **PASS** — opus baseline `$1.5113900` vs CLI `1.51139`, **0.000%** |
| Codex stretch reports usage | **PASS** — 5 real `gpt-5.6-sol` stretches across the two runs, `usageSource: codex-rollout`, $1.53 total |
| Both paths call the same pricing function | **PASS by inspection** — one `priceUsage` in `packages/claude-pty/src/model-rates.mjs`; ledger via `stretch.mjs → priceAggregate`, transcripts via `conversation-cost-export.mjs` |

---

## 10. Round-one comparison and per-change attribution

| | round one | round two A | round two B |
|---|---|---|---|
| Garrison cost | $2.1111 | $2.9576 | $2.0654 |
| API calls | 68 | 132 | 90 |
| stretches | 6 | 7 | 6 |
| boot prefix, implement | 78,907* | **43,248** | **43,276** |
| boot prefix, triage | 58,137* | **29,943** | **29,959** |
| review passes | 2 | 3 | 2 |
| best baseline that day | $1.3493 | $1.5114 | $1.5114 |
| ratio to baseline | 1.56x | 1.96x | **1.37x** |

\* Round one's own first-call figures. The same configuration re-measured on 2026-08-29 immediately
before the cut gave 105,188 / 77,571 — the assembled prompt had grown in between, which is itself
an argument for the index.

**Attribution, stated as far as the data supports and no further:**

- **Prefix cuts → −59 to −61% of the boot prefix, directly measured, twice.** Their effect on total
  cost is **not resolvable**: run A, which isolated them, cost 40% *more* than round one for a
  reason §5 shows is unrelated.
- **The review gate → one fewer policy-inserted review** in run B, and no measurable saving,
  because the model routed itself to review anyway. Review spend was 21% of round one, 27% of run A,
  36% of run B.
- **Layers 2 and 3 → zero calls, zero cost, zero effect** on this task. They are instrumented, so
  the next long task answers the question instead of raising it.
- **Fewer stretches: no.** 6 → 7 → 6. Nothing here reduced stretch count, and stretch count is what
  fixed per-stretch overhead multiplies against.

**The numbers did not move.** Garrison B at $2.07 against round one's $2.11 is inside a variance
band that the two baselines put at ±12% *at minimum* and that the two Garrison runs put at ±43%.
Anyone reading a 2% improvement into that is reading noise.

---

## 11. Caveats, stated plainly

1. **This round did not establish that the prefix work is worth anything in money.** It established
   that the prefix is 59-61% smaller and that on a task this size that is invisible in the total.
   Those are different claims and only the first is supported.
2. **n is 2 on the Garrison side and 1 per baseline model.** The two Garrison runs differ by 43%
   from each other. Every comparison in §10 is smaller than that.
3. **The task is small and triggered no compaction on any side** — 0 in all six runs. That is the
   regime where the mechanisms diverge most, and it is untested. The metric that will decide the
   long-task question is **stretches per unit of work**; this round's answer, 6-7 stretches for a
   200-line todo API, is the baseline to beat.
4. **Scope is confounded** (§8). The Opus baseline wrote more code and more tests with 4 dependencies
   and 68 packages; Garrison B wrote less with 9 and 283. Cost per unit of delivered work is not
   what this report measures.
5. **All figures are list API prices.** Every one of these sessions billed against a subscription.
   List rates are the right yardstick for comparison and are not what anyone paid.
6. **The `sdk-haiku` and `sol` targets run on API keys**, so a small part of Garrison's spend was
   genuinely billed while the rest was not. The comparison prices both at list rates regardless.
7. **Wall clock is not clean.** Runs were sequential, but `npm install` and test runs contend with
   whatever else the machine is doing, and run A's 974s includes several minutes of npm debugging.
8. **The `layer3-access` count of zero is a fact about this task, not about the tools.** It cannot
   distinguish "the briefs were sufficient" from "the tools were not reached for".
9. **Suite failures exist and were not fixed**, per the execution contract. `npm test`:
   **6,736 pass, 6 fail**. Five are the same suites round one reported failing at HEAD with its
   changes stashed — `clone`, `instance-isolation`, `kanban-discuss`, `kanban-panic-ui`,
   `model-docs-parity`. The sixth, `pendant-capture`, failed in one full run, passed 19/19 in
   isolation, and did not fail in a second full run: order-dependent, like round one's
   `workspace-git`. None of the six imports any module this work touched (checked by grep for
   `harness-profiles`, `conversation-digest`, `reviewGate`, `conversation-cost-export`,
   `model-rates`: zero hits in all six). One test DID break by intent and was updated:
   `stretch-launcher` pinned the exact string `"review-before-done"`, which now carries the gate's
   reason.
10. **This report was produced by the same system it measures, and its result is unfavourable to
    that system.** That is weak evidence of impartiality. Everything needed to disagree is in §9:
    both Garrison export objects, both baselines, the rate table with its date and its sources, the
    conversation and session ids, the transcript paths, the full decomposition with every
    intermediate count, and per-call arithmetic on three runs that reproduces its own totals.

---

## 12. What the evidence says to do next

Not a plan, an observation: **the three biggest levers this round found are all still unpulled.**

- **Stretch count.** Six to seven stretches for a 200-line API. Every one pays a fresh 43,000-token
  prefix and re-reads its own growing context. Halving stretches is worth more than halving the
  prefix, and the review gate barely touched it because the model routes itself.
- **The first `implement` stretch is the largest single line in every Garrison run** — 47% of round one, 45% of run A, 30% of run B. One long
  agentic stretch re-reading a growing context on every call is the cost of *any* coding agent, and
  the mechanism's own overhead is second to it.
- **The cache-read share is 89-97% on every run on both sides.** Cache reads are a tenth of input
  price and are the only reason 6.5M tokens cost $2.96 rather than $13. Anything that breaks that
  is a 10x regression, and `cacheReadShare` is the number to watch, not the dollar figure.
