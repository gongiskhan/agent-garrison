# Recent native sessions and mesh running indicators

Date: 2026-09-07. Owner node: MacBook Pro. This records code and local verification; mesh rollout and real client acceptance are verified separately by the convergence task.

## Behavior

Conversations expands the Shell sessions section by default and shows sessions active in the last five days, including ended Claude sessions. The former twenty-ended-row cap is removed. Native sessions already represented by a conversation or owned shell retain one list row; separate sessions in the same project no longer disappear just because a Garrison shell has that cwd.

Codex discovery includes the user's native home alongside the runner's redirected home. It scans old creation directories by current file activity, so resuming an older task brings it into the five-day window. Bounded journal metadata reads recognize explicit task start/completion and abort events. A quiet ongoing tool/model call keeps its spinner, while completion clears it immediately. An interrupted journal without completion ages to unknown after six hours rather than claiming to run forever.

Codex rows use the native state database's saved task name/title by exact session identity, then the session index or journal metadata as a fallback. The read-only query selects only identity and title, supports older schemas without explicit names, and is cached for five seconds. Nodes with running shell work appear before idle-only nodes, with the current node favored within those groups.

Cursor discovery handles nested JSONL, flat JSONL/text journals, CLI metadata without a journal, and recent metadata in the desktop database. Unknown project paths do not hide otherwise valid sessions. Discovery database queries select metadata only and open read-only. Opening an IDE composer reads only that composer's bounded visible text and reasoning; a real SQLite fixture verifies that unrelated composer content is excluded and revisions update in place. Cursor lifecycle hooks observe prompt submission, tool activity, reasoning, stop, and session end; they only append identity, cwd, event and timestamp. The event script JSON-escapes fields and records the tmux session when available. It does not record prompts or tool contents and does not make client permission decisions.

A hook names one native session, or one tmux shell; a sibling's activity cannot light up or stop another session just because they share a cwd. A later journal completion outranks a missed Stop hook. Claude's live registry proves process existence; bounded journal lifecycle metadata fills in busy/idle for clients whose registry omits that field, including quiet tool waits. Native print clients may omit the registry entirely, so their unfinished journals also supply running evidence. Versions that persist a null stop reason on their final text use a five-second text-only grace period to infer completion; this is a fallback heuristic, and a valid native start hook remains authoritative until its stop/end event or an explicit journal completion. Tools and thinking keep the longer active-turn window. Additive Claude prompt/tool/stop/end hooks provide future native lifecycle observations while preserving existing settings and hooks.

The native list and conversation rows render a rotating running indicator. Remote conversation status comes from the owner's live metadata endpoint, polled every five seconds, with the durable index as a non-running outage fallback. Native peer snapshots older than ninety seconds no longer claim running. The recent lists are still visible when a peer is unreachable.

Garrison list metadata is projected from the canonical conversation ledger as well as legacy channel records. Card conversations started before opening `/talk` are discoverable and openable without manufacturing a legacy transcript. Incremental 64 KB reads retain only metadata and lifecycle state, including across log rotation. List deletion leaves a small tombstone so a retained ledger does not immediately rediscover the deleted row; explicitly reopening can restore it. Conversation groups precede the expanded native shell section, and the open conversation's activity stream updates its spinner immediately.

Selecting a known shell attaches its existing terminal without allocating another agent. Selecting a native CLI or IDE session opens an xterm observer of its live recorded output. The observer is read-only: opening a row never duplicates a running client. A separate resume action is available for supported CLI sessions when idle, and background agents retain Attach. An IDE composer is not offered an unproven CLI resume command. Native output is bounded to recent terminal scrollback, and recorded terminal control codes are stripped before rendering.

## Verification

