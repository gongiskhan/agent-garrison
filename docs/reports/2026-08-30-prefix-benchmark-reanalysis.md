# Re-analysis of the existing benchmark data

No new runs. Everything below comes from `bench/prefix-campaign-2026-08-30/runs/*.measure.json`, the
Arm A conversation ledgers and the Arm B proxy captures. Numbers and quoted
evidence only.

## 1. Per-model split, all eight runs

| run | model | requests | input | output | cache read | cache write | cost |
|---|---|---|---|---|---|---|---|
| A-1 | claude-haiku-4-5 | 1 | 22,825 | 2,439 | 85,491 | 23,319 | $0.0794 |
| A-1 | claude-sonnet-5 | 48 | 71,278 | 26,560 | 1,376,284 | 168,081 | $1.1973 |
| A-1 | gpt-5.6-sol | 9 | 25,922 | 5,265 | 200,448 | 0 | $0.2892 |
| A-2 | claude-haiku-4-5 | 2 | 32,268 | 6,076 | 63,200 | 39,782 | $0.1366 |
| A-2 | claude-sonnet-5 | 43 | 39,359 | 19,476 | 1,269,886 | 109,937 | $0.8584 |
| A-2 | gpt-5.6-sol | 24 | 61,343 | 10,293 | 521,216 | 0 | $0.6597 |
| A-3 | claude-haiku-4-5 | 1 | 19,139 | 3,896 | 61,426 | 27,281 | $0.0900 |
| A-3 | claude-sonnet-5 | 91 | 72,945 | 42,490 | 2,900,920 | 179,992 | $1.6758 |
| A-3 | gpt-5.6-sol | 36 | 117,057 | 13,818 | 801,792 | 0 | $1.0653 |
| A-4 | claude-haiku-4-5 | 1 | 31,686 | 4,081 | 52,635 | 26,475 | $0.1010 |
| A-4 | claude-sonnet-5 | 73 | 118,452 | 41,132 | 2,367,496 | 189,059 | $1.6693 |
| A-4 | gpt-5.6-sol | 27 | 79,954 | 11,140 | 670,976 | 0 | $0.8110 |
| B-1 | claude-sonnet-5 | 65 | 2,141 | 42,451 | 9,697,349 | 205,828 | $3.1916 |
| B-2 | claude-sonnet-5 | 57 | 113 | 29,195 | 8,601,018 | 77,256 | $2.3214 |
| B-3 | claude-sonnet-5 | 50 | 99 | 26,107 | 7,408,118 | 59,957 | $1.9827 |
| B-4 | claude-sonnet-5 | 47 | 2,443 | 44,287 | 6,891,436 | 103,915 | $2.2417 |

Arm B rows carry the run total against its single model; the run used no other.

### Arm A: sonnet versus haiku, all four runs combined

| model group | requests | share of requests | cost | share of cost |
|---|---|---|---|---|
| claude-sonnet-5 | 255 | 71.6% | $5.4008 | 62.6% |
| claude-haiku-4-5 | 5 | 1.4% | $0.4069 | 4.7% |
| gpt-5.6-sol (codex) | 96 | 27.0% | $2.8252 | 32.7% |
| **total** | **356** | | **$8.6328** | |

Stated plainly: of Arm A's 356 API requests across four runs, 255 (71.6%) went to claude-sonnet-5 and 5 (1.4%) to claude-haiku-4-5. Of $8.6328, $5.4008 (62.6%) was sonnet and $0.4069 (4.7%) was haiku. The remaining 96 requests and $2.8252 (32.7%) went to gpt-5.6-sol on the codex runtime.

## 2. Every Arm A stretch

