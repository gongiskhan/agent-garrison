# Recent native sessions and mesh running indicators

Date: 2026-09-07. Owner node: MacBook Pro. This records code and local verification; mesh rollout and real client acceptance are verified separately by the convergence task.

## Behavior

Conversations expands the Shell sessions section by default and shows sessions active in the last five days, including ended Claude sessions. The former twenty-ended-row cap is removed. Native sessions already represented by a conversation or owned shell retain one list row; separate sessions in the same project no longer disappear just because a Garrison shell has that cwd.

Codex discovery includes the user's native home alongside the runner's redirected home. It scans old creation directories by current file activity, so resuming an older task brings it into the five-day window. Bounded journal metadata reads recognize explicit task start/completion and abort events. A quiet ongoing tool/model call keeps its spinner, while completion clears it immediately. An interrupted journal without completion ages to unknown after six hours rather than claiming to run forever.

Cursor discovery handles nested JSONL, flat JSONL/text journals, CLI metadata without a journal, and recent metadata in the desktop database. Unknown project paths do not hide otherwise valid sessions. Discovery database queries select metadata only and open read-only. Opening an IDE composer reads only that composer's bounded visible text and reasoning; a real SQLite fixture verifies that unrelated composer content is excluded and revisions update in place. Cursor lifecycle hooks observe prompt submission, tool activity, reasoning, stop, and session end; they only append identity, cwd, event and timestamp. The event script JSON-escapes fields and records the tmux session when available. It does not record prompts or tool contents and does not make client permission decisions.

A hook names one native session, or one tmux shell; a sibling's activity cannot light up or stop another session just because they share a cwd. A later Codex journal completion outranks a missed Stop hook. Claude's live registry remains its primary source of live status.

The native list and conversation rows render a rotating running indicator. Remote conversation status comes from the owner's live metadata endpoint, polled every five seconds, with the durable index as a non-running outage fallback. Native peer snapshots older than ninety seconds no longer claim running. The recent lists are still visible when a peer is unreachable.

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

## Implementation note

`session-index.mjs` in the previous revision contained literal NUL bytes as map-key separators. The change replaces them with equivalent JavaScript `\0` escapes. Git may display the old-versus-new diff as binary because the old revision contains NULs; `git diff --text` displays the source changes for review.