- TypeScript check passed after the initial changes and after the expanded implementation.
- 76 tests passed across ten focused files: shells-listers, talk-mesh-sessions, talk-mesh-threads-live, talk-native-terminal, shells-hooks-install, talk-rail-rows, talk-transcript-formats, remote-shell-runtime, remote-shell-local-transport, remote-shell-multisession.
- The suite includes actual local tmux creation, SSH attach/input/completion, and a RemoteShellAdapter turn through a live test server.
- Regressions cover native plus redirected Codex homes; old creation directories resumed today; quiet Codex turns followed by explicit completion; separate sessions in one cwd; exact tmux hook matching; hook JSON quoting and metadata-only capture; Cursor flat journals and CLI metadata; more than eight recent peer conversations; live remote shell indicators; tethered HTTPS app origins; and stale peer fallback.
- A metadata-only build against this Mac's real native data returned twelve recent sessions in 291 ms: one working Codex, three idle Codex, two unknown Codex, one idle Claude, five ended Claude. No transcript content was printed.
- Follow-up regressions passed for session-end clearing unfinished shell turns, remote shell wrappers not claiming local native identities, UTF-8 byte boundaries in incremental journal reads, Cursor desktop output, and vocabulary. The last focused run passed all fourteen selected checks.
- Browser fixtures verified Claude, Codex and Cursor native shells plus local and remote Garrison conversation spinners, a four-day-old ended session, disabled resume while running and enabled resume after idle, and all five spinners clearing on idle. Native terminal height was 711 px in an 800 px pane. A revised Cursor event rendered once, with no browser errors. Owner-node evidence: `output/playwright/session-view/{desktop,cursor-revision}.png` and `verify.mjs` (ignored).
- A real authenticated local Codex task in a temporary directory ran a neutral `sleep 60`. The actual patched session index stayed working after more than 26 seconds without journal writes, then changed to idle after explicit completion. Owner-node evidence: `/private/tmp/garrison-native-session-check/verify-local.mjs`, `second-events.jsonl`, and `second-stderr.log`. These temporary session artifacts remain on their owner node.
- The tunnel/DNS issue was subsequently recovered and the same neutral native Codex task completed on dev-madrid. Its predeploy live shell index did not discover the native-home task, reproducing the old redirected-home bug; verifying that node's corrected live index requires the parent convergence deployment. Owner-node evidence is `/tmp/garrison-native-session-check/{events.jsonl,stderr.log}` on dev-madrid. Cursor mini/csg acceptance remains part of the mesh rollout.
- After deployment of `b1af8233`, the actual dev-madrid live index passed the neutral native check: working was observed from 10 seconds onward and remained working through more than 28 seconds without a journal write; successful native completion was followed by idle at 90 seconds. Owner-node evidence: `/tmp/garrison-native-session-check/live-verification.json`, `live-events.jsonl`, and `live-stderr.log` on dev-madrid.
- The live UI follow-up added regression coverage for saved Codex names/titles, older database schemas, and active node group ordering. A metadata-only read of real local Codex data found nine titled rows and eight distinct titles among ten recent rows in 73 ms; no title contents were printed.
- The canonical list follow-up passed seventy focused checks covering launcher activity, replies, canonical-only card discovery/opening/deletion/reopening, partial records, log rotation including the stat/open race, mesh metadata and responsive browser behavior. TypeScript and diff checks passed. Against the real local artifacts, the completed browser QA conversation listed four messages and the completed card conversation listed two; both were openable and idle, with a cold 21-row list taking 47 ms.
- Live browser acceptance by the parent task: at 390 × 844 there was no horizontal overflow, the short composer was 112 px and its input/attachment control 44 px; a 514-character draft remained editable in a 306 px composer with a scrolling input. The actual Kanban card pane measured 634 px on desktop and 673 px on phone, with a 172 px composer. An actually working native Codex row showed the spinner animation, and opening it showed an 811 px terminal with 48 nonempty rows, no chat composer, and no browser errors. Owner-node evidence includes `output/playwright/conversation-layout/live-qa-message.png`; the temporary test draft was cleared.
- The Claude follow-up passed 39 lister, hook-installation and real local transport checks. Coverage includes a live process registry without a busy field, a 45-second quiet tool journal retaining working status, explicit completion clearing it, and installation/uninstallation preserving pre-existing Claude hooks and permission settings. TypeScript passed. The first native Claude smoke exposed the missing busy field; its background command completed after the model had already finalized, so it is retained as diagnostic evidence, not a passing quiet-turn check.
- A later native Claude check followed the installed wait policy: one neutral background `sleep 45` followed by a blocking TaskOutput wait. On the Pro, the actual source index and raw lister observed working throughout 38.8 seconds without a journal write, with no process-registry row; after native exit 0, settled null-stop final text cleared the spinner at 5.9 seconds. Owner-node evidence: `/private/tmp/garrison-native-claude-check/final-verification.json`, `final-events.jsonl`, and `final-stderr.log`.
- Against deployed dev-madrid's actual `/index`, native Claude hook status remained working through 39.2 seconds of journal silence and then changed to ended after completion. The test also verified actual matching start and stop/end hook records. Owner-node evidence: `/tmp/garrison-native-claude-check/awaited-verification.json`, `awaited-events.jsonl`, and `awaited-stderr.log`. Both native checks passed all acceptance flags. Follow-up fixtures cover registry-absent print clients, null-stop text inference without overriding explicit hooks, and 305 recent Claude journals rather than the former 300-row cutoff.

## Implementation note