| run | # | duty | model | requests | input | output | cache read | cache write | first-call prefix | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| A-1 | 1 | triage | claude-haiku-4-5 | 5 | 21,072 | 2,423 | 85,491 | 23,319 | 11,118 | $0.0775 |
| A-1 | 2 | plan | claude-sonnet-5 | 6 | 9,268 | 7,541 | 215,262 | 32,032 | 15,082 | $0.2357 |
| A-1 | 3 | implement | claude-sonnet-5 | 26 | 20,177 | 14,008 | 798,311 | 69,154 | 15,434 | $0.5505 |
| A-1 | 4 | adversarial-review | gpt-5.6-sol | 9 | 25,922 | 5,265 | 200,448 | 0 | 17,214 | $0.2892 |
| A-1 | 5 | implement | claude-sonnet-5 | 12 | 19,748 | 3,650 | 285,780 | 42,640 | 15,746 | $0.2585 |
| A-1 | 6 | test | claude-sonnet-5 | 4 | 8,336 | 1,234 | 76,931 | 24,255 | 15,752 | $0.1238 |
| A-2 | 1 | triage | claude-haiku-4-5 | 7 | 17,233 | 1,920 | 28,859 | 16,622 | 11,117 | $0.0572 |
| A-2 | 2 | implement | claude-sonnet-5 | 29 | 8,056 | 16,133 | 881,512 | 53,198 | 15,132 | $0.5189 |
| A-2 | 3 | adversarial-review | gpt-5.6-sol | 15 | 34,509 | 6,395 | 342,272 | 0 | 16,960 | $0.4028 |
| A-2 | 4 | implement | claude-sonnet-5 | 6 | 12,155 | 1,638 | 139,327 | 28,625 | 15,636 | $0.1588 |
| A-2 | 5 | adversarial-review | gpt-5.6-sol | 9 | 26,834 | 3,898 | 178,944 | 0 | 17,081 | $0.2569 |
| A-2 | 6 | test | claude-sonnet-5 | 9 | 9,353 | 3,484 | 249,047 | 40,128 | 15,715 | $0.2224 |
| A-3 | 1 | triage | claude-haiku-4-5 | 7 | 5,509 | 1,798 | 28,851 | 16,356 | 11,109 | $0.0445 |
| A-3 | 2 | plan | claude-sonnet-5 | 4 | 11,518 | 8,729 | 99,307 | 32,619 | 15,114 | $0.2304 |
| A-3 | 3 | implement | claude-sonnet-5 | 33 | 15,009 | 14,514 | 1,014,164 | 52,470 | 15,524 | $0.5278 |
| A-3 | 4 | adversarial-review | gpt-5.6-sol | 12 | 29,947 | 3,996 | 285,696 | 0 | 17,239 | $0.3140 |
| A-3 | 5 | implement | claude-sonnet-5 | 28 | 12,190 | 8,636 | 1,005,769 | 43,882 | 15,738 | $0.4403 |
| A-3 | 6 | adversarial-review | gpt-5.6-sol | 13 | 57,270 | 6,064 | 277,248 | 0 | 17,204 | $0.4613 |
| A-3 | 7 | implement | claude-sonnet-5 | 26 | 20,208 | 10,488 | 781,680 | 51,021 | 15,871 | $0.4479 |
| A-3 | 8 | adversarial-review | gpt-5.6-sol | 11 | 29,840 | 3,758 | 238,848 | 0 | 17,272 | $0.2901 |
| A-4 | 1 | triage | claude-haiku-4-5 | 6 | 18,106 | 2,163 | 28,869 | 16,754 | 11,127 | $0.0594 |
| A-4 | 2 | plan | claude-sonnet-5 | 6 | 63,150 | 12,419 | 221,894 | 43,264 | 15,049 | $0.4217 |
| A-4 | 3 | implement | claude-sonnet-5 | 41 | 14,357 | 18,012 | 1,478,842 | 59,250 | 15,511 | $0.6714 |
| A-4 | 4 | adversarial-review | gpt-5.6-sol | 16 | 54,042 | 6,254 | 398,336 | 0 | 17,211 | $0.5006 |
| A-4 | 5 | implement | claude-sonnet-5 | 16 | 18,685 | 6,198 | 406,620 | 48,350 | 15,805 | $0.3203 |
| A-4 | 6 | adversarial-review | gpt-5.6-sol | 11 | 25,912 | 4,886 | 272,640 | 0 | 17,175 | $0.3104 |
| A-4 | 7 | test | claude-sonnet-5 | 10 | 8,387 | 4,384 | 260,140 | 38,195 | 15,823 | $0.2269 |

Cost per stretch across all 27 stretches: median $0.2901, min $0.0445, max $0.6714, mean $0.3118, sd $0.1684, **CV 54.0%**.

