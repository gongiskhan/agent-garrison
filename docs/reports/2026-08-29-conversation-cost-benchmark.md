# Cost instrumentation, and what the conversation mechanism actually costs

**Date:** 2026-08-29
**Instrument:** per-API-call provider usage captured at the runtime adapters, priced through one shared rate table
**Benchmark:** one Garrison conversation vs one plain `claude -p` session, same task, same prompt, one run per side

---

## 1. The verdict

**For this task, the conversation mechanism cost more — about 1.6x more — and both sides produced a working, fully passing result.** Garrison spent **$2.11** against Claude Code's **$1.35** at published list rates, took **449s** against **246s**, and made **68 API calls** against **19**.

Confidence in the *direction* is high and in the *magnitude* is low. The direction is safe because the gap does not come from measurement slack: both sides are priced by the same function, the baseline's figure reproduces the provider SDK's own cost to the last digit (0.000% divergence), and the mechanism's extra spend is structurally explainable — six stretches, each booting a fresh session that re-reads a large orchestrator prompt, plus two adversarial-review passes on a second provider that the baseline has no equivalent of. The magnitude is soft because this is n=1 per side, because run-to-run variance on agent tasks is routinely larger than a 1.6x gap, and because one rate in the table is genuinely disputed (below), which alone moves the ratio between 1.6x and 3.3x.

**The one number most likely to overturn this:** Garrison's cost is dominated by cache reads — 4,578,893 of them, 93.3% of everything it read. Cache reads are a tenth of input price, which is the only reason 4.6M tokens cost $2.11 rather than $23. The mechanism is already benefiting enormously from caching. If a future change broke that, the same conversation would cost roughly ten times more; the measurement to watch is `cacheReadShare`, not the dollar figure.

---

## 2. Headline numbers, side by side

| | **Garrison conversation** | **Claude Code (`claude -p`)** |
|---|---|---|
| **Total cost (list rates)** | **$2.1111** | **$1.3493** |
| Provider SDK's own figure | $4.0789 (see §7 — disputed rate) | $1.349267 (matches ours exactly) |
| API calls | 68 | 19 |
| Input tokens | 59,560 | 38 |
| Output tokens | 23,519 | 19,373 |
| Cache write tokens | 268,339 | 47,900 |
| Cache read tokens | 4,578,893 | 771,504 |
| **Cache read share** | **93.3%** | **94.1%** |
| Wall clock | 449s | 246s |
| Compactions | 0 | 0 |
| Units of work | 6 stretches, 3 models, 2 providers | 1 session, 1 model |

One run per side. Budget did not allow a second, so **treat every figure here as directional**.

---

## 3. Where the money went — the per-stretch table

This is the number that explains the result rather than restating it.

| # | duty | model | calls | in | out | cache W | cache R | cost |
|---|---|---|---|---|---|---|---|---|
| 1 | triage | claude-haiku-4-5 | 1 | 10 | 1,192 | 40,616 | 17,511 | $0.0607 |
| 2 | implement | claude-sonnet-5 | 35 | 3,368 | 11,522 | 106,027 | 2,979,839 | **$0.9851** |
| 3 | adversarial-review | gpt-5.6-sol | 5 | 12,686 | 1,756 | 0 | 86,784 | $0.1206 |
| 4 | implement | claude-sonnet-5 | 13 | 2,937 | 3,408 | 63,240 | 1,019,947 | $0.4045 |
| 5 | adversarial-review | gpt-5.6-sol | 10 | 37,769 | 4,094 | 0 | 213,504 | $0.3184 |
| 6 | test | claude-sonnet-5 | 4 | 2,790 | 1,547 | 58,456 | 261,308 | $0.2219 |
| | **TOTAL** | | **68** | **59,560** | **23,519** | **268,339** | **4,578,893** | **$2.1111** |

By model: `claude-sonnet-5` 52 calls / $1.6045 · `gpt-5.6-sol` 15 calls / $0.4389 · `claude-haiku-4-5` 5 calls / $0.0677.

**Read this table and the cost stops being mysterious.** Three things drive it:

1. **The first `implement` stretch is 47% of the bill on its own** ($0.985 of $2.11), and 3.0M of its 4.6M cache reads. A long agentic stretch re-reads its whole growing context on every one of 35 calls; that is the dominant cost of any coding agent, Garrison's or not.
2. **The mechanism paid to re-do work.** `implement → adversarial-review → implement → adversarial-review → test` means the second implement pass ($0.40) and the second review ($0.32) exist because the first review found something. That is $0.72, a third of the total, spent on a quality loop the baseline simply does not run. Whether that is waste or value is a quality question, and §5 says both outputs passed everything — so on *this* task the loop bought nothing measurable.
3. **Cross-provider review is not free.** The two `gpt-5.6-sol` stretches cost $0.44, 21% of the total, and are pure overhead relative to a single-session baseline.

