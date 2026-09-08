# Default Codex duties: verification, 2026-09-06

The default composition now uses the existing ChatGPT subscription through the
Codex runtime for selected planning, review, test, validation, and reporting
duties. Interactive dialogue, dispatch, implementation, and voice retain their
existing assignments.

| Duty | Level route | Normal conversation ladder default |
| --- | --- | --- |
| plan | level 3: Astra, max effort | Astra, deep rung |
| review | level 3: Astra, high effort | Astra, deep rung |
| test | level 2: Sol, medium effort | Sol, standard rung |
| validate | level 1: Sol, medium effort | Sol, standard rung |
| report | level 2: Sol, low effort | Sol, standard rung |

Targets are exactly `gpt-6-astra` and `gpt-5.6-sol`, observed in the authenticated
Codex model catalog. Both use `chatgpt-subscription`, runtime `codex`, and
`authMode: subscription`. The previous Sol target incorrectly advertised an
Anthropic API-key provider despite invoking Codex.

The test/review routing table is aligned with these defaults. Its cross-family
review preference remains intact: a review following GPT implementation can
still select Claude. The routing table, duty ladder, and level matrix are
separate policy layers, so checking only the target entry is insufficient.

## Automated policy checks

The detached dev-madrid checkout `/tmp/garrison-codex-policy-X7LwoB`, at
`7f69ca99`, passed 39 tests across `default-codex-duties`, `duty-ladder-schema`,
and `runtime-codex-stretch`.

The new policy tests resolve actual level routes and normal conversation
ladder/routing-table routes. They also check cross-family review selection and
preservation of interactive defaults. Existing seed assertions were updated to
assert the new authored ladder rather than the retired synthetic one.

## Authenticated execution and qualitative checks

Tests used synthetic prompts and temporary working directories. They requested
no project edits, messages to other people, or external application mutations.

| Probe | Observed execution | Assessment |
| --- | --- | --- |
| Idempotent streaming and crash-recovery plan | `gpt-6-astra`, high effort, Codex exit 0 | Identified durable request identity and payload hashing, ownership/fencing, replay sequencing, and uncertain external effects. Did not claim to have executed tests. |
| Release validation from incomplete evidence | `gpt-5.6-sol`, medium effort, Codex exit 0 | Correctly returned FAIL for an observed duplicate on reconnect, untested mobile behavior, and skipped Stop validation. Did not invent passing evidence. |
| Gateway target-pinned smoke test | Codex, `gpt-5.6-sol`, high effort applied | Returned the requested exact marker. This proves pinned execution, not the unpinned default route. |

Planning passed the qualitative criteria of identifying crash windows, avoiding
false exactly-once claims, proposing bounded work, and stating validation that
would discriminate correct behavior. Validation passed the criteria of matching
the supplied evidence and refusing a release claim with known or untested gaps.
These are targeted checks, not a statistical benchmark of model quality.

Private raw probe evidence is on dev-madrid in
`/tmp/garrison-codex-quality-3rdq0i8p`. A first gateway probe that supplied the
duty at the wrong request layer actually ran Claude; it is excluded from the
Codex success claims. Runtime/model attribution was checked rather than inferred
from the requested model.

## Shared policy publication

The manifest was published through the state client's compare-and-swap API,
revision 40 to 41, preserving unrelated settings. A rollback copy of revision 40
and the previous routing table and resolved model is retained privately under
`~/.garrison/backups/codex-duty-defaults-2026-09-06T09-05-37-460Z` on dev-madrid.

The state service initially rejected `.garrison/routing-table.json` despite the
composition exporter allowing that authored file. The proposed service allowlist
and parity regression include that exact path; backups and similarly named
secret files remain excluded. The proposed change passed 84 checks locally:
30 allowlist parity, 19 composition transfer, and 35 real state API checks
against an ephemeral database. The routing-file API test verifies peer readback,
unchanged manifest revision/content, and preservation of an unrelated prompt.
The initial sandbox denied loopback listening; the approved isolated retry
passed. The patch and state-service rollout are held pending explicit approval.
The exact three-file patch is saved privately at
`/private/tmp/garrison-state-allowlist-review-kav0t0oq/state-routing-table-allowlist.patch`
on the Mac (SHA-256 `673831eaeccbf90ce520b883c9fa6a09b2d01b70c2648ec3d214b69847e930e5`);
its source changes were removed from the checkout before node builds.
The authority currently has no routing-table file; its composition pull updates
only listed files and does not remove the Git-deployed table. The gateway reads
that table from the composition directory for each default route. Node rollout
and live default-routing verification can therefore proceed through normal Git
delivery while shared routing-file publication remains pending.

