# codex-cli

Delegate a task to Codex CLI.

Input is a JSON task spec on stdin. Required keys:

- `model`: one of `gpt-5.4`, `gpt-5.5`, `gpt-5.4-mini`
- `prompt`: task prompt

Run `provider.mjs --probe` to verify the wrapper without a provider call.