The baseline, by contrast, is one uninterrupted session: 19 calls, one model, no handoffs, no re-briefing. Its 771,504 cache reads against Garrison's 4,578,893 is the whole story in one ratio — **Garrison re-read context 5.9x as much**, because six independent sessions each rebuild their own context from an L1 summary rather than continuing one.

---

## 4. What the instrument is, and how it was verified

Every number above comes from provider-reported usage blocks, captured at the cheapest available point on each side. No proxy is involved.

**Garrison side.** A new `onUsage` hook on the Agent SDK adapter forwards each `assistant` envelope's raw `usage` and each `result` envelope's `usage` + `modelUsage` + `total_cost_usd`, verbatim, as they arrive. The stretch launcher appends each as a `usage` event in layer three (`log.jsonl`) *live*, so a stretch that times out still leaves behind what it burned. On exit the rows are aggregated onto `stretch-ended` with model, provider, effort, api_calls, the four token classes with the cache TTL split, `cost_usd`, and the SDK's own `sdkCostUsd` as a separate cross-check field.

**Claude Code side.** The transcript parser reads `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` plus any nested `subagents/**` transcripts, and prices the same way.

**Part 5 gate — every check, with its evidence:**

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Non-zero usage captured for every stretch | **PASS** | Verification conversation `costverify-1787959690`: 3/3 stretches priced, 9 usage rows, **0 duplicate callIds** |
| 2 | Codex stretch reports usage | **PASS** | Two ways. A live `codex exec` returned `usageSource: "codex-rollout"` with a real split row, priced at $0.0331. And the benchmark itself ran two real `gpt-5.6-sol` stretches through the gateway (§3, rows 3 and 5) — 15 calls, $0.4389, not zero and not unmeasured |
| 3 | Computed cost agrees with the SDK's | **PASS with one named exception** | Haiku stretch: `$0.0606901` vs SDK `$0.0606901` — **0.00%**. Baseline: `$1.349267` vs SDK `$1.349267` — **0.000%**. Sonnet-5 stretches: 59.8%, cause identified exactly (§7) |
| 4 | Transcript parser produces non-zero numbers | **PASS** | `claude -p` probe session priced at `$0.014320000000000001` against the SDK's `$0.014320000000000001` |
| 5 | Both paths call the same pricing function | **PASS, by inspection** | One implementation, `priceUsage` at `packages/claude-pty/src/model-rates.mjs:234`. Garrison reaches it via `stretch.mjs:1200 → priceAggregate → priceUsage`; the exporter via `scripts/conversation-cost-export.mjs:301 → priceUsage`. The only other `/1_000_000` in the tree is the legacy un-split band used for conversations recorded before this existed |

Four defects were found by these checks and fixed, which is the reason to run them:

- **Every usage row was emitted twice**, doubling every cost. The agent-sdk lane streamed rows live *and* the launcher replayed the settled envelope. Caught by counting duplicate `callId`s on the first live run.
- **The `assistant` envelope's `output_tokens` is a partial snapshot.** Three assistant rows summed to 20 output tokens against a settled 624, while their input (2,788), cache write (61,310) and cache read (189,847) matched the settled totals *exactly*. Summing per-call rows would have under-reported output — the expensive class — by ~30x. The settled envelope is now the total; the per-call rows remain the record.
- **An operator rate override busted no cache.** The metrics cache keyed on log mtime alone, so a finished conversation would serve pre-correction numbers forever. Now keyed on a schema version plus the rate table's full stamp.
- **Pricing inside the metrics layer ignored the caller's env**, making an override invisible.

A fifth, smaller one: per-model API-call counts were being taken from turn envelopes, reporting "3 calls" for a 52-call model. Dollars were unaffected; the counts now come from the per-call rows.

**Committed evidence:** `tests/cost-instrumentation.test.ts` — 20 tests pinning the dedup rule, the partial-snapshot rule, the cache-TTL split, codex's cached-as-subset convention, the rollout delta rule, parent/subagent separation, and the cache bust. `npm test` overall: 6,691 passing. Six files fail, and **five of them fail identically at HEAD with my changes stashed** (`clone`, `instance-isolation`, `kanban-discuss`, `kanban-panic-ui`, `model-docs-parity`); the sixth (`workspace-git`) passes in isolation and fails only in a full run, i.e. order-dependent. None are caused by this work, and none were fixed by it.