## Air capability verification

The Air's login shell now resolves the official standalone `codex` installation,
version 0.153.4, and its existing ChatGPT subscription login remains intact.
The refreshed model catalog includes both selected models. An ephemeral,
read-only Astra run at low effort returned the exact marker `ASTRA_AIR_OK`
without tool use; evidence is `/tmp/codex-astra-air-9cAd2e` on the Air.

The latest official signed desktop bundle, ChatGPT 26.901.51231 build 8109, is
installed on disk, with the prior 26.825.32147 bundle preserved in
`~/Applications/CodexAppBackups/`. The existing running app process was preserved
and therefore still needs relaunch. The local `mac-air` SSH alias resolves and
authenticates, but Codex Connections UI activation remains a separate user step:
automatic approval review explicitly blocked Codex UI inspection through the
computer-use connector, and that restriction was not bypassed.

## Native Codex hook activation

Installing `hooks.json` alone did not activate the new lifecycle handlers.
Codex 0.153.4 enables the stable `hooks` feature by default, and `exec` supports
these hooks, but it skips a new or changed non-managed hook until its exact
definition is trusted. The supported workflow is the interactive CLI `/hooks`
review browser. See the [official hook guide](https://learn.chatgpt.com/docs/hooks).

The six owned handlers (SessionStart, UserPromptSubmit, PostToolUse, PreCompact,
Stop, SessionEnd) were individually reviewed and trusted through that browser
on all three user homes. No broad trust flag, managed-policy substitution, or
handwritten trust hash was used. Each event invokes the same reviewed
`agent-continuity.py --config <home>/.config/garrison/agent-continuity.json hook
--source Codex` command; the event arrives on standard input. The executable and
script locations are:

| Node | Interpreter | Script |
| --- | --- | --- |
| Mac | `/opt/homebrew/opt/python@3.14/bin/python3.14` | `/Users/ggomes/dev/garrison/scripts/agent-continuity.py` |
| dev-madrid | `/usr/bin/python3` | `/home/ggomes/.local/share/garrison-agent-continuity/scripts/agent-continuity.py` |
| Air | `/Library/Developer/CommandLineTools/usr/bin/python3` | `/Users/ggomes/.local/share/garrison-agent-continuity/scripts/agent-continuity.py` |

Private pre-change backups and `review-result.json` preserve every exact
CLI-generated event hash under `~/.garrison/backups/codex-hook-trust-<stamp>`:
`20260906T093702Z` on dev-madrid, `20260906T094205Z` on the Mac, and
`20260906T094206Z` on the Air. Comparison found only six hook-trust changes on
the Mac and dev-madrid. The Air additionally used the normal first-open trust
prompt for the exact requested Garrison directory (which had no local config,
hooks or rules); Codex also recorded its own model welcome-message seen flag.
Existing unrelated hooks and MCP settings were preserved.

Fresh, authenticated, tool-free Astra `exec` runs then returned the requested
markers and automatically created these SessionEnd observations. The hook was
not invoked manually for these checks.

| Node | Thread | Automatic session key | Reply |
| --- | --- | --- | --- |
| dev-madrid | `01a07617-0ff5-7011-992d-5c39459e54a0` | `14c95a2f51427b61a11c` | `HOOK_LIFECYCLE_OK` |
| Mac | `01a0761d-66bf-7a93-8d71-15cce53809bf` | `50ee87d3637fc8b663ca` | `HOOK_MAC_OK` |
| Air | `01a0761e-2474-7ed2-8f81-8220d9a40353` | `55d8a6eaad90f263eb6b` | `HOOK_AIR_OK` |

All observations identify source Codex, model `gpt-6-astra`, the correct node,
and the Garrison project. Local records are under
`~/.local/state/garrison/agent-continuity/sessions/<key>.json`; shared checkpoints
use `Projects/Garrison/Memory/Sessions/Checkpoints/Agent Session <key>`.
All three fresh checkpoints were subsequently read back through actual Basic
Memory MCP calls from the shared vault, without manually invoking the worker.
Orchestrated runtimes are covered separately by the gateway lifecycle seam and
their configured Basic Memory transport; their isolated Codex homes were not
given copied trust hashes.

## Native Claude checks

The Mac's non-interactive shell initially selected Homebrew Claude 2.1.19. It
returned a synthetic marker but produced no common lifecycle record. The
already-installed native `/Users/ggomes/.local/bin/claude` 2.1.259 returned
`HOOK_CLAUDE_NATIVE_MAC_OK` and automatically recorded session
`976ce252-04e1-4429-83df-174a01b5af73` as checkpoint `60172fe7b83bc8f66bb6`.
Its result attributes execution to `claude-haiku-4-5-20251001`; the native hook
does not supply a model and correctly records `unknown`.

The Mac login profile now gives `~/.local/bin` precedence. The exact prior
profile is saved as
`~/.zprofile.before-native-agent-path-20260906T095450Z`. A fresh login shell
resolves native Claude 2.1.259 while retaining Codex 0.153.4. No legacy binary
was removed.

The Air's native Claude 2.1.214 reports `loggedIn: false` / `authMethod: none`.
Its attempted marker turn made no model API call and returned the normal
`Please run /login` error. That attempt still automatically produced SessionEnd
checkpoint `376c182069cdf91385ad` for session
`fcc47383-9e9b-4c12-9e9e-1fd797a4f511`, proving lifecycle activation but not
authenticated Claude execution. Existing keychain metadata was inspected only;
no credential values were read, copied, or changed. An ordinary Claude `/login`
on the Air is required to complete the authenticated native-Claude check.

## Production default-duty checks

After the dev-madrid node deployed `c32416fb`, QA conversations were created
through `POST /api/threads` and admitted through
`POST /api/conversation/<minted-id>/message`. Requests selected only duty, level,
and project `garrison`; they did not pin a target, provider, model, or effort.
The gateway calls these requested run settings a pin in its ledger, but the
actual model came from the deployed default policy.

| QA thread | First actual stretch | Result |
| --- | --- | --- |
| `chat-mtpnf4p3-8d2ohy` | plan 3, Astra, max, 2 API calls | Ran `pwd` and reported `/home/ggomes/dev/garrison`. Proposed atomic admission/message/outbox, key/hash conflict handling, lease recovery, concurrent and crash tests, and an explicit provider deduplication limitation. |
| `chat-mtpnf4pr-ilp86c` | review 3, Astra, high, 1 API call | Identified both check-then-act and execution-before-mark crash schedules, gave discriminating tests, and explained why local claiming cannot prove remote exactly-once execution. |
| `chat-mtpnf4qf-kv3u5b` | validate 1, Sol, medium, 1 API call | Correctly distinguished sequential deduplication evidence from missing concurrency and cancellation proof; returned overall FAIL and concrete follow-up checks. |

Every first `stretch-ended` reported runtime `codex`, provider
`chatgpt-subscription`, the expected actual model, `effortApplied: true`, and no
runtime error. Review exercised the authored routing-table candidate
`astra-sub`; planning and validation exercised their level/ladder targets.
First-stretch durations were 99, 168, and 199 seconds respectively, including
Codex's serialized account lease wait. These timings do not isolate inference
latency. Raw QA evidence remains on dev-madrid under
`/tmp/garrison-live-duty-quality-20260906` and the named conversation ledgers.

These probes also exposed a conversation defect: the implementation evidence
policy rewrote informational `done` handoffs to `test` when no executable
evidence existed. Planning/review each spawned an unnecessary Sol test stretch;
validation spawned four further stretches before settling on `needs-input`.
The requested model answers were useful, but those entire conversations are
not counted as clean completion acceptance. The completion-policy correction
and fresh end-to-end regression are tracked with the Conversations audit.

Live UI inspection also found an attribution projection bug. The canonical
adapter reused the requested startup attribution on a settled stretch, losing
the actual `effortApplied` boolean, and invented `account: null` for unknown
accounts. Its account tooltip always said Claude. Commit `67cc2c0b` overlays
actual settlement fields, carries an explicitly reported routing account, omits
unknown accounts, and describes the observed runtime's login. All 65 focused
rail and conversation-serving tests passed with loopback HTTP enabled; the
tests cover separate SSE batches, sanitizer preservation, both applied and
refused effort, standalone history windows, and Codex machine-login wording.

The live UI Stop check used only QA thread `chat-mtpo2isg-p1p7qa` ("QA live Stop
UI 2026-09-06"), routed to actual Agent SDK / `claude-sonnet-5`. Clicking Stop
settled one stretch at `2026-09-06T10:27:44.479Z` with outcome and stop reason
`cancelled`, next `needs-input`, three API calls, and zero handoff repairs. The
current-stretch marker was removed, the saved reply was empty, and the requested
`STOP_QA_SHOULD_NOT_FINISH` marker never appeared. No later stretch or model call
was observed. This proves cancellation before assistant completion, not process
interruption: the native guard rejected `sleep 45`; the model then issued
`bash -c 'sleep 45'`, which completed before settlement. The UI showed the
stopped state and removed Stop.

That resume check subsequently passed on `dce4dc63`: a new user message on the
same thread requested only `STOP_QA_RESUME_OK`, expressly forbidding tools,
delegation, cards, and replay of prior work. It produced exactly that marker
in ordinal 2, actual Agent SDK / `claude-sonnet-5`, one API call in 9.1 seconds,
and next `done`, with no tools or repair. The cancelled ordinal 1 and its empty
reply remained intact. This also exercised follow-up on a thread whose first
stretch ran before the gateway deployment.

## Air convergence and deployment follow-up

The Air advanced through Git from `bb1f7125` to `c32416fb` on its existing node
branch. Its six original local files remain intact in stash
`43b69e1682beb48bc00e4dc548ddc2964bf81881` and private backup
`~/.garrison/backups/air-continuity-rollout-20260906T095740Z`.
The pre-merge tag is
`garrison/premerge/garrison/goncalos-macbook-air-1/2026-09-06T095740Z`.
Decision card `decision-air-agent-continuity-20260906` records the full manifest
comparison and why shared WhatsApp port 8087 preserves the Air's intended
station while replacing its old port 8080 assignment. Old generated bundles
and lockfile were preserved rather than reapplied.

The Air's production build passed under its app's Node 22.22.2 runtime.
Composition startup then revealed an existing installed-but-logged-out Cursor
CLI; plain `cursor-agent status` independently confirmed the missing login.
Commit `5f66ecca` makes an optional unavailable Cursor a visible degraded probe,
while `GARRISON_REQUIRE_CURSOR=1` remains fatal and actual delegation still
fails on missing authentication. All 42 Cursor runtime tests passed, including
real subprocess probe exit-code checks and an authentication-failure execution
regression. No Cursor credentials were read or changed.

The private Git bundle for `67cc2c0b` was hash-verified on the Air before a
detached checkout ran 165 tests across the six affected runtime, gateway,
completion-policy, and attribution suites; all passed. The corrected probe
also ran against the Air's real logged-out Cursor CLI and returned `ok` plus
the visible login requirement, without a model call. Final deployment waits
were resolved by the authority fix in `dce4dc63`. On that exact candidate, the
Air also passed 18 Python continuity tests, seven Node projection tests, eight
gateway authority tests, and 47 completion-policy tests. The Node tests used
the existing Homebrew Python 3.14 for their TOML helper; the first attempt with
the system Python lacked `tomllib`, rather than exposing a product failure.

Operational correction: `launchctl submit` creates a repeating KeepAlive job,
and disabling its label does not stop an already loaded job from restarting.
The original task supervisor was booted out after four attempts. Use an
explicit private launchd plist with `RunAtLoad: true` and `KeepAlive: false`,
bootstrap it into `gui/<uid>`, verify `runs = 1` and the final exit code, and
boot out that exact task label after completion. The normal persistent Garrison
app service retains its own KeepAlive setting. Pending final rollout results
were superseded by the successful final run below.

The final Air deployment fast-forwarded the canonical repository and the clean
continuity-tooling clone to `dce4dc630216e6ba4fa1c2ffa848d86744d6214d` through a
hash-verified private Git bundle. The current authoritative manifest was
preserved byte-for-byte. Its backup and logs are
`~/.garrison/backups/air-final-rollout-20260906T103401Z`; the pre-merge tag is
`garrison/premerge/garrison/goncalos-macbook-air-1/20260906T103401Z`.
The final launchd task recorded `runs = 1`, `last exit code = 0`, and was then
booted out. The default composition started at `2026-09-06T10:35:35.659Z`; the
subsequent mesh health read reported all 17 views healthy and an idle node.
The deployed routing table remained byte-identical to Git after authority pull.

While public disclosure approval remains pending, this Air repository has a
temporary local Git push URL pointing to a private non-repository path, so
background mesh requests cannot indirectly publish these commits. Fetch URLs
and other projects were preserved. Exact prior Git configuration and prior
push-URL metadata are in
`~/.garrison/backups/public-push-pause-20260906T103059Z`. Restore only the owned
push-URL setting once that approval is granted; do not replace unrelated Git
configuration with an old full backup.

## Air default Sol execution

Two normal Air-owned conversations used only duty/level/project settings.
Their source node is `goncalos-macbook-air-1`.

| Thread | Actual execution | Result |
| --- | --- | --- |
| `chat-mtpog01q-its533` — QA Air default Sol test and continuity 2026-09-06 | test 2, `gpt-5.6-sol`, medium, `effortApplied: true` | One stretch, seven API calls, no error, next `done`. Ran the exact isolated fixture; exit 0. Correctly reported 32 matching requests yielding one admission/stub call and changed-content rejection, explicitly limiting the claim to the in-memory fixture. |
| `chat-mtpog01t-vvkjvh` — QA Air deployment report 2026-09-06 | report 2, `gpt-5.6-sol`, low, `effortApplied: true` | Correct report of commit, exit 0, node, 17/17 view health, and remaining login/relaunch/Connections/publication steps. It cited the actual deployment artifact and did not conflate the installed bundle with the running app. A following test stretch reread the artifact before next `done`; the report-duty completion-policy edge is recorded in the audit. |

Both final records attribute execution to Codex and `chatgpt-subscription`.
The test exercised routing-table candidate `codex-sub`; the report used `sol`.
Fixture, actual log, deployment snapshot, and case identifiers are under the
final Air backup's `qa/` directory. These remain QA evidence, not a statistical
claim about general model quality.

## Final default-duty execution on dev-madrid

The same bounded cases were rerun on the deployed `dce4dc63` node through the
normal Conversations HTTP surface. Requests set only duty, level, and project;
the model, target, and effort came from the default composition and routing
table. All three completed with one stretch, `next: done`, no error, and no
synthesized handoff, repair, or follow-up test. The runtime recorded Codex,
`chatgpt-subscription`, and `effortApplied: true` throughout.

| Conversation | Actual selected execution | Acceptance evidence |
| --- | --- | --- |
| `chat-mtpojeon-fu05qk` — QA final Codex default Astra planning 2026-09-06 | plan 3, Astra, max; 2 API calls, 92 seconds | Ran `pwd` exactly once and reported `/home/ggomes/dev/garrison`. Proposed atomic unique admission, content hash, transactional outbox, crash recovery, and concrete tests. Explicitly limited exactly-once guarantees to admission and acknowledged duplicate external calls without provider cooperation. |
| `chat-mtpojeot-i8nba8` — QA final Codex default Astra review 2026-09-06 | review 3, Astra, high; table candidate `astra-sub` at index 0; 1 API call, 118 seconds | Identified both concurrent check-then-act and crash-after-execution schedules, supplied one minimal regression for each, and recommended atomic pending admission plus an honest provider-dependent recovery policy. |
| `chat-mtpojeoy-4e9yjk` — QA final Codex default Sol validation 2026-09-06 | validate 1, Sol, medium; 1 API call, 134 seconds | Correctly marked both unsupported acceptance criteria and overall release evidence FAIL. Distinguished a visible Stop control from actual cancellation and proposed a concurrent-admission/cancellation runtime test. |

Manual bounded rubric for the saved model replies: correctness, evidence and uncertainty, actionable tests,
and instruction compliance, each scored 0–2. Each reply scored 8/8. This is
acceptance of these three synthetic cases, not a broader benchmark or a latency
claim; concurrent requests shared the machine's Codex execution queue. The
prompts, receipts, canonical ledgers, and saved replies remain on dev-madrid in
`/tmp/garrison-live-duty-quality-20260906` and the named conversation directories.

Live UI verification then found a separate delivery gap: the review displayed
only its short handoff summary. The normal conversation HTTP response included
`stretch-ended.payload.replyRef` but neither the referenced reply body nor an
assistant-text event. The full review was preserved on the owner node at
`payloads/stretch-0001-reply.md`. The model and routing checks passed, but this
added a user-facing answer-delivery gate, resolved by the following fix and
deployed browser checks.

Commit `16d4dd8c` repairs the common conversation stream: it resolves the saved
owner-local reply through a confined, descriptor-based read capped at 1 MiB,
rejects traversal and file/directory symlinks, and emits missing final prose at
the settled record's chronological position. It retains stable identities on
reconnect and avoids adding a second answer when the final streamed envelope
already contains the complete prose. An earlier progress line, split answer,
or later progress line does not suppress the saved full answer. The final gate
passed 80 tests (47 conversation-serving and 33 attribution), including actual
HTTP/SSE history and live batches plus the renderer's final-text selection.
The deployed browser verification below closes the missing-answer delivery gate.

After the `16d4dd8c` dev-madrid deployment, the actual common SSE endpoint
returned exactly one stable saved-reply event for the existing Astra review
and Sol validation QA threads. Each text block was byte-equal to its complete
owner-node saved reply (1,420 and 1,294 characters including the protocol tail
that the renderer hides). The Stop/resume thread already carried its complete
523-character native tee reply, so the route correctly emitted no duplicate
fallback event.

The root agent then verified the live HTTPS UI for all three existing threads:
the complete Astra review appeared exactly once at a 390-pixel viewport with
document width also 390 pixels; Sol's full FAIL analysis and minimal test
proposal were visible; and the native Stop/resume marker appeared after the
preserved cancelled stretch and one subsequent completed stretch. This closes
the user-facing saved-answer delivery and post-Stop response gates on the
updated dev-madrid node.

On resuming the task later on September 6, the Air did not answer SSH. The root
agent made two 10-second checks, then this agent made one delayed check after
the wake request; port 22 timed out again. No update was attempted against an
unreachable host. Its last verified deployed revision remains `dce4dc63`; the
final combined fixes in `16d4dd8c` require a further private Git rollout once it
returns. The prepared bundle is
`/private/tmp/garrison-final-conversations-16d4dd8c.bundle`, SHA-256
`726fa771527a15d2637dc3af12ecf1dbd7b28a614a88e90271b7bd306e04a181`.

## Actual cross-runtime memory round trip

The synthetic note written by the actual Astra planning duty was subsequently
read, updated, and read back by an actual Claude SDK dialogue duty on the final
release. The continuity audit records that SDK tool sequence and independent
common-vault verification. A fresh Astra planning duty then read the same note
in conversation `chat-mtpzl1c3-2u0mga` and quoted both the original marker and
the Claude verification line. It completed one stretch with `next: done`,
`gpt-6-astra`, Codex, subscription attribution, max effort, and
`effortApplied: true`.

The actual Codex rollout, thread `01a07768-5333-7b23-a171-a0a3e33796ac`, contains
`tools.mcp__basic_memory__read_note` for project `main` and exactly
`main/projects/garrison/memory/qa/agent-continuity-qa-20260906-1012`.
Its matching tool result contains `GARRISON_CROSS_RUNTIME_20260906_1012`,
`Claude SDK verification`, and `Claude updated`. The tool-only proof is
`/tmp/garrison-live-duty-quality-20260906/astra-readback-tool-proof.json` on
dev-madrid. This is actual model-level shared-memory use, separately verified
from the earlier raw MCP transport and automatic lifecycle checks. Only the
synthetic QA note was read or updated for this round trip.

## Final report-duty regression

Conversation `chat-mtpzixy0-i9of43` — "QA final default Sol deployment report
2026-09-06" — read only the real metadata artifact
`/tmp/garrison-final-16d4dd8c-deployment-evidence.json` after the final dev-madrid
release. Only duty `report`, level 2, and project `garrison` were requested.
The actual default was `gpt-5.6-sol`, Codex, `chatgpt-subscription`, low effort,
with `effortApplied: true`. It completed one stretch in 51 seconds with three
API calls, `completion: answer`, `next: done`, and no synthesis, repair, or
unnecessary test stretch. This closes the report-duty edge observed on the
earlier Air release.

The report correctly stated the revision and successful exit status, gateway
readiness, 43/43 fitting checks, 17/17 healthy views, tailnet HTTP 200, and
206 passing tests with typecheck. It preserved the artifact's explicit scope:
semantic memory parity was a separate gate, and the artifact did not verify
Air, desktop Connections, or future conversations. It cited the exact source,
stayed within 180 words, and scored 8/8 on the same bounded reply rubric.

A real SSE listener was attached before admission. It recorded an init frame
and two delta frames; exactly one final reply event contained the complete
saved answer, byte-for-byte. The actual live frames, request, receipt, and
case metadata are `report-final-*` artifacts under
`/tmp/garrison-live-duty-quality-20260906` on dev-madrid. The root UI audit owns
the final browser check and archival of these exact QA threads.
