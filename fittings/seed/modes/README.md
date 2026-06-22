# modes

One operative, three faces, one shared memory. The `modes` fitting fills the
**Modes** faculty and provides the `modes` capability the orchestrator consumes.

- **Gary** — personal assistant (the base face). Daily life, questions, tasks,
  calendar. Prose. Hands technical work to Joe and product thinking to James.
- **Joe** — dev. Talks about code in prose, then dispatches the actual
  implementation to a native Claude Code session (the Dev Env), watches it, and
  reports back. Never a wall of diff.
- **James** — product / architect. Thinks through features and tradeoffs in
  prose, then writes a brief to disk under `briefs_path` and hands it to Joe.

All three share one **voice** (`voice/shared-voice.md`: prose, no
bullets/headers/em-dashes, never opens with flattery, tuned for text-to-speech)
and one **memory**. Switching is by name at the start of a message, sticky, with
channel defaults (`modes.json` `channelDefaults`: dev-env → Joe, Slack → Gary).
Per-mode routing bias nudges the model-router role (Gary leans fast, Joe expert,
James expert then standard).

## Files
- `souls/{gary,joe,james}.md` — each soul's stance, composed on top of the voice.
- `voice/shared-voice.md` — the shared voice block.
- `modes.json` — faculty map, routing bias, channel defaults, switch-log path.
- `references/brief-template.md` — the template James writes briefs from.
- `scripts/setup.mjs` — creates `briefs_path` (idempotent).
- `scripts/verify.mjs` — checks the souls + voice + modes.json are present and
  well-formed; prints `MODES-OK`.

The runner's `assembleSouls` (src/lib/souls.ts) composes, per mode,
`shared-voice + soul + {{capabilities}} + {{routing}}` and hands the result to
the gateway as `GARRISON_SOULS_CONFIG`.
