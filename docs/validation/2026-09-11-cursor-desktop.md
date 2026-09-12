# Cursor desktop sessions: Mac mini exploration

Status: Phase 0 measurements complete after the operator authorized stopping the
existing background terminal on September 12. Implementation begins with ingestion.
No production ingestion, steering, or creation feature has been installed yet.

The owner is goncalos-mac-mini-1. Initial measurements used Cursor 3.20.10;
quitting for the no-window test applied its pending update to 3.20.17. Work is on main.
The test harness is `scripts/cursor-desktop/probe.mjs`; its isolated regression
suite is `tests/cursor-desktop-probe.test.ts`. Fifteen tests pass.

Raw scratch payloads remain on this node at
`~/.garrison/cursor-probe/events.jsonl`, with mode 0600. They must not be
committed or copied to another node. The workspace is
`~/.garrison/cursor-probe/probe.code-workspace`, containing only the two
disposable roots `scratch/alpha` and `scratch/beta` beneath that directory.

## Repository mapping

- E1: `packages/talk/ui/sessions-rail.tsx` lists native sessions;
  `session-view.tsx` renders the existing desktop observer;
  `shell-panel.tsx` and `remote-shell-pane.tsx` attach terminal-backed sessions.
  `fittings/seed/remote-shell-runtime/lib/listers/cursor.mjs` reads Cursor's
  transcript directories, CLI chat metadata, and desktop composer metadata.
  `packages/talk/src/cursor-desktop-transcript.mjs` reads ordered visible
  desktop bubbles through read-only SQLite. `packages/talk/src/router.mjs`
  serves the native transcript stream and `/api/sessions` list.
- E1 correction: the state authority is on dev-madrid. Its schema uses
  `config_docs` for namespaced metadata, including `shells.sessions` indexes.
  Conversation entries themselves are local append-only journals. Do not add
  a second local shared-state database or publish Cursor payloads to the mesh.
- E3: the common renderer consumes `SessionEvent` objects with stable IDs,
  roles, timestamps, and typed blocks. Text, thinking, tool_use, tool_result,
  route, stretch, and ledger blocks already exist. `SessionStream` is already
  used by native desktop views; `ConversationView` is used by both the main
  conversation page and `fittings/seed/kanban-loop/ui/card-conversation.tsx`.
  The intended integration reuses this event vocabulary and renderer.
  The concrete event fields are id, role, ts, turnId, sessionId, generationId,
  order, revision, retracts, toolResultsOnly, and blocks. A tool block carries
  type, name, input, toolUseId, result, isError, status, and optional timing
  fields. Route attribution already accepts runtime, provider, model, effort,
  account, project, and sessionId. The shared conversation header exposes
  headerLeading and headerExtra for small native-session affordances.
- E4: the shell app listens on 127.0.0.1:8777 through the instance launcher.
  The Shells server listens on 127.0.0.1:8098. Its existing routes have an
  Origin guard, not a general API token check. The existing internal token is
  the mode-0600 `~/.garrison/internal-token`, checked by
  `src/lib/internal-token.ts` and presented as `x-garrison-internal` by current
  protected app routes. Any new Cursor ingress must explicitly require it.
  Machine-specific fitting settings use the gitignored composition `local.yml`
  overlay. No new listener or tailnet publication has been created by the probe.

## Live findings

- E2: user-level hooks execute on macOS, with cwd `~/.cursor`. The marked
  probe entries coexist with all six pre-existing user-level Garrison entries.
  No team or enterprise hook file was read or modified. The initial probe
  containing permission allow responses was rejected by automatic approval
  review. The accepted probe returns only neutral empty objects for pre-events,
  records only the exact scratch roots, and holds only explicitly armed scratch
  conversations. It does not grant or deny any operation.
- E5: final response hooks include the complete final `text`. The observed
  common fields are conversation_id, generation_id, model, session_id,
  hook_event_name, cursor_version, workspace_roots, user_email, transcript_path.
  Some events add model_id and model_params. The transcript starts as null and
  becomes a readable per-conversation JSONL path during the turn. It contains
  user and assistant messages, typed text/tool blocks, and status records.
  Token counters also arrive on response and stop events.
  The complete observed field inventory and hold timings are in
  [the redacted measurement summary](2026-09-11-cursor-payload-schema.json).
  That summary contains field names and timing evidence, without raw payloads,
  user addresses, conversation identifiers, or transcript contents.
- E5: duplicate thought payloads arrive with identical text and both a base
  generation ID and a suffixed generation ID. A generation-only dedup key is
  insufficient. Normal user prompts in the measured chats arrive once.
