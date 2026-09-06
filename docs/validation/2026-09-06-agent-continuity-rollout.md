# Shared agent continuity rollout — 6 September 2026

The requested scope is Claude Code, Codex and Garrison sessions on the MacBook
Pro, dev-madrid and MacBook Air, with shared project memory and instructions,
working Codex models, and a tested, usable Conversations surface.

Final code `16d4dd8c` is deployed and healthy on the MacBook Pro and
dev-madrid. Actual Astra → Claude SDK → Astra shared-memory operations,
selected default duties, full answer delivery and phone-width browser checks
passed. The Air received the earlier continuity setup and upgrades, but is
offline for the final patch. Explicit approval and native-app steps below
remain outstanding; this is not an all-host completion claim.

## Shared instructions and memory

- Garrison's `AGENTS.md` is a relative symlink to `CLAUDE.md`; the canonical
  document preserves both former instruction sources. Codex's instruction
  budget is raised to retain the complete project context.
- All ten configured user and isolated-runtime Basic Memory transports passed
  authenticated initialize, shared read, bounded synthetic write and read-back.
  The authority is Basic Memory project `main` on dev-madrid.
- Forty-nine other project checkouts now have unified instructions: 18 on the
  MacBook Pro, 25 on dev-madrid and six on the Air. Both original instruction
  texts were retained and privately backed up. Two `pnmui-mon` checkouts use an
  excluded local `AGENTS.override.md` symlink to private Claude instructions;
  their public `AGENTS.md` files remain intact. Actual corporate-sync exclusion
  checks passed. No other project's private instructions were published.
- Shared lifecycle hooks publish project/session metadata and structural
  checkpoints. Authored decisions still require deliberate shared topic notes.
  Existing private Claude-note import is disabled while its explicit approval
  is pending. Raw transcripts are excluded.
- Fresh authenticated Astra CLI sessions on all three hosts automatically
  published checkpoints that were read back through shared memory. Fresh Claude
  sessions succeeded on the MacBook Pro and dev-madrid. Air Claude's hooks ran,
  but authenticated Claude execution requires login there.
- Production testing found that the SDK inherited an isolated Basic Memory
  configuration and index despite the same executable and project name. Both
  configurations name the same physical vault; no file-collection fork was
  established. `dce4dc63` explicitly pins the enrolled authority for SDK
  MCP children, checkpoint workers and newly generated owned Codex transports.
  Conflicting inherited environment tests and a live exact-note read pass.
  Existing unowned MCP entries and the former configuration/index are preserved.
  The actual model-to-model read/update/read round trip passed on the final
  revision, separately from configuration and transport checks.
  A fresh SDK run verified authoritative automatic checkpoint delivery but
  revealed a first-turn race: the initial model request preceded MCP startup;
  the next request had all 23 memory tools. The final SDK gate now waits for
  explicitly configured MCPs before admitting a prompt; real native SDK tests
  cover first-request tool visibility and Stop before startup.

## Hosts

- Codex CLI is `0.153.4` on all three machines. An authenticated, ephemeral Astra
  run on the Air returned `ASTRA_AIR_OK` with exit 0.
- The Air's signed ChatGPT desktop bundle is `26.901.51231` (build 8109), with
  its previous bundle preserved. The running process was not restarted.
- The local SSH alias `mac-air` is configured and authenticated.

## Conversations and model evidence

The production candidate at `54150815` passes typecheck, the optimized Next
production build and 757 tests across 53 affected suites on an isolated
dev-madrid checkout. A further 41-test gateway/launcher run at `d4cb2f45`
includes two added Stop admission regressions. Desktop/mobile legacy parity
passes 24/24. Normal conversation HTTP tests separately prove concurrent retry
deduplication, restart recovery, applied routing controls and cancellation.

The earlier private candidate `dce4dc63` adds informational-answer completion,
preserved implementation evidence obligations, truthful settled runtime/model/
effort attribution, optional Cursor startup degradation, background discovery
of conversations created by other clients, and the memory-authority correction.
Its combined dev-madrid gate passes 199 tests across nine suites, eight separate
gateway continuity tests, seven installed-layout Codex tests and 18 Python
bridge tests. The 199 include seven real browser checks. Earlier overlapping
test runs are evidence at their stated revisions, not additional unique tests.