### 2026-09-08: phone discovery and the misleading Shells entry point

The user's iOS build 35 screenshots showed a separate usability failure: native rows followed the complete conversation history, while the terminal icon opened the project-shell spawner. Its transport array began with CSG, so opening it tried an unavailable local `devtunnel` executable on the Pro. The existing row-count acceptance did not establish phone discoverability.

The rail now has an always-visible Shell sessions switch with its count and running indicator. The terminal icon selects that list, expands it and scrolls to its beginning. Machine and app filters make Mini/Claude Code/Cursor sessions directly reachable. Opening a native row keeps the existing read-only terminal; creating a new shell remains a separate action. The legacy project-folder browser now prefers the local machine even when CSG is first in its transport array.

Full TalkApp regressions use a 393 × 852 phone viewport in Chromium and WebKit, eighty preceding conversations and an old saved collapsed-session preference. They verify the switch is visible without scrolling, machine/app filtering reveals the matching row in the viewport, its spinner is present, the legacy picker defaults to local, and selecting existing native output does not create a shell or invoke CSG. Fourteen focused tests and TypeScript passed. These are browser checks; actual iOS build 35 acceptance remains the user's device.

The first live WebKit run on the Pro confirmed all four requested owner/app selections and opened Mini Cursor output. A repeat caught a late initial-conversation response closing the drawer. Initial restoration now preserves a drawer the user opened and yields to explicit session selection; selecting native output aborts pending conversation restoration. The phone regressions hold the initial response until the drawer is open or a native session has been selected, then prove neither is replaced. Explicit styling also preserves 44 px native-filter touch targets in WebKit. The same fourteen focused checks and TypeScript passed with these delayed-response cases.

A metadata-only Mini check found the expected seven recent Cursor sessions and one native Claude Code session. Its local Claude Desktop Code session files were last changed in April, and Cowork session artifacts in August; recent scheduler/plugin configuration writes are not session activity. No client transcript, prompt, project or desktop account was changed. The CSG origin remains unavailable, so sessions worked there after its last publication cannot be independently confirmed until it reconnects.

### 2026-09-08: retain the complete list during slow or failed refreshes

A full owner-index comparison reproduced eight recent Mini sessions disappearing from the Mini's own Conversations API: its index took 5,148 ms against the collector's 2,500 ms deadline. Pro and dev-madrid retained those same eight through published metadata. The collector now falls back to the owner's published snapshot and retains successful local, peer and node-registry reads across failures. Successful empty reads still remove rows. Retained snapshots keep their original activity dates; stale working states become unknown before the five-day filter runs.

The browser also distinguishes failed or malformed refreshes from a successful empty list. It retains recent rows without claiming unconfirmed running status, shares overlapping focus/timer requests, and aborts stalled requests or unmounted views. A selected transcript can remain open without retaining a stale running lamp.

Twenty focused checks passed, including the actual 2.5-second local timeout and a full TalkApp Chromium test comparing fifteen distinct identities across five owners and three clients. The browser test covers HTTP failure, malformed results, status recovery, overlapping requests, five-day expiry and successful empty results. TypeScript and diff checks passed. Before release, all three reachable app origins agreed on 77 identities: Pro 21, dev-madrid 39, Mini 8, csg 4 and Air 5. Live post-release acceptance is recorded in shared Garrison Node Operations; csg's own origin and Air were unavailable at this baseline, so cached metadata is not evidence of live owner availability.

