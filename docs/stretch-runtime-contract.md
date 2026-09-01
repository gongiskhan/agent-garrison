# The stretch runtime contract

What Garrison hands any runtime that executes a stretch, and what it demands
back. "Runtime" means the thing that runs one stretch to completion - the
Agent SDK today, Codex or OpenCode as the second lane. The launcher
(`fittings/seed/http-gateway/scripts/lib/stretch.mjs`) is the only caller;
an adapter implements this contract and nothing else.

## Garrison gives

| What | Where it arrives |
|---|---|
| **Resolved working directory** | The card's project resolved against the dev-root. Resolution is strict: an unresolvable project never starts a stretch (`strict_project_resolution`). |
| **The brief** | One text: L1 summary, the full card (title, description, acceptance, checklist, attached-file paths), recent handoffs, the findings record, the duty and level, unconsumed user messages, the findings and exit contracts, `handoffPath`, `stretchId`. The brief is the stretch's only instruction. |
| **The concatenated findings** | Composed deterministically from the ledger (`composeFindings`), every anchor rechecked against the tree the stretch will work in. Inside the brief, after the last cache breakpoint. |
| **Duty, model, effort** | The resolved rung of the duty's ladder (pin → forced escalation → tripwire → sticky floor → default). Effort maps to the runtime's own reasoning setting; a runtime without an effort control says so in its adapter, and the router treats the level as coarse. |
| **Tool policy** | The duty's harness profile: a tool allow-list for the runtime's native tools, plus the Garrison MCP server narrowed by `GARRISON_MCP_TOOLS`. |
| **Budget** | The stretch cap (`maxStretches`), the review budget (`review_budget`), and the rung ceiling. A runtime never decides to buy more work; it asks through the handoff and the launcher decides. |
| **The Garrison MCP server** | `mcp-gateway`, one stdio server, mounted like any other MCP server. Env-scoped per stretch: `GARRISON_HTTP_GATEWAY_BASE_URL`, `GARRISON_CONVERSATION_ID`, `GARRISON_STRETCH_CWD`, `GARRISON_MCP_TOOLS`. This is how findings are written and the ledger is read from inside ANY runtime - the tools are not SDK-native and no runtime gets a private variant. |

## The runtime gives back

| What | How |
|---|---|
| **Findings, as they are established** | Appended through `garrison_finding_add` during the stretch - never reconstructed from a transcript afterwards. |
| **Git state, as the diff** | The stretch's changes are whatever `git diff`/`git status` say in the working directory. No side channel: uncommitted tree state IS the change record a review stretch reads. |
| **The next-duty request** | The handoff's `nextSteps.next`, written to `handoffPath` (or a fenced `handoff` block). The launcher's flow policy may overrule it; the runtime never self-schedules. |
| **A transcript into the ledger** | Every chunk/tool event teed into the conversation's `log.jsonl` as it happens. A runtime whose transcript only exists in its own session log must have that log resolvable by the adapter at stretch end. |
| **Usage** | Tokens (in, out, cache read/write) plus provider and account, per API call or per stretch - appended live as `usage` events so a timed-out stretch still leaves behind what it burned. |
| **Exit status** | A process exit and a handoff status Garrison can read without parsing prose. The exit gate validates the handoff; a missing one is synthesized as `failed`. |

## Rules

1. **One stretch per working directory at a time.** Two stretches in one tree
   interleave writes and read each other's half-done state; the launcher's
   conversation lane serializes per conversation, and adapters must not spawn
   parallel work in the same tree.

2. **A runtime that cannot deliver the transcript or the usage fails loudly.**
   No silent degradation to "it ran, trust me": the stretch is marked failed,
   the card goes to Needs input with the reason, and the findings written so
   far are kept. An unobservable run is treated as a failed run.