Actual default Astra planning/review and Sol validation produced substantive,
grounded responses. Fresh `dce4dc63` runs each completed in one stretch with
applied effort and no repair/escalation after the unwanted prose-only
`done -> test` rewrite was fixed. The saved outputs pass the bounded quality
rubric. Browser acceptance found that full replies with no streamed text were
saved in owner payload files but omitted from the journal; user-facing delivery
is corrected by `16d4dd8c` and verified through the live HTTPS browser. Full
Astra review and Sol validation appear once, and the fresh post-Stop reply is
visible. The actual HTTPS Stop button cancelled a disposable
SDK turn without a repair call or follow-on stretch. Its shell command had
already returned, so this is turn-cancellation proof rather than proof of
interrupting that command.

Detailed results are in:

- [Conversations backend audit](2026-09-06-conversations-audit.md)
- [Responsive Conversations UI](2026-09-06-conversations-ui.md)
- [Codex duty quality](2026-09-06-codex-duty-quality.md)
- [Shared continuity operation](../CODEX_MEMORY_WORKFLOW.md)

## Deployment and remaining gates

The `dce4dc63` private candidate's optimized builds and supervised deployments
passed on all three nodes. Each reports 17/17 healthy views and a running
default composition: Air started at 10:35:35Z, MacBook Pro at 10:37:06Z and
dev-madrid at 10:37:54Z. The final `16d4dd8c` patch includes the enrolled CLI authority path, bounded
SDK tool readiness, informational report completion, saved full-answer replay
and mobile long-path wrapping. It passes typecheck and 206 focused integration
tests in the dev-madrid clone. The local optimized build and supervised rollout
completed: the default composition started at 15:40:15Z, health is OK, and
17/17 views are healthy with degraded false. The temporary supervisor ran once,
exited zero, and was removed; evidence is in
`~/.garrison/backups/final-conversations-20260906T154015Z/` on the Mac.
Dev-madrid also completed its supervised deployment, started at 15:44:30Z,
and passed 43/43 fitting probes plus 17/17 healthy views. Its durable evidence
is under `~/.garrison/backups/final-conversations-20260906T154008Z/`. The Air is offline in Tailscale and SSH times out; its last
verified deployed code remains `dce4dc63`, so the final patch is pending there. Code moves between
nodes through bounded Git bundles while public publication is paused. Original
dirty generated files, pre-merge tags and private backups were retained; no
branch was created and lockfiles were regenerated.

The first temporary macOS rollout jobs unexpectedly repeated because
`launchctl submit` implied KeepAlive. They were explicitly removed. Replacement
jobs use plists with `RunAtLoad=true`, `KeepAlive=false`; completion requires
exactly one run and exit zero, followed by removal of that exact temporary job.
Garrison's normal service supervisor remains separate.

Automatic approval review requires explicit permission to import existing
private authored Claude notes (27 on the MacBook Pro, 71 on dev-madrid, zero on
the Air) and to expand the state service's composition
file allowlist for exactly `.garrison/routing-table.json`. Both actions remain
paused. The current Git routing file can be deployed without changing that
allowlist: the authority has no entry for it, and composition synchronization
only refreshes listed files.

Automatic approval review separately blocked public disclosure of the latest
fixes to GitHub. Approval is pending. Each node has a reversible repository-local
push-URL guard so its Git pump cannot publish these commits indirectly; fetches
and private Git transfers continue. Restore the privately backed-up push URLs
only after publication is approved.

The computer-use tool explicitly blocked Codex app control. The Air desktop
relaunch and native Codex SSH Connections activation therefore remain user
steps; installing the app bundle and SSH alias does not prove them complete.
Ordinary cloud chats also need the project files and shared Basic Memory
connection; local CLI hooks alone do not connect a cloud conversation.

Real-phone microphone, APNs and native keyboard gates remain distinct from
browser viewport checks.

## Shared memory: final semantic and lifecycle proof

The final dev-madrid deployment at `16d4dd8c` completed successfully: its
external supervisor exited zero, 43/43 fitting checks passed, all 17 views were
healthy, and the tailnet Conversations route returned 200. Installed SDK,
gateway and Improver files matched the source; the stable continuity tooling
checkout had the same revision. The MacBook Pro also passed its final build,
single-run supervisor and 17/17 health check. The Air's final patch remains
pending while it is offline; its earlier continuity installation is retained.