- E5: captured events include sessionStart, sessionEnd, beforeSubmitPrompt,
  beforeReadFile, beforeShellExecution, afterShellExecution, afterFileEdit,
  preToolUse, postToolUse, afterAgentThought, afterAgentResponse, and stop.
  beforeMCPExecution and afterMCPExecution were captured after the operator
  authorized one read through the existing local tool provider. No provider
  was installed. The earlier automatic approval rejection was not retried until
  the operator answered the pending exception with "You do it".
- E5 permission shapes: the current public hook documentation specifies
  `{ "continue": true }` for beforeSubmitPrompt and `{ "permission": "allow" }`
  for beforeReadFile, beforeShellExecution, and beforeMCPExecution. The scratch
  probe's neutral `{}` output was accepted without blocking submission or tools.
  Production permission behavior still requires its own acceptance tests.
  After authorization, the scratch probe returned the explicit documented
  shapes for a real prompt, built-in file read, generic preToolUse events, and
  shell command. All completed and the final response was permission-shape-ok.
  Non-scratch probe events continue returning only neutral empty objects.
- E6: the 120-second stop hold completed and returned a followup_message.
  Cursor fired beforeSubmitPrompt for it and displayed it as a normal user
  message. The assistant replied as requested. The transcript also records it
  with role user.
- E7: both absolute roots appear in workspace_roots. Independent synthetic
  per-root rules were followed in one new chat: reading both probe files caused
  both rule markers to appear. Only disposable scratch folders received rules.
  The machine workspace now exists at
  `~/.garrison/cursor-workspaces/indy.code-workspace`, listing the real
  `~/Projects/garrison`, `~/Projects/indy-api`, and `~/Projects/indy-frontend`
  roots. It is outside those repositories. Production settings are not installed.
- E8: the PATH cursor launcher reports that it cannot find a desktop install.
  `/Applications/Cursor.app/Contents/Resources/app/bin/cursor` works. A deep
  link reaches the focused classic scratch window and preserves an encoded
  ampersand. It displays a confirmation dialog. One Enter confirms creation,
  then leaves the prompt focused but unsent. No beforeSubmitPrompt appears.
  This differs from the brief's expected one-Enter submission path. The dialog
  offers only Cancel and Create Chat, with no persistent confirmation option.
  The unsent synthetic draft was cleared and a repeat confirmation cancelled.
  The operator subsequently authorized two Enter keystrokes. A node-launched
  focus, encoded deep link, confirm Enter, and submit Enter created one chat
  in 7.418 seconds, confirmed by its prompt hook and an assistant response.
  Both helper calls exited successfully. The encoded ampersand was preserved.
  Reusing an already open workspace selected that window even when the original
  Agents window was previously active.
- E8: reuse-window from the existing Agents Window initially prompted to kill
  an active client background terminal. That change was cancelled until the
  operator explicitly authorized stopping it on September 12. The terminal was
  stopped through Cursor's Close Anyway action, and Cursor was then quit.
  With no Cursor process running, opening the encoded bare deep link launched
  the Agents Window in its last workspace. Cursor showed a toast saying that
  its deep-link extension could not be installed because it was not found.
  The composer stayed empty: no new prompt was submitted. The creation driver
  must focus an existing classic workspace before opening the link and must
  require hook confirmation; a successful OS open command is not confirmation.
- E9: holds completed at 120.003, 600.070, and 1800.064 seconds with timeout
  30,000 seconds and loop_limit null. The followup beforeSubmitPrompt events
  arrived 106, 179, and 186 ms after the respective hook returns. All displayed
  as normal user turns and received the requested assistant response.
- E9: changing only the probe stop hook timeout to two seconds caused Cursor
  to send SIGTERM after 1.954 seconds of a requested 120-second hold. The hook
  returned one empty object and no followup was submitted. The timeout field
  is effective, and the real desktop process exercises the signal handler.
- E9b: the background hold remained alive until explicitly terminated for
  cleanup after 5915.482 seconds, about 98.6 minutes. It returned an empty
  object on SIGTERM. No additional cap was observed. The evidence supports
  leaving automatic rearm disabled unless a cap is later measured; it does
  not establish seven-hour availability.
- E10: a held hook does not keep this Cursor UI busy. A desk prompt submitted
  and completed immediately while the earlier hook remained alive. Returning
  that earlier hook's follow-up produced a separate normal user turn afterward.
  Both inputs appeared once. A screenshot taken near minute 28 of the
  thirty-minute hold also showed an idle composer with a microphone control,
  rather than an active stop control. Production must release the old hold on a new
  desk prompt, rather than relying on Cursor to cancel it.