Per duty:

| duty | stretches | median | min | max | CV |
|---|---|---|---|---|---|
| implement | 9 | $0.4479 | $0.1588 | $0.6714 | 37.0% |
| adversarial-review | 8 | $0.3122 | $0.2569 | $0.5006 | 25.5% |
| triage | 4 | $0.0583 | $0.0445 | $0.0775 | 22.8% |
| plan | 3 | $0.2357 | $0.2304 | $0.4217 | 36.8% |
| test | 3 | $0.2224 | $0.1238 | $0.2269 | 30.5% |

For comparison, the per-RUN cost CV reported in REPORT.md: Arm A 26.3%, Arm B 8.1%.

## 3. The extra cycles in runs 3 and 4

Compared against A-2, the 6-stretch run. This is a multiset difference, not a
positional one: a single inserted stretch would otherwise make every stretch
after it look different.

```
A-2 (6): triage -> implement -> adversarial-review -> implement -> adversarial-review -> test
A-3 (8): triage -> plan -> implement -> adversarial-review -> implement -> adversarial-review -> implement -> adversarial-review
A-4 (7): triage -> plan -> implement -> adversarial-review -> implement -> adversarial-review -> test
```

### A-3

Duties A-2 did not have this many of: `plan` +1, `implement` +1, `adversarial-review` +1. Duties A-2 had that this run did not: `test` -1.

Those extra stretches account for 41 API requests and $0.9684.

#### stretch 2 — `plan` (claude-sonnet-5, 4 requests, $0.2304)

Immediately preceded by the **handoff** of `triage` (seq 119), status `complete`, next `plan`.

`nextSteps.why`, quoted: “Design phase needed to finalize API endpoints, database schema, and test coverage strategy before implementation.”

Handoff summary, quoted:

```
Triaged a todo app build request for an Express+SQLite project with strict conventions. Project has established patterns for persistence (store.js), ID generation (identity.js), audit logging (audit.js), and config (settings.js). Zero external dependency constraint applies. Request scope is clear: 7 features across CRUD + filtering + visual overdue indicator, plus passing tests. No blockers identified. Ready for plan duty to design API/DB schema and test strategy.
```

#### stretch 7 — `implement` (claude-sonnet-5, 26 requests, $0.4479)

Immediately preceded by the **handoff** of `adversarial-review` (seq 726), status `complete`, next `implement`.

`nextSteps.why`, quoted: “Correct the browser-local overdue date comparison, then rerun the existing suite and add boundary coverage.”

Handoff summary, quoted:

```
Adversarial review found one remaining correctness bug in overdue styling.

- **Finding:** `public/app.js` derives today with `new Date().toISOString().slice(0, 10)`, which is a UTC date, while `<input type="date">` values are local calendar dates. Around local midnight, overdue state is wrong; in `Europe/Lisbon` at 2026-08-30 00:30, a due date of 2026-08-29 is not marked overdue. Build `YYYY-MM-DD` from local `getFullYear()`, `getMonth()`, and `getDate()` values and cover the boundary.
- The prior findings are fixed: both test files isolate and clean their databases, and impossible calendar dates are rejected.
- All named structural constraints pass inspection: shared store handle/transactions, centralized IDs and settings, transactional audit records, route-module registration, same-server UI, and no new dependencies.
- Verified `npm install` succeeds with zero vulnerabilities; `npm te
```

#### stretch 8 — `adversarial-review` (gpt-5.6-sol, 11 requests, $0.2901)

Immediately preceded by the **handoff** of `implement` (seq 904), status `complete`, next `adversarial-review`.

`nextSteps.why`, quoted: “This is the second review cycle for this specific finding; a final check confirms the fix is correct and no new issues were introduced before marking the card done.”

Handoff summary, quoted:

```
Fixed the overdue-date timezone bug flagged by adversarial review, and added regression coverage.