The actual configured model duties completed this single-note round-trip in
Basic Memory project `main`:

| Step | Actual conversation and runtime | Verified operation |
|---|---|---|
| Original writer | `chat-mtpnl1eb-sy8r8z`, Codex / Astra | Created and read the synthetic note through Basic Memory |
| Claude update | `chat-mtpzhtza-xdq1yf`, dialogue level 2, agent-sdk / `claude-sonnet-5` | Actual `read_note` → `edit_note` → `read_note`; preserved the original marker and added one verification line |
| Astra read-back | `chat-mtpzl1c3-2u0mga`, plan level 3, Codex / `gpt-6-astra` | Actual `read_note` returned both the original writer and Claude's exact update; completed in one stretch with `completion: answer` and effort applied |

The note is
`main/projects/garrison/memory/qa/agent-continuity-qa-20260906-1012`, with marker
`GARRISON_CROSS_RUNTIME_20260906_1012`. Its final content was independently read
through the common MCP. The Astra tool call and matching tool result were
verified in that synthetic session's own rollout; the proof is not inferred
from its prose reply. The private metadata-only evidence is
`/tmp/garrison-live-duty-quality-20260906/astra-readback-tool-proof.json` on
dev-madrid. No raw transcript was placed in shared memory or this report.

Both final Garrison sessions also automatically delivered ended lifecycle
checkpoints to the common authority: Claude SDK
`f3fcfcccc886f50816f9` and Astra `b6d6c8f00c59f8f9206a`. Each records its actual
runtime, model, duty, owner node and `16d4dd8c` revision. Their private pending
records had drained. The Mac's SSH CLI fallback and dev-madrid's local fallback
both read the exact QA note with exit zero while deliberately inheriting
conflicting fitting memory/XDG locations.

Two real failures informed the final fixes. Separate Basic Memory
configuration/index locations could hide a recent note even though both
configurations pointed at the same physical Obsidian vault. Explicit authority
selection fixes that visibility; no existing collection was merged or copied.
Then the SDK sent its first request before Basic Memory connected. The final
readiness gate waits up to 15 seconds before admitting input; native SDK tests
prove the first request contains a delayed MCP tool and startup cancellation
sends no model request. CLI fallback and Improver maintenance use the same
registered local/SSH authority, with invalid enrollment failing closed.

Instruction continuity also covers 49 other named project checkouts
(18 MacBook Pro, 25 dev-madrid, 6 Air), preserving the full original texts with
private backups. Both `pnmui-mon` checkouts retain their public/private split
through a local `AGENTS.override.md` symlink excluded by Git and the corporate
sync filters. The largest measured canonical plus user instruction context was
61,804 bytes, below the configured 65,536-byte budget.

Earlier fresh native Astra sessions on all three nodes and fresh Claude CLI
sessions on dev-madrid and the MacBook Pro published verified shared
checkpoints. The Air's Claude attempt published lifecycle metadata but could
not make an authenticated model call; normal Claude login remains necessary.
Existing running desktop sessions need a fresh session to load new guidance.
The 98 existing private authored Claude notes remain local pending approval;
automatic authored-note import is disabled. Shared topic notes, manual client
transport checks, actual model operations and automatic lifecycle observations
are distinct evidence categories.

The redundant diagnostic card `01M1V4T6M2891MCG2WWFZSY4G5` was closed through
the supported manual Done transition after the final verification, using its
CAS revision (6 → 7) and an explicit evidence reason naming the successful
conversations. Its title, description and existing conversation history were
verified intact; the obsolete approval request was cleared. No card or
conversation history was deleted. Sidebar archival is coordinated separately
by the rollout owner.

## Final reporting and cleanup

The final normal report duty selected Sol at low effort and completed one
stretch in 51 seconds without repair or an extra test round. It reported the
actual deployment artifact accurately and kept that artifact's narrower scope
explicit. The full answer arrived once in live SSE and appeared in the HTTPS
browser. The later live memory proof above supplies the separate semantic gate.

Fifteen task-owned QA sidebar keys (thirteen dev-madrid conversations plus two
Air-owned rows) were archived on dev-madrid and the MacBook Pro. Their histories
and evidence remain intact; all other sidebar fields were checked unchanged.
Private before/after backups are under `~/.garrison/backups/qa-sidebar-<stamp>`
on each reachable node. The Air's own sidebar cleanup awaits connectivity.
