# codex-checkpoint mechanics — superseded pointer

The operational mechanics of the run-level Codex checkpoint moved into
`SKILL.md` when GARRISON-UNIFY-V1 (D14) routed ALL cross-model calls through
the codex-runtime fitting's delegate bridge. The former direct-CLI recipe
(direct CLI invocations, caller-side serialization, ChatGPT-vs-API-key auth
handling) is retired:

- The ONLY path to Codex is `echo '<task_spec_json>' | node
  <codex-runtime>/scripts/bridge.mjs delegate` (task spec via stdin, never
  argv).
- Serialization is enforced INSIDE codex-runtime (a machine-wide lock in the
  bridge); callers never serialize themselves.
- Auth is the bridge's concern (`OPENAI_API_KEY` via the composition env /
  Vault); a quota/auth death returns an error object the caller records as
  `degraded (codex-unavailable)`.

The output schema is unchanged: `assets/codex-checkpoint.schema.json`.