- Extracted the date logic from `public/app.js` into a new `public/dateUtils.js` module exporting `todayISO(date)` and `isOverdue(todo, date)`, both accepting an injectable `Date` (defaulting to `new Date()`) so they're unit-testable outside a browser.
- `todayISO` now builds `YYYY-MM-DD` from `getFullYear()`/`getMonth()`/`getDate()` (local calendar date) instead of `new Date().toISOString().slice(0, 10)` (UTC date), fixing the local-midnight boundary bug.
- `app.js` now imports `isOverdue` from `dateUtils.js` (loaded as an ES module via `<script type="module">`, already the case in `index.html`).
- Added `test/dateUtils.test.js` (4 tests) covering the exact boundary from the review finding: with `TZ=Europe/Lisbon`, a local time of 2026-08-30 00:30 is 2026-08-29 23:30 UTC — the test asserts
```

### A-4

Duties A-2 did not have this many of: `plan` +1. Duties A-2 had that this run did not: none.

Those extra stretches account for 6 API requests and $0.4217.

#### stretch 2 — `plan` (claude-sonnet-5, 6 requests, $0.4217)

Immediately preceded by the **handoff** of `triage` (seq 148), status `complete`, next `plan`.

`nextSteps.why`, quoted: “Scope is clear but requires architectural design decisions (schema, endpoints, audit strategy, test plan) before implementation to avoid rework and convention violations”

Handoff summary, quoted:

```
Triaged todo app build request. Project has strict coding conventions (AGENTS.md) for persistence, ID generation, audit trails, and config. Seed project with Express, SQLite, vitest already set up. Routing to plan duty to design database schema, API endpoints, and test strategy before implementation.
```

## 4. Cold-start tax

| run | cache state | cache write | cache read | write ÷ read | first request: input | first: cache write | first: cache read | first: prefix | first: cost |
|---|---|---|---|---|---|---|---|---|---|
| A-1 | cold | 191,400 | 1,662,223 | 0.115 | 10 | 11,108 | 0 | 11,118 | $0.0206 |
| A-2 | cold | 149,719 | 1,854,302 | 0.081 | 10 | 11,107 | 0 | 11,117 | $0.0206 |
| A-3 | cold | 207,273 | 3,764,138 | 0.055 | 10 | 11,099 | 0 | 11,109 | $0.0206 |
| A-4 | cold | 215,534 | 3,091,107 | 0.070 | 10 | 11,117 | 0 | 11,127 | $0.0206 |
| B-1 | warm | 205,828 | 9,697,349 | 0.021 | 2 | 15,138 | 92,754 | 107,894 | $0.0821 |
| B-2 | warm | 77,256 | 8,601,018 | 0.009 | 2 | 15,138 | 92,754 | 107,894 | $0.0804 |
| B-3 | warm | 59,957 | 7,408,118 | 0.008 | 2 | 15,138 | 104,804 | 119,944 | $0.0829 |
| B-4 | warm | 103,915 | 6,891,436 | 0.015 | 2 | 15,138 | 92,754 | 107,894 | $0.0807 |

## 5. Decomposition tax

| run | arm | stretches | API requests | assistant turns | tool calls | tool searches | tool calls ÷ stretch | requests ÷ stretch | turns ÷ request |
|---|---|---|---|---|---|---|---|---|---|
| A-1 | A | 6 | 62 | 119 | 282 | n/a | 47.0 | 10.3 | 1.92 |
| A-2 | A | 6 | 75 | 159 | 199 | n/a | 33.2 | 12.5 | 2.12 |
| A-3 | A | 8 | 134 | 221 | 378 | n/a | 47.3 | 16.8 | 1.65 |
| A-4 | A | 7 | 106 | 193 | 344 | n/a | 49.1 | 15.1 | 1.82 |
| B-1 | B | 1 | 65 | 65 | 72 | 0 | 72.0 | 65.0 | 1.00 |
| B-2 | B | 1 | 57 | 57 | 62 | 0 | 62.0 | 57.0 | 1.00 |
| B-3 | B | 1 | 50 | 50 | 56 | 0 | 56.0 | 50.0 | 1.00 |
| B-4 | B | 1 | 47 | 47 | 53 | 0 | 53.0 | 47.0 | 1.00 |

Arm B is one session, so its stretch count is 1 by construction and the per-stretch columns restate the run totals.

`n/a` under tool searches for Arm A: the conversation ledger does not carry the `server_tool_use` block a tool search produces.

Raw: `bench/prefix-campaign-2026-08-30/reanalysis.json`.