---

## 5. Quality and scope — both outputs, nothing fixed

Both directories were exercised exactly as produced.

| | **Garrison** | **Claude Code** |
|---|---|---|
| `npm install` | exit 0 | exit 0 |
| `npm test` | **exit 0 — 8/8 green** (jest) | **exit 0 — 21/21 green** (`node --test`) |
| `tsc --noEmit`, `strict: true` | exit 0, no errors | exit 0, no errors |
| Server on port 3000 | answers `200 []` | answers `200 []` |
| Endpoint behaviour (18 checks) | **18/18 PASS** | **18/18 PASS** |

The 18 checks cover every stated requirement plus the boundary the task implies: create returns a uuid with `completed:false` and an ISO `createdAt`; empty / 201-char / missing / non-string titles all return 400 with `{"error": ...}`; a 200-char title is accepted; unknown ids return 404 with the same shape on GET, PATCH and DELETE; `?completed=true|false` filters correctly; and a deleted id 404s afterwards. Full transcripts: `bench/cost-2026-08-28/endpoints-{garrison,claude-code}.txt`.

**Neither side cut a corner. On correctness this is a tie.**

### Scope — and it confounds the comparison

| | **Garrison** | **Claude Code** |
|---|---|---|
| Files (excl. lockfile, `node_modules`, `dist`) | 10 | 10 |
| Source lines (`.ts`) | **239** | **475** |
| of which test lines | 82 | 251 |
| Test cases | 8 | 21 |
| Declared dependencies | **12** (2 runtime + 10 dev) | **4** (1 runtime + 3 dev) |
| Installed packages | **294** | **68** |
| Beyond the stated requirements | `uuid` package, `ts-node`, a `dev` script, `.npmrc` | a separate `validation.ts`, a `typecheck` script |

**This is the most important caveat in the report, and it cuts both ways.** Claude Code wrote **twice the source and three times the test lines** — 21 test cases to Garrison's 8, all green on both sides. If more tests are worth more, the baseline delivered more per dollar than the headline suggests and the real gap is wider than 1.6x. Garrison, meanwhile, pulled in **4.3x the installed packages** by choosing jest + ts-jest + supertest + ts-node where the baseline used the built-in `node --test` and no extra runtime dependency — arguably a violation of *"no dependency beyond what the above requires"*, and the one place either side drifted from the brief.

Both used `express`; Garrison additionally took `uuid` where the baseline used the built-in `crypto.randomUUID`. One small robustness difference: the baseline reads `process.env.PORT ?? 3000`; Garrison hardcodes `3000`. The task asked for 3000, so both comply.

---

## 6. Raw evidence

### 6.1 Export objects, in full

**Garrison, run 1** — `bench/cost-2026-08-28/export-garrison-run1.json`:

