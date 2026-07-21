# gemini-api

Delegate a task to a site-specific Gemini API wrapper.

Input is a JSON task spec on stdin. Required keys:

- `model`: one of `gemini-2.5-pro`, `gemini-2.5-flash`
- `prompt`: task prompt

The bundled script is a contract exemplar and fails loudly unless mocked or replaced by a hosted provider wrapper.