- E10: the stop button during an active scratch sleep command emitted stop
  with status aborted; the probe returned immediately. Closing that completed
  scratch chat emitted sessionEnd with reason user_close. A held idle chat has
  no visible stop button. Hook SIGTERM behavior passes the isolated process test.
- E11: AppleScript activation of Cursor succeeds. Calls to System Events time
  out, including a read-only accessibility query. The required osascript Enter
  path is not verified. Desktop test interaction through the available test
  control is not evidence that a node-launched osascript can send input.
  System Settings shows Accessibility enabled for node and the computer-use
  helper. A subsequent read-only System Events call still timed out at four
  seconds. The cause is unresolved; a missing Accessibility grant is not proven.
  Native app selection itself stalled twice, including one 65-minute call
  despite its requested timeout. These tool delays are not Cursor hold caps.
- E11 continuation: a basic System Events name query succeeded in 63 ms. A
  UI-access query then returned connection-invalid error -609 and the process
  exited. Recent process error logs provided no further diagnostic. The actual
  required activation plus one `key code 36` was then tested against a focused
  synthetic scratch draft, using a five-second Apple Event deadline. It returned
  AppleEvent timeout -1712 after 5.32 seconds. No matching beforeSubmitPrompt
  arrived, and the draft remained visibly unsent. The draft was cleared and
  the temporary hooks removed again. This directly verifies failure of the
  required input path from this session, without attributing it to a particular
  missing permission or changing any system setting.
- E11 resolution: the actual node context passes the native keyboard preflight.
  `scripts/cursor-desktop/enter.jxa.js` runs through osascript, checks the
  existing Accessibility grant and that Cursor is foreground, and posts only
  one native Enter down/up pair. It uses the public Core Graphics event API.
  It reads no screenshots, application UI tree, or conversation content.
  The direct task process lacks native event access, while the node LaunchAgent
  has it. A real node-originated Enter and the full two-Enter creation flow
  passed. The first helper revision manually released bridge-owned objects;
  that cleanup error was removed before the successful creation test.
  System Events Apple Events still time out, including after a scoped restart.
  The task app's Automation switch was enabled with operator authorization;
  the duplicate node Automation entry remained off. No TCC database was edited.
  All one-shot diagnostic LaunchAgents were removed after their results.
  Native input evidence is in
  [the native input report](2026-09-11-cursor-native-input.json).
- E12 and E13: Windows-specific checks do not apply to this first Mac run.
  The user's normal Mac view is the Agents Window; the scratch view is classic.
- E14: Commit Attribution and PR Attribution are both on in Cursor Settings,
  Git & PRs. They were observed without being changed.

## Phase 0 completion

The two-Enter creation change and single tool-provider read are authorized and
verified. The no-window creation case is now measured after explicit permission
to stop the terminal. Its failure is recorded under E8. No CSG measurements have
been attempted. Seven-hour availability remains a final acceptance requirement;
the measured holds have found no cap, so automatic rearm remains off.

On 3.20.17 the node-driven two-Enter creation path passed again, with one
beforeSubmitPrompt in the correct scratch workspace and the expected assistant
response. An eight-hour scratch hold is now running to extend the earlier hold
evidence. Its outcome must be recorded before final acceptance. The one-shot
creation job has been removed; only the explicitly requested hook hold remains.
See [the window probe](2026-09-12-cursor-window-probe.json) for measured timing.

## Initial cleanup and authorized resumption

The temporary hooks have been uninstalled. The installer confirmed exact
restoration of the original user hooks, preserving all six existing entries.
Both remaining probe processes ended, and the disposable classic workspace
window was closed. The original Agents Window remains available. Synthetic
drafts were cleared; scratch transcripts and evidence remain local for resumption.
No service was restarted, no new listener was opened, and no client repository
was changed. No feature acceptance, phone UI tests, or full-suite result is claimed.

After the operator resumed the task, the scratch hooks and scratch window were
reopened for the remaining tests. The hooks were removed again after those tests,
with exact restoration verified. The six original user entries remain intact,
and all one-shot OS input test jobs were removed. The original client background
terminal was preserved after its close warning. The scratch window remains
available for the pending window-state decision; no measurement process is holding.

For a future probe, install with `node scripts/cursor-desktop/probe.mjs install`.
After the probe, uninstall with `node scripts/cursor-desktop/probe.mjs uninstall`.
This removes only its marker-owned entries and preserves unrelated changes.
Active measurement processes must first finish or receive SIGTERM; uninstalling
configuration alone does not cancel a process that is already holding.

Public contract reference: [Cursor hook documentation](https://cursor.com/docs/hooks).