A later long-running HTTPS check found 214 native DOM rows for only 70 unique identities, with stale spinners. The Mini supplied two Cursor sessions twice: their real Cursor journals and hook-only Claude aliases sharing the same node/session React key. Cursor deliberately executes compatible `~/.claude/settings.json` hooks alongside native hooks ([compatibility contract](https://prod.cursor.com/docs/reference/third-party-hooks)); the installed Mini code also confirmed that its documented `cursor_version` payload field reaches both invocations. The observer now uses that payload marker to identify Cursor, without trusting an environment variable that a real Claude terminal could inherit.

The index favors directly discovered identities, suppresses aliases of owned shells, and prefers a native Cursor event when an older observer recorded paired hooks before the first journal. Hook-only Cursor identities cannot resume until CLI metadata proves a resume target. The rail also protects against older peer snapshots: it renders each node/session identity once, prefers its transcript, and applies conversation/card ownership to all aliases. The browser regression changes duplicate ordering across six polls and verifies one Cursor row, a working spinner during quiet polls, and no spinner after completion. The focused final run passed 54 tests plus TypeScript; `/private/tmp/garrison-native-alias-final-20260907.log` holds owner evidence. Actual client behavior was observed without sending a prompt: a Mini Cursor IDE session was working at 16:14:02 UTC, emitted its stop at 16:14:55.530, and subsequently appeared idle on both Mini and the Pro's mesh API.

The Mini's live Cursor metadata-only rows intermittently disappeared while its three transcript-backed rows remained visible. The metadata cache previously discarded its successful snapshot before each SQLite query. A temporary database lock or failed read therefore looked like deletion. The follow-up retains the last successful snapshot for the same database on read failure, logs only a bounded failure category, and still applies the five-day cutoff to the original activity times. A successful empty query or confirmed database removal clears the snapshot. Reads are synchronous, so refreshes cannot interleave within one process.

The follow-up passed 44 native lister, mesh-session, hook and terminal tests plus TypeScript. Its real SQLite regression holds an exclusive lock, verifies retained rows and content-free diagnostics, releases the lock and observes a renamed session; separate checks cover five-day expiration during failure and actual deletion. Evidence: `/private/tmp/garrison-cursor-cache-focused-20260907.log` and `/private/tmp/garrison-cursor-cache-typecheck-20260907.log` on the Pro. Deployment verification is recorded separately in the shared node operations note.

`session-index.mjs` in the previous revision contained literal NUL bytes as map-key separators. The change replaces them with equivalent JavaScript `\0` escapes. Git may display the old-versus-new diff as binary because the old revision contains NULs; `git diff --text` displays the source changes for review.

## Native output recovery — 2026-09-08

The final Mini Cursor check exposed three delays at the viewing boundary. Native
output lookup waited for whole-mesh aggregation; a transient index failure could
therefore look like a permanently missing transcript. Its real owner stream also
sent a single 2,374,790-byte initial frame. Finally, a real Chromium check showed
that a 502 leaves EventSource closed without retrying, despite the terminal's
reconnecting label.

The follow-up uses the owner's local index with bounded retry, flushes stream
headers immediately, and keeps temporary lookup failures retryable. Initial
recent output travels in smaller ordered frames. The terminal explicitly retries
closed failed connections and cleans up retries when closed or unmounted. These
changes are confined to native session viewing; no optional fitting changed.
Targeted test and owner-node live acceptance results are recorded in the shared
Garrison Node Operations note.

Server and related focused checks passed 68 tests. The final combined native
stream and browser run passed all 30 tests, including the existing conversation
stream regressions; TypeScript passed. Owner evidence:
`/private/tmp/garrison-native-final-checks-20260908.log` and
`/private/tmp/garrison-native-stream-batched-typecheck-20260908.log`.

## Structured native conversations — 2026-09-08

The user's latest screenshot exposed tool results labelled USER in the terminal
observer. Claude deliberately records tool results inside user envelopes; the
parser already identifies these correctly. Native sessions now open in the shared
conversation renderer, which associates results with their tool calls and folds
completed activity. Plain output remains available, with block-specific labels
for tool calls, results and progress rather than envelope-role labels.

Owned shells retain the matching native journal in the session index before the
native duplicate is suppressed. Their conversation view stays visible while the
real terminal remains mounted behind Show shell. The composer sends to that exact
shell through its existing input endpoint. Failed sends retain the draft and show
the failure; duplicate submissions and composition-key Enter are guarded. This
does not manufacture an input channel for a running external IDE or arbitrary
unattached terminal. Resumable sessions retain the explicit Continue in a shell
action, and attachable background sessions retain Attach.

Collapsing custom groups, Ungrouped, or the shell section hides every contained
row, including selected and running sessions. Only the standing Zeca row remains
outside those groups. Each native machine has a persistent collapse control and
a running indicator on its header. Ungrouped has a header even without custom
groups. The mobile terminal button now has a 44px target and centered icon.

Focused browser checks cover actual Chromium and WebKit phone rendering, tool
result attribution, collapsed tool activity, complete group collapse, machine
collapse persistence, a hidden connected terminal, prompt delivery and failed
send recovery. Native idle streams also retry closed HTTP failures without
reopening a successfully completed stream. Existing list-retention, alias,
initial-load, session-stream and rail tests remain green. Live deployment and
neutral-shell acceptance are recorded in shared Garrison Node Operations.

The neutral live Codex-shell check found that the service's inherited CODEX_HOME
selected Garrison's isolated runtime profile. Local node shells now explicitly
launch new Codex clients with the native profile; resumes select the profile that
actually contains that session identity. Existing tmux-server environment cannot
override that choice. Dev/codex sandboxes keep their isolated profiles. The first
temporary shell was removed without sending a model prompt. A follow-up also
restores action-button contrast and compacts the native header on phones.
