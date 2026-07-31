# Detection — how sessions and feedback are found

`discover.mjs` scans `~/.claude/projects/**/*.jsonl` (one file per session) modified within `--hours`. It is a cheap PRE-FILTER; the agent does the real judgement on what it surfaces.

## Two independent streams (never require co-occurrence)
- **Stream A — skill usage:** a `tool_use` block with `name:"Skill"` (→ `input.skill`), or a `<command-name>/<skill></command-name>` marker. Tells you which skills actually ran.
- **Stream B — feedback:** a genuine user-typed message that names a known skill OR contains a correction cue (in a session that also used a skill).

They are separate on purpose: **feedback about a skill routinely lands in a session that never ran it** (a follow-up the next day, a planning chat). Joining them would miss the most common case. A candidate qualifies on EITHER stream.

## The `promptSource` discriminator (this is what kills the noise)
Claude Code injects a lot into the transcript as `role:"user"` messages — skill bodies, command echoes, task-notifications, memory-compiler prompts, continuation summaries. They are NOT the user typing. Distinguishing them:
- **Genuine typed prompt:** has a top-level `promptSource` field, and `isMeta` is absent.
- **Injected skill body:** `isMeta: true`.
- **Command echo / task-notification / compiler prompt:** no `promptSource`.

So Stream B requires `promptSource` present, `isMeta` falsy, content not starting with a `<system-reminder>`/`<task-notification>`/`<command-*>`/`<local-command>` wrapper, and not a `tool_result`.

## Correction cues (broad on purpose)
`flacky/flaky, broken, doesn't work, not working, failing, wrong, should have, missed, did not/didn't, instead of, bug, annoying, confusing, highlight, too slow, hangs, incorrect, not what i, fix the, improve the`. Cued messages count as feedback only in a session that USED a skill (otherwise too noisy). Tune the list in `discover.mjs`.

## Expected false positives (the agent filters these)
- Pasted task **briefs** (long, start with "# Brief"…) — input, not feedback.
- A skill **name** appearing because the user described architecture ("delegates to frontend-design") — a mention, not a critique.
- **Typos** break name-attribution ("walthrough"): the message is still caught by a cue; attribute it to the skill by MEANING + what ran.
Over-capture is the safe failure here. Under-capture (missing real feedback) is the costly one — keep the net wide and filter in judgement.
