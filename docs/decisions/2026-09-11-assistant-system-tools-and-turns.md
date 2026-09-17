# Assistant system reads and working turn limits

The operator reported that dialogue could not answer “what are my tasks today”
from Garrison's board and Google Calendar. Its resulting repair card stopped
mid-handoff with `error_max_turns` after eight SDK iterations.

Two separate causes were present. Most working duties advertised only four
Garrison continuity tools; dialogue added card creation but had no board-read or
connector tools. Triage also overrode the selected target's turn budget with
`min(maxTurns, 8)` and stopped after two minutes. Runtime defaults elsewhere
were 12 or 200 turns, with shipped working targets set to 500.

The operator superseded the eight-turn policy on 2026-09-11:

- Working SDK and OpenAI Agents defaults and shipped working targets use 800
  turns. Explicit per-target overrides still apply; tool-free dispatch and
  inference retain their explicit one-turn limit.
- Triage keeps its read-only native inventory and concise intake/handoff
  purpose, but no longer overwrites the target budget or imposes two minutes.
  It uses the ordinary configurable stretch timeout (30 minutes by default).
  Conversation continuation and no-progress checks remain in force.
- Every working SDK/Codex stretch carries board reads, connector discovery and
  read-only connector execution, along with existing continuity tools.
- `garrison_list_cards` pages open tasks; `garrison_get_card` reads details and
  preserves ambiguous references. Links use the shell's relative embed route.
- `garrison_list_connectors` joins the current equipped/connected state to the
  action catalog. `garrison_connector_read` accepts only catalog actions whose
  `mutates` field is explicitly false. It invokes the existing connector CLI
  through the shared scoped-auth helper, never exposing credentials.
- The MCP dispatcher enforces the advertised tool inventory at call time.
  Dialogue guidance requires board plus Calendar for daily-agenda questions,
  with explicit local-day boundaries and honest connection failures.

Generic connector write execution was not added: automatic approval review
rejected that expansion for lack of an explicit external-write authorization
boundary. Existing capabilities such as dialogue card creation remain.

Verification on dev-madrid: the new helpers read the reported card and Google
Calendar returned four events for 2026-09-11 Europe/Lisbon. Regression coverage
includes the actual stdio MCP server, real scoped-auth HTTP plus a fixture CLI,
read-only rejection before credential resolution, and ten successful native SDK
tool iterations followed by a final answer using the production triage default.
No physical phone interaction is inferred from these checks.

Work is on main. The concurrent archive session owns its package, Basic Memory,
composition-config, Improver and related edits; those are preserved. Deployment
must use the existing sequential mesh guards and defer dirty or active nodes.
