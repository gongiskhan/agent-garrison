# gemini-cli

Delegate a task to the Gemini CLI provider wrapper.

Input is a JSON task spec on stdin. Required keys:

- `model`: one of `gemini-2.5-pro`, `gemini-2.5-flash`
- `prompt`: task prompt

Run `provider.mjs --probe` to verify the wrapper without a provider call.