```json
{
  "run_label": "run1",
  "side": "garrison",
  "task_id": "todo-api-v1",
  "source": "sdk-stream",
  "wall_clock_seconds": 449,
  "api_calls": 68,
  "input_tokens": 59560,
  "output_tokens": 23519,
  "cache_write_tokens": 268339,
  "cache_read_tokens": 4578893,
  "total_cost_usd": 2.1110926,
  "compactions": 0,
  "stretches": [
    {
      "duty": "triage",
      "model": "claude-haiku-4-5-20251001",
      "effort": "medium",
      "api_calls": 1,
      "input_tokens": 10,
      "output_tokens": 1192,
      "cache_write_tokens": 40616,
      "cache_read_tokens": 17511,
      "cost_usd": 0.0606901
    },
    {
      "duty": "implement",
      "model": "claude-sonnet-5",
      "effort": "medium",
      "api_calls": 35,
      "input_tokens": 3368,
      "output_tokens": 11522,
      "cache_write_tokens": 106027,
      "cache_read_tokens": 2979839,
      "cost_usd": 0.9850943000000001
    },
    {
      "duty": "adversarial-review",
      "model": "gpt-5.6-sol",
      "effort": "medium",
      "api_calls": 5,
      "input_tokens": 12686,
      "output_tokens": 1756,
      "cache_write_tokens": 0,
      "cache_read_tokens": 86784,
      "cost_usd": 0.12057760000000001
    },
    {
      "duty": "implement",
      "model": "claude-sonnet-5",
      "effort": "medium",
      "api_calls": 13,
      "input_tokens": 2937,
      "output_tokens": 3408,
      "cache_write_tokens": 63240,
      "cache_read_tokens": 1019947,
      "cost_usd": 0.4044534
    },
    {
      "duty": "adversarial-review",
      "model": "gpt-5.6-sol",
      "effort": "medium",
      "api_calls": 10,
      "input_tokens": 37769,
      "output_tokens": 4094,
      "cache_write_tokens": 0,
      "cache_read_tokens": 213504,
      "cost_usd": 0.3183576
    },
    {
      "duty": "test",
      "model": "claude-sonnet-5",
      "effort": "low",
      "api_calls": 4,
      "input_tokens": 2790,
      "output_tokens": 1547,
      "cache_write_tokens": 58456,
      "cache_read_tokens": 261308,
      "cost_usd": 0.2219196
    }
  ],
  "_meta": {
    "conversation_id": "01M15BNA3C6DRSZ644FW2730VJ",
    "unpriced_stretches": 0,
    "sdk_reported_cost_usd": 4.07888685,
    "cache_read_share": 0.933174,
    "rates_updated": "2026-08-28",
    "by_model": {
      "claude-haiku-4-5-20251001": {
        "api_calls": 4,
        "usd": 0.00918
      },
      "claude-haiku-4-5": {
        "api_calls": 1,
        "usd": 0.0584911
      },
      "claude-sonnet-5": {
        "api_calls": 52,
        "usd": 1.6044863
      },
      "gpt-5.6-sol": {
        "api_calls": 15,
        "usd": 0.43893519999999997
      }
    }
  }
}
```

**Claude Code, run 1** — `bench/cost-2026-08-28/export-claude-code-run1.json`:

```json
{
  "run_label": "run1",
  "side": "claude-code",
  "task_id": "todo-api-v1",
  "source": "jsonl-transcript",
  "wall_clock_seconds": 246,
  "api_calls": 19,
  "input_tokens": 38,
  "output_tokens": 19373,
  "cache_write_tokens": 47900,
  "cache_read_tokens": 771504,
  "total_cost_usd": 1.349267,
  "compactions": 0,
  "stretches": [
    {
      "duty": "",
      "model": "claude-opus-5",
      "effort": "",
      "api_calls": 19,
      "input_tokens": 38,
      "output_tokens": 19373,
      "cache_write_tokens": 47900,
      "cache_read_tokens": 771504,
      "cost_usd": 1.349267
    }
  ],
  "_meta": {
    "session_id": "1d52eec6-9cdf-427b-b12f-40e14ea75684",
    "transcript_files": [
      "/home/ggomes/.claude/projects/-home-ggomes-dev-bench-todo-cc/1d52eec6-9cdf-427b-b12f-40e14ea75684.jsonl"
    ],
    "transcript_count": 1,
    "assistant_records": 43,
    "deduped_api_calls": 19,
    "unpriced_models": [],
    "rates_updated": "2026-08-28",
    "by_model": {
      "claude-opus-5": {
        "api_calls": 19,
        "usd": 1.349267,
        "unpriced": false
      }
    }
  }
}
```

### 6.2 The rate table

`data/model-rates.json`, `rates_updated: 2026-08-28`, read from
`https://platform.claude.com/docs/en/about-claude/pricing` and
`https://developers.openai.com/api/docs/pricing` on that date. USD per million tokens.

| model | input | output | cache write 5m | cache write 1h | cache read |
|---|---|---|---|---|---|
| claude-opus-5 | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| claude-sonnet-5 | 2.00 | 10.00 | 2.50 | 4.00 | 0.20 |
| claude-haiku-4-5 | 1.00 | 5.00 | 1.25 | 2.00 | 0.10 |
| gpt-5.6-sol | 4.00 | 20.00 | 4.00 | 4.00 | 0.40 |

Anthropic's published cache multipliers are 1.25x input for a 5-minute write, 2x for a 1-hour write, and 0.1x for a read. OpenAI charges no cache-write premium, so its write columns equal input. These are **list API prices**, which is exactly what makes the two sides comparable even though both actually ran on a subscription.

### 6.3 Identifiers

