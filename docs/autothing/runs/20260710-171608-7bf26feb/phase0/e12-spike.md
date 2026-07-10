All spawned processes are cleaned up. The spike is confirmed on attempt 3.

---

FINDING-E12: AskUserQuestion availability: **CONFIRMED-AVAILABLE** in Claude Code **2.1.206** (`/home/ggomes/.local/bin/claude`). Proven empirically, not from docs: the model invoked the tool and a `PostToolUse` hook with `matcher: "AskUserQuestion"` fired with `tool_name: "AskUserQuestion"`.

FINDING-E12: spike verdict: **CONFIRMED-YES** — a `PostToolUse` hook matching `AskUserQuestion` receives the user's selected answer. The selected label is carried in **`tool_response.answers`**, a map of `{ "<question text>": "<selected option label>" }` — here `{"Pick a letter?": "A"}`. By the time the hook fires the same map is also mirrored into **`tool_input.answers`** (both objects are byte-identical in the payload).

Appendix — trimmed payload (real capture, `posttooluse.jsonl`)

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [{
      "question": "Pick a letter?",
      "header": "Pick a letter",
      "options": [
        {"label": "A", "description": "Letter A"},
        {"label": "B", "description": "Letter B"}
      ],
      "multiSelect": false
    }],
    "answers": { "Pick a letter?": "A" },
    "annotations": {}
  },
  "tool_response": {  /* identical to tool_input, incl. answers: {"Pick a letter?":"A"} */ },
  "tool_use_id": "toolu_01SMHHEphbkV3rhtg6UvJZzf",
  "permission_mode": "bypassPermissions",
  "effort": {"level": "xhigh"},
  "session_id": "1404e99e-...", "transcript_path": "...", "cwd": "...", "duration_ms": 0
}
```

What each part carries:
- **The answer**: `tool_response.answers[<question>]` = selected label (`"A"`). This is the load-bearing field for wiring a flow on the user's choice. `tool_input.answers` duplicates it.
- **The question/options as passed** (`tool_input.questions[]`): `question`, `header`, `options[].{label, description}`, `multiSelect`. Answers are keyed by the `question` string, not `header` (note they can differ — here "Pick a letter?" vs header "Pick a letter"), and the value is the option `label`, not its `description`. `multiSelect: true` would presumably yield an array — untested.

Caveats:
- Control confirmed hooks fire at all: the `UserPromptSubmit` control hook wrote `control.jsonl` on submit.
- Selection was driven by pressing Enter on the focused first option (A) via a timed cadence under a node-pty PTY; the recorded `"A"` confirms that reached the tool. Files: driver `.../scratchpad/e12-spike/driver3.mjs`, settings `.../settings.json`, captured payload `.../posttooluse.jsonl`.
- **Escape / skip / cancel behavior was NOT tested** — unknown whether dismissing the picker yields empty `answers`, omits the key, or suppresses the `PostToolUse` event entirely. Worth a follow-up if the flow needs to distinguish "answered" from "dismissed".
- Attempts 1–2 failed on driver bugs only (trust-dialog wording mismatch; my sentinel words "Pick a letter"/"A"/"B"/"DONE" were present in my own prompt echo that persists in scrollback, poisoning screen-text detection) — nothing to do with AskUserQuestion or hooks. Attempt 3 drove selection blindly and used the hook file as ground truth. Total wall clock ran over the ~10 min guidance due to the two driver iterations; verdict is CONFIRMED, not PLAUSIBLE.
