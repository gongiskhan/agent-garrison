# Codex spike - three gates, recorded

2026-08-31, codex-cli 0.149.0, model gpt-5.6-sol, effort low. Time-boxed to half
a day; used about two hours. Auth mirrors stretch-claude: a Garrison-owned
config dir (`~/.garrison/runtime-homes/codex-spike` for the spike,
`runtime-homes/codex` in production) with `auth.json` symlinked - never copied -
exactly what `codex-runtime/scripts/provision-home.mjs` already enforces and
documents (a copied ChatGPT credential is a rotating-refresh-token race that
revokes the whole family).

## Gate 1 - non-interactive, brief on stdin, readable exit: PASS, one caveat

`codex exec --json -` with the brief piped on stdin, `--cd <dir>`: runs
headless, exits 0, stdout is JSONL carrying `thread.started` (the thread id),
`item.completed` events and one closing `turn.completed` with usage. That is
the whole gate-1 contract.

The caveat is WRITES. Codex's own Linux sandbox is bubblewrap, and on this box
bwrap cannot set up its network namespace (`bwrap: loopback: Operation not
permitted`), so EVERY sandboxed file write fails - `--sandbox workspace-write`
in a trusted git repo included. This is why the committed adapter
(`codex-adapter.mjs codexPermissionArgs`) maps Garrison's headless lane to
`--dangerously-bypass-approvals-and-sandbox`: Garrison owns the execution
policy and Codex's sandbox is structurally unavailable here. The write path is
therefore proven through Garrison's own invocation (step 6's real task), not by
this spike's hand runs.

Honesty note worth keeping: on the FIRST sandboxed run the write was denied
and the model still replied "gate one complete" with the file absent (exit 0).
Later runs reported the failure honestly. A review duty on a second family is
a quality lever, not a luxury.

## Gate 2 - the shared MCP server, one record: PASS

The same `mcp-gateway` stdio server every Claude Code stretch mounts was added
to the spike home's `config.toml` (`[mcp_servers.garrison]`, env-scoped:
`GARRISON_HTTP_GATEWAY_BASE_URL`, `GARRISON_CONVERSATION_ID`,
`GARRISON_MCP_TOOLS`, `GARRISON_STRETCH_CWD`). Two unlocks were required,
found by experiment:

- `mcp_servers.<name>.default_tools_approval_mode = "auto"` (the enum is
  auto | prompt | writes | approve);
- `--approve-for-me` on `codex exec` - headless exec pins the global approval
  policy to `never`, and `never` DENIES any MCP tool that wants approval; the
  flag routes approvals through Codex's automatic reviewer instead.

With both: `garrison_finding_add` called from inside Codex landed in
`~/.garrison/conversations/01M1CGEJSAKT0BEG3PTA0DQ1GG/log.jsonl` - the same
record a Claude Code triage stretch had written 7 findings into minutes
earlier - and `garrison_conversation_fetch` read the digest back. Same server,
same record, no Codex-specific variant. The findings record format did not
change.

## Gate 3 - transcript and usage recoverable, figures match: PASS

The rollout under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`
is located by the `thread.started` id from stdout. For the gate-2 run it held
27 events (the full transcript) and its final `total_token_usage`
(68772 in / 58368 cached / 187 out) matched stdout's `turn.completed` EXACTLY.
The known 2.74x undercount (bench/cost-2026-08-28) applies only when Codex
spawns subagent threads; the adapter's rollout-based accounting already handles
that by grouping the thread tree.

## Verdict

Codex passes all three gates and becomes the second runtime. OpenCode is not
needed. The step-3 adapter must carry gate 2's two unlocks in its invocation
and read usage from the rollout, per the committed `codex-adapter.mjs`.