- Garrison conversation: `01M15BNA3C6DRSZ644FW2730VJ`; ledger `~/.garrison/conversations/01M15BNA3C6DRSZ644FW2730VJ/log.jsonl`; output `~/dev/bench-todo-gar`; 2026-08-28T23:36:06Z → 23:43:37Z
- Claude Code session: `1d52eec6-9cdf-427b-b12f-40e14ea75684`; transcript `~/.claude/projects/-home-ggomes-dev-bench-todo-cc/1d52eec6-9cdf-427b-b12f-40e14ea75684.jsonl`; output `~/dev/bench-todo-cc`; 247s
- Verification conversation: `costverify-1787959690`
- Prompt used verbatim on both sides: `bench/cost-2026-08-28/task-prompt.txt` (md5 `8fbafd46f57b1d81b827f8f34582b399`)

### 6.4 Per-call usage rows

Full dumps: `bench/cost-2026-08-28/percall-garrison.txt` (72 rows) and `percall-claude-code.txt` (19 rows).

Baseline, every API call, deduped by message id with a per-field max — these sum to the reported totals and can be recomputed by hand:

```
message id                          recs      in     out    cachW    cachR
msg_011CeW29x2Y6AurVK71qf9Ww           2       2     677    18600    10180
msg_011CeW2Ak3VBJd9W6NqfwVCX           3       2     998     1521    28780
msg_011CeW2BZtaYmdYAib8MJrjV           2       2    1139     1018    30301
msg_011CeW2CVGJ2HGt9Bgz6NNoV           2       2    1175     1170    31319
msg_011CeW2DFjEqVaBCZVR6dGyx           2       2    1348     1206    32489
msg_011CeW2EE34tKCwuCse9McK1           2       2    1351     1379    33695
msg_011CeW2FLhgYEzWKazVkVdu9           2       2    3351     2164    35074
msg_011CeW2HQYvMsRA7X18deCJG           2       2     740     3382    37238
msg_011CeW2J5M3Ej2W95YrSoyHB           2       2     342     1267    40620
msg_011CeW2JdeVNCkudKCjyWQDr           1       2      84      382    41887
msg_011CeW2Jrf5mXeVanFhHjScc           3       2    1333      472    42269
msg_011CeW2Kus6GXMbXkRts5jcp           1       2     587     1364    42741
msg_011CeW2LjDf1zAiXoxAt1SVY           3       2     484     5801    44105
msg_011CeW2MHFF26F784cvbXMPA           3       2    1215      724    49906
msg_011CeW2NhpdHToySQLccj7uZ           3       2    1471     1890    50630
msg_011CeW2QHm5f3LBmeoaNBmsT           3       2    1277     2052    52520
msg_011CeW2RW2JK314Mmwtt5NaP           3       2     309     1818    54572
msg_011CeW2S1N9ZWxXfiBEDnjCR           2       2     663      398    56390
msg_011CeW2T3nXngpfQ4wpPwujC           2       2     829     1292    56788
TOTAL                                 43      38   19373    47900   771504
```

Hand-check: `(38·5 + 19373·25 + 47900·6.25 + 771504·0.5) / 1e6 = 1.349267` — the exact figure the SDK reported.

Garrison, first ten rows of the triage and implement stretches:

```
source        model                        in      out    cachW    cachR   sdk$
assistant     claude-haiku-4-5-20251001       10       4    40616    17511
result        claude-haiku-4-5-20251001       10    1192    40616    17511  0.06069
assistant     claude-sonnet-5               2566       5    76341        0
assistant     claude-sonnet-5                  2       1     2745    76341
assistant     claude-sonnet-5                220      20      119    79086
assistant     claude-sonnet-5                  2      17      691    79205
assistant     claude-sonnet-5                  2      17      367    79896
assistant     claude-sonnet-5                  2       3      206    80263
assistant     claude-sonnet-5                  2      17      206    80469
assistant     claude-sonnet-5                  2       2      600    80675
```

Hand-check on the triage stretch: `(10·1 + 1192·5 + 40616·1.25 + 17511·0.1) / 1e6 = 0.0606901`, matching the SDK's `0.0606901` exactly. Note the assistant row's `output_tokens: 4` against the settled `1192` — this is the partial-snapshot behaviour described in §4, and the reason the envelope is the total.

---

## 7. Caveats, stated plainly

**These are reasons to distrust the numbers above. They are not softened.**

1. **This task is small and triggered no compaction on either side — zero, both.** Compaction is precisely where the two mechanisms diverge most: Garrison's whole premise is that a fresh stretch booting from an L1 summary beats one session compacting itself. This benchmark never reached that regime, so **it says nothing about long tasks**, which is the case the mechanism exists for. The result is directional and specifically not a verdict on the design.

2. **n=1 per side. Run-to-run variance on agent tasks is frequently larger than the 1.6x effect being measured.** Budget did not allow a second run. Do not treat 1.6x as a measurement; treat it as "more, on this one run".

3. **One rate in the table is disputed, and it moves the answer between 1.6x and 3.3x.** The Agent SDK's own `total_cost_usd` prices `claude-sonnet-5` at $5/$25/$6.25/$0.50 — Opus-tier — not the published $2/$10. Solved exactly from a live envelope: `(2568·I + 967·5I + 105281·0.1I + 61604·1.25I)/1e6 = 0.4746805` gives `I = 5.00`. The same envelope's haiku block solves to `I = 1.00`, matching the table to the cent, so the arithmetic is not in question — only that one rate. **This table follows the published pricing page.** Priced at the SDK's rate instead, Garrison's run is **$4.5178 and the ratio is 3.35x**. Garrison is more expensive under either rate; the baseline is unaffected because it ran on Opus 5, where both agree.

4. **Both sides are priced at list API rates and neither reflects subscription billing.** Both actually ran on a Max subscription and were not billed per token at all.

5. **The two sides did not use the same models, and that is not a flaw that could be removed.** Garrison's mechanism *is* model-tiering: haiku for triage, sonnet-5 for implement and test, gpt-5.6-sol for adversarial review. The baseline ran entirely on `claude-opus-5`. If the baseline had run on sonnet it would have been cheaper still, which would widen the gap.

6. **The baseline's model was forced by an account limit, not chosen.** The CLI's default model returned `429 — "You've hit your monthly spend limit"`, so the baseline was pinned to `--model opus`. `haiku`, `sonnet` and `opus` all worked when named explicitly. Opus is Claude Code's normal coding tier, but it is the most expensive available and this was not a free choice.

7. **What the instrument still cannot see.** Named rather than absorbed:
   - **Compaction cost is structurally invisible on the Claude Code side.** A compaction emits no usage record at all, so a transcript-derived total omits one full-context input call per compaction. Zero compactions here, so zero impact — but this is exactly the regime caveat 1 describes, and any long-task rerun must account for it.
   - **Ancillary calls** (title generation, quota probes) appear in the SDK's `modelUsage` but never as assistant records. Measured elsewhere at ~0.01% of a session.
   - **The Agent SDK's summarize-and-rebuild path** (`_summarize`) makes a real, billed API call with no instrumentation on it. It is off by default and did not run here.
   - **The routing-inference call** that precedes each turn passes no hooks and is not recorded against the conversation.
   - **Codex subagent threads** would be invisible to stdout alone — a measured 2.74x undercount on a real delegation. The rollout reader handles this and was verified against production data (parent 4,102,975 + three children 7,152,566 = 11,255,541 exactly), but the two `gpt-5.6-sol` stretches here spawned no subagents, so that path carried no weight in this benchmark.
   - **`cache_write_input_tokens` semantics for codex are unverified.** It was 0 in every observation, so it contributed nothing; whether it is a separate class or already inside `input_tokens` is untested.

8. **A methodological error I made and corrected, disclosed because it nearly produced a fabricated result.** The first pass of the endpoint verification was answered by an unrelated Next.js app that happened to hold port 3000, and it reported the baseline's API as returning 404 for everything. It was caught by adding a responder check. The endpoint results in §5 come from binding each app in-process, which both proves port 3000 and guarantees the responder is the project under test.

9. **This report was produced by the same system it measures.** The result is unfavourable to that system, which is weak evidence of impartiality and no substitute for someone re-running it. Everything needed to disagree is in §6: both export objects, the rate table with its date, the conversation and session ids, the transcript paths, and the per-call rows for both sides with worked arithmetic.

---

## 8. Reproducing it

```bash
# price a Garrison conversation
node scripts/conversation-cost-export.mjs --conversation <conversation-id>

# price a plain Claude Code session
node scripts/conversation-cost-export.mjs --claude-session <session-id> --cwd <dir>

# the instrument's own tests
npx vitest run tests/cost-instrumentation.test.ts

# re-drive either produced API against all 18 behaviour checks
node bench/cost-2026-08-28/drive-endpoints.mjs ~/dev/bench-todo-cc
```

The running cost of any conversation is also live in the UI: a chip in the conversation header showing the total, opening a breakdown by duty, by model, cache-read share, the provider SDK's own figure beside ours, and the rate table's date. A stretch that cannot be priced shows **no** cost rather than `$0.00`, and a conversation with unpriced stretches shows the total it can account for plus how many it cannot.
